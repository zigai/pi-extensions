import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, ToolExecutionComponent, SessionManager } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { VirtualTerminal } from "../support/virtual-terminal.ts";
import {
    createExtensionContext,
    ExtensionRegistrationFixture,
} from "../support/sdk-extension-fixture.ts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/load.ts";
import glowupExtension from "../../src/index.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
} from "../../src/rendering/syntax/highlighter.ts";

type AssistantSourceMessage = { readonly role: "assistant"; readonly content: readonly ToolCall[] };
type ToolCallInput = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: Record<string, string | readonly { oldText: string; newText: string }[]>;
};
type ToolResultInput = ToolCallInput & {
    readonly content: { type: "text"; text: string }[];
    readonly details: Record<string, string>;
    readonly isError: boolean;
};

function assistantMessage(source: AssistantSourceMessage): AssistantMessage {
    return {
        role: "assistant",
        content: [...source.content],
        api: "openai-completions",
        provider: "openai",
        model: "fixture",
        stopReason: "toolUse",
        timestamp: 0,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
}

class FakeExtensionApi extends ExtensionRegistrationFixture {
    branch: { type: "message"; message: AssistantSourceMessage }[] = [];
    registeredToolCount = 0;
    toolExpansionRefreshes = 0;
    private context = createExtensionContext(process.cwd());

    async startSession(
        cwd: string,
        trusted: boolean,
        mode: "print" | "tui" = "print",
    ): Promise<void> {
        const sessionManager = SessionManager.inMemory(cwd);
        for (const entry of this.branch)
            sessionManager.appendMessage(assistantMessage(entry.message));

        this.context = createExtensionContext(cwd, {
            mode,
            trusted,
            sessionManager,
            setToolsExpanded: () => {
                this.toolExpansionRefreshes += 1;
            },
        });
        for (const registration of this.registrations) {
            if (registration[0] === "session_start") {
                await registration[1]({ type: "session_start", reason: "startup" }, this.context);
            }
        }
    }

    async navigateTree(): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "session_tree") {
                await registration[1](
                    { type: "session_tree", newLeafId: null, oldLeafId: null },
                    this.context,
                );
            }
        }
    }

    async updateAssistant(source: AssistantSourceMessage): Promise<void> {
        const message = assistantMessage(source);
        for (const registration of this.registrations) {
            if (registration[0] === "message_update") {
                await registration[1](
                    {
                        type: "message_update",
                        message,
                        assistantMessageEvent: { type: "start", partial: message },
                    },
                    this.context,
                );
            }
        }
    }

    async startExecution(toolName: string, toolCallId: string): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "tool_execution_start") {
                await registration[1](
                    { type: "tool_execution_start", toolName, toolCallId, args: {} },
                    this.context,
                );
            }
        }
    }

    runToolCall(event: ToolCallInput, cwd: string): Promise<unknown>[] {
        const results: Promise<unknown>[] = [];
        for (const registration of this.registrations) {
            if (registration[0] === "tool_call") {
                // Invoke immediately; synchronous throws retain the async rejection channel.
                const invoke = async () =>
                    registration[1]({ ...event, type: "tool_call" }, createExtensionContext(cwd));
                results.push(invoke());
            }
        }

        return results;
    }

    runBashToolCall(command: string): Promise<unknown>[] {
        return this.runToolCall(
            { toolName: "bash", toolCallId: "call-1", input: { command } },
            process.cwd(),
        );
    }

    async runToolResult(event: ToolResultInput, cwd: string): Promise<unknown[]> {
        const results: unknown[] = [];
        for (const registration of this.registrations) {
            if (registration[0] === "tool_result") {
                results.push(
                    await registration[1](
                        { ...event, type: "tool_result" },
                        createExtensionContext(cwd),
                    ),
                );
            }
        }

        return results;
    }

    async runBashToolResult(command: string, output: string): Promise<void> {
        await this.runToolResult(
            {
                toolName: "bash",
                toolCallId: "call-1",
                input: { command },
                content: [{ type: "text", text: output }],
                details: {},
                isError: false,
            },
            process.cwd(),
        );
    }

    async runTurn(): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "turn_start") {
                await registration[1](
                    { type: "turn_start", turnIndex: 0, timestamp: 0 },
                    this.context,
                );
            }
        }

        for (const registration of this.registrations) {
            if (registration[0] === "turn_end") {
                await registration[1](
                    {
                        type: "turn_end",
                        turnIndex: 0,
                        message: assistantMessage({ role: "assistant", content: [] }),
                        toolResults: [],
                    },
                    this.context,
                );
            }
        }
    }

    async shutdownSession(reason: "quit" | "reload" = "quit"): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "session_shutdown") {
                await registration[1]({ type: "session_shutdown", reason }, this.context);
            }
        }
    }
}

