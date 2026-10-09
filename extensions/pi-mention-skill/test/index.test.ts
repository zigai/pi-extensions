import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";

import { CONFIG_DIR_NAME, type ContextEvent } from "@earendil-works/pi-coding-agent";
import mentionSkillExtension, { type MentionSkillExtensionApi } from "../src/index.ts";
import type { MentionSkillSettingsContext } from "../src/settings.ts";
import type { SkillCommand } from "../src/skill-commands.ts";

type MentionSkillHandlerMap = {
    context: (
        event: ContextEvent,
        ctx: MentionSkillSettingsContext,
    ) => Promise<ContextExpansionResult | undefined>;

    input: (
        event: import("@earendil-works/pi-coding-agent").InputEvent,
        ctx: MentionSkillSettingsContext,
    ) => Promise<import("@earendil-works/pi-coding-agent").InputEventResult>;
};

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(path.join(tmpdir(), "pi-mention-index-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });

    if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

type ContextExpansionResult = {
    readonly messages?: ContextEvent["messages"];
};

function skillCommand(name: string, filePath: string, description = "test skill"): SkillCommand {
    const skillName: `skill:${string}` = `skill:${name}`;

    return {
        source: "skill",
        name: skillName,
        description,
        sourceInfo: {
            path: filePath,
            source: "skill",
            scope: "project",
            origin: "top-level",
            baseDir: path.dirname(filePath),
        },
    };
}

function context(cwd: string): MentionSkillSettingsContext {
    return {
        cwd,
        isProjectTrusted() {
            return true;
        },
    };
}

function isContextHandler(value: unknown): value is MentionSkillHandlerMap["context"] {
    return typeof value === "function";
}

function getContextHandler(
    handlers: ReadonlyMap<string, unknown>,
): MentionSkillHandlerMap["context"] {
    const handler = handlers.get("context");
    if (!isContextHandler(handler)) throw new Error("Expected context handler");
    return handler;
}

type SharedRuntimeContext = {
    readonly cwd: string;
    readonly hasUI: boolean;
    readonly signal: AbortSignal;

    readonly ui: {
        notify(): void;
        readonly theme: { fg(color: string, value: string): string };
    };

    isProjectTrusted(): boolean;
};

type SharedStartHandler = (
    event: { readonly type: "session_start" },
    ctx: SharedRuntimeContext,
) => void | Promise<void>;

function isSharedStartHandler(value: unknown): value is SharedStartHandler {
    return typeof value === "function";
}

async function startSharedRuntime(
    handlers: ReadonlyMap<string, unknown>,
    cwd: string,
): Promise<void> {
    const handler = handlers.get("session_start");
    if (!isSharedStartHandler(handler)) throw new Error("Expected session_start handler");

    await handler(
        { type: "session_start" },
        {
            ...context(cwd),
            hasUI: false,
            signal: new AbortController().signal,
            ui: {
                notify() {},
                theme: {
                    fg(_color: string, value: string) {
                        return value;
                    },
                },
            },
        },
    );
}

test("mention skill skips command enumeration when provider context has no trigger", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-index-cwd-"));
    let getCommandsCount = 0;

    try {
        const registeredHandlers = new Map<string, unknown>();
        const pi: MentionSkillExtensionApi = {
            on(event, handler) {
                registeredHandlers.set(event, handler);

                return () => {};
            },
            getCommands() {
                getCommandsCount += 1;
                return [];
            },
        };
        mentionSkillExtension(pi);
        assert.deepEqual(
            [...registeredHandlers.keys()],
            ["session_start", "input", "context", "session_shutdown"],
        );
        await startSharedRuntime(registeredHandlers, cwd);

        const messages: ContextEvent["messages"] = [
            {
                role: "user",
                content: [{ type: "text", text: "Please use a suitable skill" }],
                timestamp: 1,
            },
        ];

        const result = await getContextHandler(registeredHandlers)(
            { type: "context", messages },
            context(cwd),
        );

        assert.equal(result, undefined);
        assert.equal(getCommandsCount, 0);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("mention skill expands provider context through the shared input observer", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-index-cwd-"));
    const skillPath = path.join(cwd, "python.md");
    try {
        await writeFile(skillPath, "Use Python carefully.\n", "utf8");
        const registeredHandlers = new Map<string, unknown>();
        const pi: MentionSkillExtensionApi = {
            on(event, handler) {
                registeredHandlers.set(event, handler);

                return () => {};
            },
            getCommands() {
                return [skillCommand("python", skillPath)];
            },
        };
        mentionSkillExtension(pi);
        assert.deepEqual(
            [...registeredHandlers.keys()],
            ["session_start", "input", "context", "session_shutdown"],
        );
        await startSharedRuntime(registeredHandlers, cwd);

        const messages: ContextEvent["messages"] = [
            {
                role: "user",
                content: [{ type: "text", text: "Please use $python" }],
                timestamp: 1,
            },
        ];

        const result = await getContextHandler(registeredHandlers)(
            { type: "context", messages },
            context(cwd),
        );

        assert.deepEqual(messages, [
            {
                role: "user",
                content: [{ type: "text", text: "Please use $python" }],
                timestamp: 1,
            },
        ]);
        assert.deepEqual(result?.messages, [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `Please use <skill name="python" location="${skillPath}">\nReferences are relative to ${cwd}.\n\nUse Python carefully.\n</skill>`,
                    },
                ],
                timestamp: 1,
            },
        ]);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("registered skill mentions expand custom triggers without mutating images or re-expanding content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-skill-context-"));
    const skillPath = path.join(cwd, "python.md");
    const handlers = new Map<string, unknown>();
    try {
        await writeFile(skillPath, "---\r\nname: python\r\n---\r\nUse $$python carefully.\n");
        const configDir = path.join(cwd, CONFIG_DIR_NAME, "extension-settings");
        await mkdir(configDir, { recursive: true });
        await writeFile(
            path.join(configDir, "pi-mention-skill.json"),
            JSON.stringify({ trigger: "$$" }),
        );
        mentionSkillExtension({
            on(event, handler) {
                handlers.set(event, handler);

                return () => {};
            },
            getCommands() {
                return [skillCommand("python", skillPath)];
            },
        });
        await startSharedRuntime(handlers, cwd);
        const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;

        const messages: ContextEvent["messages"] = [
            { role: "user", content: "Earlier $$python", timestamp: 1 },
            {
                role: "user",
                content: [
                    image,
                    { type: "text", text: "Now $$python" },
                    { type: "text", text: "Keep $$missing and $python literal" },
                ],
                timestamp: 2,
            },
        ];

        const original = structuredClone(messages);
        const block = `<skill name="python" location="${skillPath}">\nReferences are relative to ${cwd}.\n\nUse $$python carefully.\n</skill>`;
        const handler = getContextHandler(handlers);
        const result = await handler({ type: "context", messages }, context(cwd));

        const expected: ContextEvent["messages"] = [
            { role: "user", content: `Earlier ${block}`, timestamp: 1 },
            {
                role: "user",
                content: [
                    image,
                    { type: "text", text: `Now ${block}` },
                    { type: "text", text: "Keep $$missing and $python literal" },
                ],
                timestamp: 2,
            },
        ];
        assert.deepEqual(result?.messages, expected);
        assert.deepEqual(messages, original);
        assert.deepEqual(await handler({ type: "context", messages }, context(cwd)), result);
        assert.equal(
            await handler({ type: "context", messages: expected }, context(cwd)),
            undefined,
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
