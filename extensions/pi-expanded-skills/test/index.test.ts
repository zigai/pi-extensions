import { mkdtemp, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
    formatSkillsForPrompt,
    type BeforeProviderRequestEvent,
    type BeforeAgentStartEvent,
    type ContextEvent,
    type InputEvent,
    type InputEventResult,
    type SlashCommandInfo,
    type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import extension, {
    extensionName,
    internals,
    packageName,
    parseOpenAiAllowImplicitInvocation,
    renderSkillContent,
    type SkillExtensionAPI,
    type SkillExtensionContext,
    type SkillExtensionEventHandlers,
} from "../src/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

const defaultSkillExtensionContext: SkillExtensionContext = {
    hasUI: true,
    ui: {
        addAutocompleteProvider: () => undefined,
        notify: () => undefined,
    },
    cwd: process.cwd(),
    sessionManager: {
        getSessionId: () => "test-session",
        getSessionFile: () => join(process.cwd(), "test-session.jsonl"),
    },
    model: { provider: "test-provider", id: "test-model" },
};

describe("extension entrypoint", () => {
    it("exports generated package metadata", () => {
        expect(packageName).toBe("pi-enhanced-skills");
        expect(extensionName).toBe("Pi Enhanced Skills");
        expect(typeof extension).toBe("function");
    });

    it("registers enhanced skill hooks", () => {
        const { pi, events } = createExtensionHarness([]);

        expect(extension(pi)).toBeUndefined();
        expect(events).toEqual([
            "before_agent_start",
            "input",
            "tool_result",
            "agent_start",
            "context",
            "before_provider_request",
            "session_start",
        ]);
    });
});

describe("OpenAI sidecar metadata", () => {
    it("reads only policy.allow_implicit_invocation", () => {
        expect(
            parseOpenAiAllowImplicitInvocation(
                `interface:\n  display_name: Ignored\npolicy:\n  allow_implicit_invocation: false\n`,
            ),
        ).toBe(false);
        expect(
            parseOpenAiAllowImplicitInvocation("policy:\n  allow_implicit_invocation: true\n"),
        ).toBe(true);
        expect(
            parseOpenAiAllowImplicitInvocation("interface:\n  display_name: Only UI\n"),
        ).toBeUndefined();
    });

    it("removes allow_implicit_invocation:false skills from the model prompt", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: codex-only\ndescription: Explicit-only Codex skill",
            body: "# Codex only",
            openAiPolicy: false,
        });
        const skill = {
            name: "codex-only",
            description: "Explicit-only Codex skill",
            filePath: skillPath,
            baseDir: dirname(skillPath),
            sourceInfo: makeSourceInfo(skillPath),
            disableModelInvocation: false,
        };
        const { pi, handlers } = createExtensionHarness([]);
        extension(pi);

        const systemPrompt = `prefix${formatSkillsForPrompt([skill])}suffix`;
        const result = await handlers.beforeAgentStart({
            type: "before_agent_start",
            prompt: "hello",
            systemPrompt,
            systemPromptOptions: {
                cwd: process.cwd(),
                skills: [skill],
                selectedTools: [],
                toolSnippets: {},
                toolGuidelines: {},
                promptGuidelines: [],
                appendSystemPrompt: "",
                sections: {},
                contextFiles: [],
            },
        });

        expect(result?.systemPrompt).toBe("prefixsuffix");
    });

    it("removes deleted skills from the model prompt", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: deleted\ndescription: Deleted skill",
            body: "# Deleted",
        });
        const skill = {
            name: "deleted",
            description: "Deleted skill",
            filePath: skillPath,
            baseDir: dirname(skillPath),
            sourceInfo: makeSourceInfo(skillPath),
            disableModelInvocation: false,
        };
        await unlink(skillPath);

        const { pi, handlers } = createExtensionHarness([]);
        extension(pi);

        const systemPrompt = `prefix${formatSkillsForPrompt([skill])}suffix`;
        const result = await handlers.beforeAgentStart({
            type: "before_agent_start",
            prompt: "hello",
            systemPrompt,
            systemPromptOptions: {
                cwd: process.cwd(),
                skills: [skill],
                selectedTools: [],
                toolSnippets: {},
                toolGuidelines: {},
                promptGuidelines: [],
                appendSystemPrompt: "",
                sections: {},
                contextFiles: [],
            },
        });

        expect(result?.systemPrompt).toBe("prefixsuffix");
    });
});