function installGlowup(pi: FakeExtensionApi): void {
    glowupExtension(pi);
}

function createTui(): TuiMainScreen {
    const terminal = new VirtualTerminal(100, 40);
    const tui = new TuiMainScreen(terminal);
    onTestFinished(() => {
        tui.stop();
        terminal.dispose();
    });

    return tui;
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SCRIPT_FORMATTERS_ENV = "PI_GLOWUP_SCRIPT_FORMATTERS";

describe("extension lifecycle", () => {
    it("invokes tool handlers immediately and owns synchronous failures as rejections", async () => {
        const pi = new FakeExtensionApi();
        const observed: string[] = [];
        pi.on("tool_call", () => {
            observed.push("handler");

            throw new Error("fixture handler failure");
        });
        const results = pi.runBashToolCall("true");
        expect(observed).toEqual(["handler"]);
        await expect(Promise.all(results)).rejects.toThrow("fixture handler failure");
    });

    const originalAgentDir = process.env[AGENT_DIR_ENV];
    const originalScriptFormatters = process.env[SCRIPT_FORMATTERS_ENV];

    afterEach(async () => {
        if (originalAgentDir === undefined) {
            delete process.env[AGENT_DIR_ENV];
        } else {
            process.env[AGENT_DIR_ENV] = originalAgentDir;
        }

        if (originalScriptFormatters === undefined) {
            delete process.env[SCRIPT_FORMATTERS_ENV];
        } else {
            process.env[SCRIPT_FORMATTERS_ENV] = originalScriptFormatters;
        }

        vi.useRealTimers();
        await disposeSyntaxHighlighting();
    });

    it("initializes syntax highlighting without diagnostics by default", async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        const agentDir = join(root, "agent");
        process.env[AGENT_DIR_ENV] = agentDir;
        const pi = new FakeExtensionApi();

        installGlowup(pi);

        expect(pi.registeredToolCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(isSyntaxHighlightingReady()).toBe(false);

        await pi.startSession(join(root, "project"), false);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitUntil(() => isSyntaxHighlightingReady());

        expect(vi.getTimerCount()).toBe(0);
        expect(isSyntaxHighlightingReady()).toBe(true);
        expect(existsSync(join(agentDir, "pi-glowup", "debug.log"))).toBe(false);

        await pi.shutdownSession();

        expect(vi.getTimerCount()).toBe(0);
    });

    it("starts diagnostic logging only when explicitly enabled", async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        const agentDir = join(root, "agent");
        process.env[AGENT_DIR_ENV] = agentDir;
        const configPath = getGlowupGlobalConfigPath(agentDir);
        mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ debugLog: { enabled: true } }));
        const pi = new FakeExtensionApi();

        installGlowup(pi);
        await pi.startSession(join(root, "project"), false);
        await vi.advanceTimersByTimeAsync(5_000);
        await initializeSyntaxHighlighting();

        expect(vi.getTimerCount()).toBe(1);
        expect(readLogEvents(join(agentDir, "pi-glowup", "debug.log"))).toEqual(
            expect.arrayContaining(["config_applied", "extension_loaded", "session_start"]),
        );

        await pi.shutdownSession();
    });

    it("records tool and turn diagnostics and disposes syntax on quit", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        const agentDir = join(root, "agent");
        process.env[AGENT_DIR_ENV] = agentDir;
        const configPath = getGlowupGlobalConfigPath(agentDir);
        mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
        writeFileSync(
            configPath,
            JSON.stringify({ debugLog: { enabled: true, memorySampleIntervalMs: 0 } }),
        );
        const pi = new FakeExtensionApi();

        installGlowup(pi);
        await pi.startSession(join(root, "project"), false);
        await Promise.all(pi.runBashToolCall("printf hello"));
        await initializeSyntaxHighlighting();
        await pi.runBashToolResult("printf hello", "hello");
        await pi.runTurn();
        await pi.shutdownSession("quit");

        const entries = readLogEntries(join(agentDir, "pi-glowup", "debug.log"));
        expect(entries.map((entry) => entry.event)).toEqual(
            expect.arrayContaining([
                "tool_call",
                "script_preview_remembered",
                "tool_result",
                "turn_start",
                "turn_end",
                "session_shutdown",
            ]),
        );
        expect(entries.find((entry) => entry.event === "tool_result")).toMatchObject({
            fields: {
                toolName: "bash",
                toolCallId: "call-1",
                outputTextBytes: 5,
                scheduledFormattedPreview: false,
            },
        });
        expect(isSyntaxHighlightingReady()).toBe(false);
    });

    it("captures edit preimages and persists a renderable result diff", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        const agentDir = join(root, "agent");
        const project = join(root, "project");
        const filePath = join(project, "example.ts");
        process.env[AGENT_DIR_ENV] = agentDir;
        mkdirSync(project, { recursive: true });
        writeFileSync(filePath, "export const value = 1;\n");
        const pi = new FakeExtensionApi();

        installGlowup(pi);
        await pi.startSession(project, false);
        await Promise.all(
            pi.runToolCall(
                {
                    toolName: "edit",
                    toolCallId: "edit-call-1",
                    input: {
                        path: "example.ts",
                        edits: [
                            {
                                oldText: "export const value = 1;",
                                newText: "export const value = 2;",
                            },
                        ],
                    },
                },
                project,
            ),
        );
        writeFileSync(filePath, "export const value = 2;\n");

        const results = await pi.runToolResult(
            {
                toolName: "edit",
                toolCallId: "edit-call-1",
                input: {
                    path: "example.ts",
                    edits: [
                        {
                            oldText: "export const value = 1;",
                            newText: "export const value = 2;",
                        },
                    ],
                },
                content: [{ type: "text", text: "Updated example.ts" }],
                details: {
                    diff: "example.ts\n-1 export const value = 1;\n+1 export const value = 2;\n",
                },
                isError: false,
            },
            project,
        );

        expect(results).toHaveLength(1);
        const expectedDiff: unknown = expect.stringContaining("-1 export const value = 1;");
        expect(results[0]).toMatchObject({
            details: {
                diff: expectedDiff,
                pierreDiff: {
                    kind: "renderable",
                    path: "example.ts",
                    stats: { added: 1, removed: 1 },
                },
            },
        });

        await pi.shutdownSession();
    });

    it("keeps syntax ready across reload teardown", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();

        installGlowup(pi);
        await pi.startSession(join(root, "project"), false);
        await Promise.all(pi.runBashToolCall("true"));
        await initializeSyntaxHighlighting();
        await pi.shutdownSession("reload");

        expect(isSyntaxHighlightingReady()).toBe(true);
    });

    it("refreshes retained tool components after TUI syntax startup", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();

        installGlowup(pi);
        await pi.startSession(join(root, "project"), false, "tui");

        expect(pi.toolExpansionRefreshes).toBe(1);
        await Promise.all(pi.runBashToolCall("true"));
        await initializeSyntaxHighlighting();
        await vi.waitFor(() => expect(pi.toolExpansionRefreshes).toBe(2));
    });

    it("does not block bash tool-call preflight on configured script formatters", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        process.env[SCRIPT_FORMATTERS_ENV] = JSON.stringify({
            python: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
        });
        const pi = new FakeExtensionApi();

        installGlowup(pi);

        await expect(
            Promise.all(pi.runBashToolCall("python - <<'PY'\nprint('hi')\nPY")),
        ).resolves.toEqual([undefined]);

        await pi.shutdownSession();
    });

    it("renders generic Bash calls before a long-running command completes", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        initTheme("dark");

        const tui = createTui();
        const command = "cd /tmp && sleep 300";
        const completedArgs = new ToolExecutionComponent(
            "bash",
            "call-complete-args",
            { command },
            undefined,
            undefined,
            tui,
            root,
        );
        const startedExecution = new ToolExecutionComponent(
            "bash",
            "call-started-execution",
            { command },
            undefined,
            undefined,
            tui,
            root,
        );

        expect(completedArgs.render(100)).toEqual([]);
        completedArgs.setArgsComplete();
        expect(stripAnsi(completedArgs.render(100).join("\n"))).toContain(
            "Bash cd /tmp && sleep 300",
        );

        startedExecution.markExecutionStarted();
        expect(stripAnsi(startedExecution.render(100).join("\n"))).toContain(
            "Bash cd /tmp && sleep 300",
        );

        await pi.shutdownSession();
    });

    it.each(["event-first", "row-first", "restored"] as const)(
        "keeps exploration runs separate across 350 preserved boundaries (%s)",
        async (order) => {
            const root = mkdtempSync(join(tmpdir(), "pi-glowup-boundaries-"));
            process.env[AGENT_DIR_ENV] = join(root, "agent");
            const pi = new FakeExtensionApi();
            installGlowup(pi);
            initTheme("dark");
            const calls: AssistantSourceMessage["content"] = [
                { type: "toolCall", id: "before", name: "read", arguments: { path: "before.ts" } },
                ...Array.from({ length: 350 }, (_, index) => ({
                    type: "toolCall" as const,
                    id: `boundary-${index}`,
                    name: "preserved_external",
                    arguments: { path: "unused" },
                })),
                { type: "toolCall", id: "after", name: "read", arguments: { path: "after.ts" } },
                { type: "toolCall", id: "child", name: "read", arguments: { path: "child.ts" } },
                {
                    type: "toolCall",
                    id: "live-boundary",
                    name: "preserved_external",
                    arguments: {},
                },
                { type: "toolCall", id: "next", name: "read", arguments: { path: "next.ts" } },
            ];

            const message: AssistantSourceMessage = { role: "assistant", content: calls };
            if (order === "restored") pi.branch = [{ type: "message", message }];
            await pi.startSession(root, false, "tui");

            if (order !== "restored") await pi.updateAssistant(message);
            const tui = createTui();
            const makeRow = (call: AssistantSourceMessage["content"][number]) =>
                new ToolExecutionComponent(
                    call.name,
                    call.id,
                    call.arguments,
                    undefined,
                    call.name === "preserved_external"
                        ? {
                              renderCall: () => ({
                                  render: () => ["external renderer unchanged"],
                                  invalidate(): void {},
                              }),
                          }
                        : undefined,
                    tui,
                    root,
                );
            const ready = (row: ToolExecutionComponent): void => {
                if (order === "restored") row.updateResult({ content: [], isError: false });
                else row.setArgsComplete();
            };
            const firstCall = calls[0];
            const afterCall = calls[351];
            const childCall = calls[352];
            const liveBoundaryCall = calls[353];
            const nextCall = calls[354];

            if (!firstCall || !afterCall || !childCall || !liveBoundaryCall || !nextCall) {
                throw new Error("missing boundary fixture calls");
            }

            const before = makeRow(firstCall);
            ready(before);
            const boundaryCalls = calls.slice(1, 351);
            const boundaries: ToolExecutionComponent[] = [];
            if (order === "event-first") {
                for (const call of boundaryCalls) await pi.startExecution(call.name, call.id);
            } else {
                for (const call of boundaryCalls) {
                    const row = makeRow(call);
                    ready(row);
                    boundaries.push(row);
                }
            }

            const after = makeRow(afterCall);
            ready(after);
            expect(stripAnsi(after.render(100).join("\n"))).toContain("after.ts");
            expect(stripAnsi(before.render(100).join("\n"))).not.toContain("after.ts");

            // Delay the other side of the handoff beyond the retention limit and
            // until a new owner exists. Include old rows first rendered this late.
            if (order === "event-first") {
                for (const call of boundaryCalls) {
                    const row = makeRow(call);
                    ready(row);
                    boundaries.push(row);
                }
            } else if (order === "row-first") {
                for (const call of boundaryCalls) await pi.startExecution(call.name, call.id);
            }

            for (const row of boundaries) {
                row.setExpanded(true);
                expect(stripAnsi(row.render(100).join("\n"))).toContain(
                    "external renderer unchanged",
                );
            }

            const child = makeRow(childCall);
            ready(child);
            expect(child.render(100)).toEqual([]);
            expect(stripAnsi(after.render(100).join("\n"))).toContain("child.ts");

            // Old-event suppression must never suppress a genuinely new boundary.
            if (order !== "restored")
                await pi.startExecution(liveBoundaryCall.name, liveBoundaryCall.id);

            const liveBoundary = makeRow(liveBoundaryCall);
            ready(liveBoundary);
            const next = makeRow(nextCall);
            ready(next);
            expect(stripAnsi(next.render(100).join("\n"))).toContain("next.ts");
            expect(stripAnsi(after.render(100).join("\n"))).not.toContain("next.ts");
            await pi.shutdownSession();
        },
    );

    it("observes boundaries at source-ordered argument completion, not ahead at construction", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-boundary-ready-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        initTheme("dark");
        await pi.startSession(root, false, "tui");
        const calls: AssistantSourceMessage["content"] = [
            { type: "toolCall", id: "ready-first", name: "read", arguments: { path: "first.ts" } },
            { type: "toolCall", id: "ready-boundary", name: "bash", arguments: { command: "pwd" } },
            { type: "toolCall", id: "ready-last", name: "read", arguments: { path: "last.ts" } },
        ];
        await pi.updateAssistant({ role: "assistant", content: calls });
        const tui = createTui();
        const rows = calls.map(
            (call) =>
                new ToolExecutionComponent(
                    call.name,
                    call.id,
                    call.arguments,
                    undefined,
                    undefined,
                    tui,
                    root,
                ),
        );
        for (const row of rows) row.setArgsComplete();
        const first = rows[0];
        const last = rows[2];
        if (!first || !last) throw new Error("missing readiness fixture rows");
        expect(stripAnsi(first.render(100).join("\n"))).toContain("first.ts");
        expect(stripAnsi(first.render(100).join("\n"))).not.toContain("last.ts");
        expect(stripAnsi(last.render(100).join("\n"))).toContain("last.ts");

        // A tree rebuild has a new row/source lifetime even when call IDs recur.
        await pi.navigateTree();
        await pi.updateAssistant({ role: "assistant", content: calls });
        const rebuilt = calls.map(
            (call) =>
                new ToolExecutionComponent(
                    call.name,
                    call.id,
                    call.arguments,
                    undefined,
                    undefined,
                    tui,
                    root,
                ),
        );
        for (const row of rebuilt) row.setArgsComplete();
        const rebuiltLast = rebuilt[2];
        if (!rebuiltLast) throw new Error("missing rebuilt fixture row");
        expect(stripAnsi(rebuiltLast.render(100).join("\n"))).toContain("last.ts");
        await pi.shutdownSession();
    });
});

const logEntrySchema = Type.Object(
    {
        event: Type.String(),
        fields: Type.Optional(
            Type.Object(
                {
                    toolName: Type.Optional(Type.String()),
                    toolCallId: Type.Optional(Type.String()),
                    outputTextBytes: Type.Optional(Type.Number()),
                    scheduledFormattedPreview: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: true },
            ),
        ),
    },
    { additionalProperties: true },
);

type LogEntry = Static<typeof logEntrySchema>;

function readLogEvents(filePath: string): string[] {
    return readLogEntries(filePath).map((entry) => entry.event);
}

function readLogEntries(filePath: string): LogEntry[] {
    return readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => Value.Parse(logEntrySchema, JSON.parse(line)));
}

function stripAnsi(text: string): string {
    return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}
