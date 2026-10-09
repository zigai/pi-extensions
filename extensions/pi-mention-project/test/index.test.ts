import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, test } from "vitest";

import { CONFIG_DIR_NAME, type ContextEvent } from "@earendil-works/pi-coding-agent";

import { registerProjectMentionExtension, type ProjectMentionExtensionApi } from "../src/index.ts";
import type { MentionProjectSettingsContext } from "../src/settings.ts";

type ProjectMentionHandlerMap = {
    context: (
        event: ContextEvent,
        ctx: MentionProjectSettingsContext,
    ) => Promise<ContextExpansionResult | undefined>;

    input: (
        event: import("@earendil-works/pi-coding-agent").InputEvent,
        ctx: MentionProjectSettingsContext,
    ) => Promise<import("@earendil-works/pi-coding-agent").InputEventResult>;
};

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(path.join(tmpdir(), "pi-mention-project-index-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(async () => {
    await rm(agentDir, { recursive: true, force: true });

    if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
    } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
});

function context(cwd: string): MentionProjectSettingsContext {
    return {
        cwd,
        isProjectTrusted() {
            return true;
        },
    };
}

type ContextExpansionResult = {
    readonly messages?: ContextEvent["messages"];
};

function isInputHandler(value: unknown): value is ProjectMentionHandlerMap["input"] {
    return typeof value === "function";
}

function isContextHandler(value: unknown): value is ProjectMentionHandlerMap["context"] {
    return typeof value === "function";
}

function getInputHandler(
    handlers: ReadonlyMap<string, unknown>,
): ProjectMentionHandlerMap["input"] {
    const handler = handlers.get("input");
    if (!isInputHandler(handler)) throw new Error("Expected input handler");
    return handler;
}

function getContextHandler(
    handlers: ReadonlyMap<string, unknown>,
): ProjectMentionHandlerMap["context"] {
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

test("mention project preserves submitted prompts and expands provider context", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-index-cwd-"));
    const registeredHandlers = new Map<string, unknown>();

    try {
        await mkdir(path.join(cwd, "pi-tweaks", ".git"), { recursive: true });
        const configDir = path.join(cwd, CONFIG_DIR_NAME, "extension-settings");
        await mkdir(configDir, { recursive: true });
        await writeFile(
            path.join(configDir, "pi-mention-project.json"),
            JSON.stringify({ roots: ["."], gitReposOnly: true }),
            "utf8",
        );

        const pi: ProjectMentionExtensionApi = {
            registerFlag() {},
            getFlag() {
                return false;
            },
            on(event, handler) {
                registeredHandlers.set(event, handler);

                return () => {};
            },
        };

        registerProjectMentionExtension(pi);

        assert.deepEqual(
            [...registeredHandlers.keys()],
            ["session_start", "input", "context", "session_shutdown"],
        );
        await startSharedRuntime(registeredHandlers, cwd);
        const inputResult = await getInputHandler(registeredHandlers)(
            {
                type: "input",
                text: "Please inspect #pi-tweaks",
                source: "interactive",
            },
            context(cwd),
        );
        assert.deepEqual(inputResult, { action: "continue" });

        const messages: ContextEvent["messages"] = [
            {
                role: "user",
                content: [{ type: "text", text: "Please inspect #pi-tweaks" }],
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
                content: [{ type: "text", text: "Please inspect #pi-tweaks" }],
                timestamp: 1,
            },
        ]);
        assert.deepEqual(result?.messages, [
            {
                role: "user",
                content: [{ type: "text", text: `Please inspect ${path.join(cwd, "pi-tweaks")}` }],
                timestamp: 1,
            },
        ]);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("registered project mentions preserve queued input and expand multiple context blocks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-mention-project-context-"));
    const handlers = new Map<string, unknown>();
    try {
        await mkdir(path.join(cwd, "work api", ".git"), { recursive: true });
        await mkdir(path.join(cwd, "skills", ".git"), { recursive: true });
        const configDir = path.join(cwd, CONFIG_DIR_NAME, "extension-settings");
        await mkdir(configDir, { recursive: true });
        await writeFile(
            path.join(configDir, "pi-mention-project.json"),
            JSON.stringify({ roots: ["."], trigger: "##" }),
        );
        registerProjectMentionExtension({
            registerFlag() {},
            getFlag() {
                return false;
            },
            on(event, handler) {
                handlers.set(event, handler);

                return () => {};
            },
        });
        await startSharedRuntime(handlers, cwd);
        const input = getInputHandler(handlers);
        for (const streamingBehavior of ["followUp", "steer"] as const) {
            assert.deepEqual(
                await input(
                    {
                        type: "input",
                        source: "interactive",
                        streamingBehavior,
                        text: 'Compare ##"work api" with ##skills',
                    },
                    context(cwd),
                ),
                { action: "continue" },
            );
        }

        const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" } as const;

        const messages: ContextEvent["messages"] = [
            { role: "user", content: 'Earlier ##"work api"', timestamp: 1 },
            {
                role: "user",
                content: [
                    image,
                    { type: "text", text: "Now ##skills" },
                    { type: "text", text: "Keep ##missing and #skills literal" },
                ],
                timestamp: 2,
            },
        ];

        const original = structuredClone(messages);
        const handler = getContextHandler(handlers);
        const result = await handler({ type: "context", messages }, context(cwd));
        assert.deepEqual(result?.messages, [
            { role: "user", content: `Earlier ${path.join(cwd, "work api")}`, timestamp: 1 },
            {
                role: "user",
                content: [
                    image,
                    { type: "text", text: `Now ${path.join(cwd, "skills")}` },
                    { type: "text", text: "Keep ##missing and #skills literal" },
                ],
                timestamp: 2,
            },
        ]);
        assert.deepEqual(messages, original);
        assert.deepEqual(await handler({ type: "context", messages }, context(cwd)), result);
        const plain: ContextEvent["messages"] = [
            { role: "user", content: "No mention here", timestamp: 3 },
        ];
        assert.equal(await handler({ type: "context", messages: plain }, context(cwd)), undefined);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