describe("dynamic command injection", () => {
    it("renders inline and fenced commands once with bounded shell output", async () => {
        const calls: string[] = [];
        const rendered = await renderSkillContent(
            ["Before !`echo inline`", "```!", "echo fenced", "```", "After"].join("\n"),
            "/skill/root",
            async (command, shell, cwd) => {
                calls.push(`${shell}:${cwd}:${command}`);
                return {
                    stdout: command === "echo inline" ? "INLINE\n" : "FENCED\n",
                    stderr: "",
                    code: 0,
                    killed: false,
                };
            },
        );

        expect(rendered).toBe(["Before INLINE", "FENCED", "After"].join("\n"));
        expect(calls).toEqual(["bash:/skill/root:echo fenced", "bash:/skill/root:echo inline"]);
    });

    it("does not recursively execute injected output", async () => {
        const rendered = await renderSkillContent("!`echo nested`", "/skill/root", async () => ({
            stdout: "!`echo should-not-run`\n",
            stderr: "",
            code: 0,
            killed: false,
        }));

        expect(rendered).toBe("!`echo should-not-run`");
    });

    it("injects command output into full SKILL.md read results", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: dynamic\ndescription: Dynamic context skill",
            body: "Current branch: !`git branch --show-current`",
        });
        const { store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("dynamic", skillPath)], {
            stdout: "main\n",
        });
        extension(pi, { skillUsageStore: store });

        const result = await handlers.toolResult({
            type: "tool_result",
            toolCallId: "read-1",
            toolName: "read",
            input: { path: skillPath },
            content: [{ type: "text", text: "Current branch: !`git branch --show-current`" }],
            isError: false,
            details: undefined,
        });

        expect(result?.content).toEqual([{ type: "text", text: "Current branch: main" }]);
    });
});

