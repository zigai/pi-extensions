import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionContext,
    InputEvent,
    InputEventResult,
    SlashCommandInfo,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import extension, {
    extensionName,
    internals,
    packageName,
    parseOpenAiAllowImplicitInvocation,
    renderSkillContent,
} from "../src/index.ts";

type RegisteredHandlers = {
    readonly beforeAgentStart: (
        event: BeforeAgentStartEvent,
    ) => Promise<{ readonly systemPrompt?: string } | void>;
    readonly input: (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | void>;
    readonly toolResult: (
        event: ToolResultEvent,
    ) => Promise<{ readonly content?: ToolResultEvent["content"] } | void>;
};

describe("extension entrypoint", () => {
    it("exports generated package metadata", () => {
        expect(packageName).toBe("pi-expanded-skills");
        expect(extensionName).toBe("Pi Expanded Skills");
        expect(typeof extension).toBe("function");
    });

    it("registers expanded skill hooks", () => {
        const { pi, events } = createExtensionHarness([]);

        expect(extension(pi)).toBeUndefined();
        expect(events).toEqual(["before_agent_start", "input", "tool_result", "session_start"]);
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
            },
        } as BeforeAgentStartEvent);

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
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("dynamic", skillPath)], {
            stdout: "main\n",
        });
        extension(pi);

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

    it("expands visible skill invocations with dynamic context", async () => {
        const skillPath = await writeSkill({
            frontmatter: "name: visible\ndescription: Visible skill",
            body: "Data: !`printf ok`",
        });
        const { pi, handlers } = createExtensionHarness([makeSkillCommand("visible", skillPath)], {
            stdout: "ok\n",
        });
        extension(pi);

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

    it("filters hidden skills from slash autocomplete suggestions", async () => {
        const hiddenPath = await writeSkill({
            frontmatter: "name: hidden\ndescription: Hidden skill\nuser-invocable: false",
            body: "# Hidden",
        });
        const visiblePath = await writeSkill({
            frontmatter: "name: visible\ndescription: Visible skill",
            body: "# Visible",
        });

        const suggestions = await internals.filterUserInvocableSuggestions(
            {
                prefix: "/skill:",
                items: [
                    { value: "/skill:hidden", label: "/skill:hidden" },
                    { value: "/skill:visible", label: "/skill:visible" },
                ],
            },
            [makeSkillCommand("hidden", hiddenPath), makeSkillCommand("visible", visiblePath)],
        );

        expect(suggestions.items).toEqual([{ value: "/skill:visible", label: "/skill:visible" }]);
    });
});

async function writeSkill(options: {
    readonly frontmatter: string;
    readonly body: string;
    readonly openAiPolicy?: boolean;
}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-expanded-skills-"));
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

function createExtensionHarness(
    commands: readonly SlashCommandInfo[],
    execResult?: {
        readonly stdout: string;
        readonly stderr?: string;
        readonly code?: number;
        readonly killed?: boolean;
    },
): { readonly pi: ExtensionAPI; readonly events: string[]; readonly handlers: RegisteredHandlers } {
    const events: string[] = [];
    const capturedHandlers = new Map<string, unknown>();
    const pi = {
        on: (eventName: string, handler: unknown) => {
            events.push(eventName);
            capturedHandlers.set(eventName, handler);
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
        // SAFETY: Tests provide the ExtensionAPI members exercised by this extension.
        pi: pi as unknown as ExtensionAPI,
        events,
        handlers: {
            beforeAgentStart: async (event) => {
                const handler = capturedHandlers.get(
                    "before_agent_start",
                ) as RegisteredHandlers["beforeAgentStart"];
                return handler(event);
            },
            input: async (event, ctx) => {
                const handler = capturedHandlers.get("input") as RegisteredHandlers["input"];
                return handler(event, ctx);
            },
            toolResult: async (event) => {
                const handler = capturedHandlers.get(
                    "tool_result",
                ) as RegisteredHandlers["toolResult"];
                return handler(event);
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

function makeContext(notify: (message: string, type: "warning") => void): ExtensionContext {
    return {
        hasUI: true,
        ui: {
            notify,
        },
        cwd: process.cwd(),
    } as ExtensionContext;
}