describe("skill usage tracking", () => {
    it("uses a central state path instead of the extension config folder", () => {
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-test";
        try {
            expect(internals.defaultSkillUsageLogPath()).toBe(
                "/tmp/pi-agent-test/state/pi-enhanced-skills/skill-usage.jsonl",
            );
        } finally {
            if (previousAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
        }
    });

    it("persists successful agent reads of SKILL.md with session and model metadata", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: tracked\ndescription: Tracked skill",
            body: "# Tracked",
        });
        const { records, store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("tracked", skillPath)]);
        extension(pi, { skillUsageStore: store });

        await handlers.toolResult(
            {
                type: "tool_result",
                toolCallId: "read-1",
                toolName: "read",
                input: { path: skillPath },
                content: [{ type: "text", text: "# Tracked" }],
                isError: false,
                details: undefined,
            },
            makeContext(vi.fn(), {
                cwd: dirname(skillPath),
                sessionId: "session-123",
                sessionFile: "/tmp/session-123.jsonl",
                model: { provider: "anthropic", id: "claude-sonnet" },
            }),
        );

        const [record] = records;
        if (!isRecord(record) || typeof record.timestamp !== "string") {
            throw new Error("Expected a skill usage record with an ISO timestamp.");
        }
        expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(records).toEqual([
            expect.objectContaining({
                schemaVersion: 1,
                event: "agent_read",
                sessionId: "session-123",
                sessionFile: "/tmp/session-123.jsonl",
                model: { provider: "anthropic", id: "claude-sonnet" },
                projectFolder: dirname(skillPath),
                skillName: "tracked",
                skillPath,
                skillBaseDir: dirname(skillPath),
                filePath: skillPath,
                relativePath: "SKILL.md",
                fileRole: "main",
                commandSource: {
                    source: "local",
                    scope: "user",
                    origin: "top-level",
                },
                read: { toolCallId: "read-1" },
            }),
        ]);
    });

    it("persists referenced skill subfile reads with read window metadata", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: referenced\ndescription: References a topic",
            body: "Read [topic](TOPIC.md) for details.",
        });
        const topicPath = join(dirname(skillPath), "TOPIC.md");
        await writeFile(topicPath, "# Topic\n", "utf-8");
        const { records, store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([
            makeSkillCommand("referenced", skillPath),
        ]);
        extension(pi, { skillUsageStore: store });

        await handlers.toolResult(
            {
                type: "tool_result",
                toolCallId: "read-topic",
                toolName: "read",
                input: { path: "TOPIC.md", offset: 2, limit: 5 },
                content: [{ type: "text", text: "Topic" }],
                isError: false,
                details: undefined,
            },
            makeContext(vi.fn(), { cwd: dirname(skillPath) }),
        );

        expect(records).toEqual([
            expect.objectContaining({
                event: "agent_read",
                skillName: "referenced",
                filePath: topicPath,
                relativePath: "TOPIC.md",
                fileRole: "referenced",
                read: { toolCallId: "read-topic", offset: 2, limit: 5 },
            }),
        ]);
    });

    it("persists direct user skill invocations without storing raw arguments", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: visible\ndescription: Visible skill",
            body: "# Visible",
        });
        const { records, store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("visible", skillPath)]);
        extension(pi, { skillUsageStore: store });

        await handlers.input(
            {
                type: "input",
                text: "/skill:visible secret request text",
                source: "interactive",
            },
            makeContext(vi.fn(), { cwd: dirname(skillPath), sessionId: "session-user" }),
        );

        expect(records[0]).not.toHaveProperty("args");
        expect(records[0]).toEqual(
            expect.objectContaining({
                event: "user_invocation",
                sessionId: "session-user",
                skillName: "visible",
                filePath: skillPath,
                fileRole: "main",
                invocation: { inputSource: "interactive", hasArguments: true },
            }),
        );
    });

    it("persists skill mentions expanded into context blocks", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: python\ndescription: Python skill",
            body: "Use Python carefully.",
        });
        const { records, store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("python", skillPath)]);
        extension(pi, { skillUsageStore: store });

        await handlers.context(
            {
                type: "context",
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `<skill name="python" location="${skillPath}">\nUse Python carefully.\n</skill>\n\nPlease use python`,
                            },
                        ],
                        timestamp: 1,
                    },
                ],
            },
            makeContext(vi.fn(), { cwd: dirname(skillPath), sessionId: "session-mention" }),
        );

        expect(records).toEqual([
            expect.objectContaining({
                event: "mention_expansion",
                sessionId: "session-mention",
                skillName: "python",
                filePath: skillPath,
                fileRole: "main",
                mention: { source: "context" },
            }),
        ]);
    });

    it("persists skill mentions from provider payload when context hook order misses them", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: review\ndescription: Review skill",
            body: "Review carefully.",
        });
        const { records, store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("review", skillPath)]);
        extension(pi, { skillUsageStore: store });

        await handlers.beforeProviderRequest(
            {
                type: "before_provider_request",
                payload: {
                    messages: [
                        {
                            role: "user",
                            content: `<skill name="review" location="${skillPath}">\nReview carefully.\n</skill>\n\nPlease use review`,
                        },
                    ],
                },
            },
            makeContext(vi.fn(), { cwd: dirname(skillPath), sessionId: "session-provider" }),
        );

        expect(records).toEqual([
            expect.objectContaining({
                event: "mention_expansion",
                sessionId: "session-provider",
                skillName: "review",
                filePath: skillPath,
                mention: { source: "provider_payload" },
            }),
        ]);
    });
});

describe("user invocable metadata", () => {
    it("blocks direct /skill invocation when user-invocable is false", async () => {
        const skillPath = await writeSkill({
            frontmatter:
                "name: hidden\ndescription: Hidden background skill\nuser-invocable: false",
            body: "# Hidden",
        });
        const notify = vi.fn();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("hidden", skillPath)]);
        extension(pi);

        const result = await handlers.input(
            {
                type: "input",
                text: "/skill:hidden",
                source: "interactive",
            },
            makeContext(notify),
        );

        expect(result).toEqual({ action: "handled" });
        expect(notify).toHaveBeenCalledWith('Skill "hidden" is not user-invocable.', "warning");
    });

    it("handles direct invocation of a deleted skill", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: deleted\ndescription: Deleted skill",
            body: "# Deleted",
        });
        await unlink(skillPath);

        const notify = vi.fn();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("deleted", skillPath)]);
        extension(pi);

        const result = await handlers.input(
            {
                type: "input",
                text: "/skill:deleted",
                source: "interactive",
            },
            makeContext(notify),
        );

        expect(result).toEqual({ action: "handled" });
        expect(notify).toHaveBeenCalledWith('Skill "deleted" is no longer available.', "warning");
    });

    it("expands visible skill invocations with dynamic context", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: visible\ndescription: Visible skill",
            body: "Data: !`printf ok`",
        });
        const { store } = makeRecordingSkillUsageStore();
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("visible", skillPath)], {
            stdout: "ok\n",
        });
        extension(pi, { skillUsageStore: store });

        const result = await handlers.input(
            {
                type: "input",
                text: "/skill:visible extra args",
                source: "interactive",
            },
            makeContext(vi.fn()),
        );

        expect(result).toEqual({
            action: "transform",
            text: "---\nname: visible\ndescription: Visible skill\n---\n\nData: ok\n\nUser: extra args",
        });
    });

    it("filters hidden and deleted skills from slash autocomplete suggestions", async () => {
        const hiddenPath = await writeSkill({
            frontmatter: "name: hidden\ndescription: Hidden skill\nuser-invocable: false",
            body: "# Hidden",
        });
        const visiblePath = await writeSkill({
            frontmatter: "name: visible\ndescription: Visible skill",
            body: "# Visible",
        });
        const deletedPath = await writeSkill({
            frontmatter: "name: deleted\ndescription: Deleted skill",
            body: "# Deleted",
        });
        await unlink(deletedPath);
        const suggestions = await internals.filterUserInvocableSuggestions(
            {
                prefix: "/skill:",
                items: [
                    { value: "/skill:hidden", label: "/skill:hidden" },
                    { value: "/skill:visible", label: "/skill:visible" },
                    { value: "/skill:deleted", label: "/skill:deleted" },
                ],
            },
            [
                makeSkillCommand("hidden", hiddenPath),
                makeSkillCommand("visible", visiblePath),
                makeSkillCommand("deleted", deletedPath),
            ],
        );

        expect(suggestions.items).toEqual([{ value: "/skill:visible", label: "/skill:visible" }]);
    });
});

async function writeSkill(options: {
    readonly frontmatter: string;
    readonly body: string;
    readonly openAiPolicy?: boolean;
}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-enhanced-skills-"));
    const skillPath = join(dir, "SKILL.md");
    await writeFile(skillPath, `---\n${options.frontmatter}\n---\n\n${options.body}`, "utf-8");
    if (options.openAiPolicy !== undefined) {
        const agentsDir = join(dir, "agents");
        await mkdir(agentsDir);
        await writeFile(
            join(agentsDir, "openai.yaml"),
            `policy:\n  allow_implicit_invocation: ${options.openAiPolicy ? "true" : "false"}\n`,
            "utf-8",
        );
    }
    return skillPath;
}

function requireHandler<THandler>(handler: THandler | undefined): THandler {
    if (handler === undefined) {
        throw new Error("Expected extension handler to be registered.");
    }
    return handler;
}

function createExtensionHarness(
    commands: SlashCommandInfo[],
    execResult?: {
        readonly stdout: string;
        readonly stderr?: string;
        readonly code?: number;
        readonly killed?: boolean;
    },
): {
    readonly pi: SkillExtensionAPI;
    readonly events: string[];
    readonly handlers: {
        readonly agentStart: () => Promise<void>;
        readonly beforeProviderRequest: (
            event: BeforeProviderRequestEvent,
            ctx?: SkillExtensionContext,
        ) => Promise<unknown>;
        readonly beforeAgentStart: (
            event: BeforeAgentStartEvent,
        ) => Promise<{ readonly systemPrompt?: string } | void>;
        readonly context: (
            event: ContextEvent,
            ctx?: SkillExtensionContext,
        ) => Promise<{ readonly messages?: ContextEvent["messages"] } | void>;
        readonly input: (
            event: InputEvent,
            ctx: SkillExtensionContext,
        ) => Promise<InputEventResult | void>;
        readonly toolResult: (
            event: ToolResultEvent,
            ctx?: SkillExtensionContext,
        ) => Promise<{
            readonly content?: ToolResultEvent["content"];
            readonly details?: unknown;
            readonly isError?: boolean;
        } | void>;
    };
} {
    const events: string[] = [];
    const capturedHandlers: Partial<SkillExtensionEventHandlers> = {};
    const pi: SkillExtensionAPI = {
        on(eventName, handler) {
            events.push(eventName);
            capturedHandlers[eventName] = handler;
        },
        getCommands: () => commands,
        exec: async () => ({
            stdout: execResult?.stdout ?? "",
            stderr: execResult?.stderr ?? "",
            code: execResult?.code ?? 0,
            killed: execResult?.killed ?? false,
        }),
    };

    return {
        pi,
        events,
        handlers: {
            agentStart: async () => {
                await requireHandler(capturedHandlers.agent_start)(
                    { type: "agent_start" },
                    defaultSkillExtensionContext,
                );
            },
            beforeProviderRequest: async (event, ctx = makeContext(vi.fn())) => {
                return requireHandler(capturedHandlers.before_provider_request)(event, ctx);
            },
            beforeAgentStart: async (event) => {
                return requireHandler(capturedHandlers.before_agent_start)(
                    event,
                    defaultSkillExtensionContext,
                );
            },
            context: async (event, ctx = makeContext(vi.fn())) => {
                return requireHandler(capturedHandlers.context)(event, ctx);
            },
            input: async (event, ctx) => {
                return requireHandler(capturedHandlers.input)(event, ctx);
            },
            toolResult: async (event, ctx = makeContext(vi.fn())) => {
                return requireHandler(capturedHandlers.tool_result)(event, ctx);
            },
        },
    };
}

function makeSkillCommand(name: string, skillPath: string): SlashCommandInfo {
    return {
        name: `skill:${name}`,
        source: "skill",
        sourceInfo: makeSourceInfo(skillPath),
        description: `${name} skill`,
    };
}

function makeSourceInfo(skillPath: string): SlashCommandInfo["sourceInfo"] {
    return {
        path: skillPath,
        source: "local",
        scope: "user",
        origin: "top-level",
        baseDir: dirname(skillPath),
    };
}

function makeRecordingSkillUsageStore(): {
    readonly records: unknown[];
    readonly store: { readonly record: (record: unknown) => Promise<void> };
} {
    const records: unknown[] = [];
    return {
        records,
        store: {
            record: async (record) => {
                records.push(record);
            },
        },
    };
}

function makeContext(
    notify: (message: string, type?: "info" | "warning" | "error") => void,
    options?: {
        readonly cwd?: string;
        readonly sessionId?: string;
        readonly sessionFile?: string;
        readonly model?: { readonly provider: string; readonly id: string };
    },
): SkillExtensionContext {
    const cwd = options?.cwd ?? process.cwd();
    const sessionId = options?.sessionId ?? "test-session";
    const sessionFile = options?.sessionFile ?? join(cwd, "test-session.jsonl");
    return {
        hasUI: true,
        ui: {
            addAutocompleteProvider: () => undefined,
            notify,
        },
        cwd,
        sessionManager: {
            getSessionId: () => sessionId,
            getSessionFile: () => sessionFile,
        },
        model: options?.model ?? { provider: "test-provider", id: "test-model" },
    };
}
