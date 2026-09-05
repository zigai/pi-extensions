import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initTheme,
    ToolExecutionComponent,
    type ExtensionAPI,
    type SessionTreeEvent,
    type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlowupGlobalConfigPath } from "../src/config/config.ts";
import glowupExtension from "../src/index.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
} from "../src/syntax/highlighter.ts";

type SessionStartEvent = {
    readonly type: "session_start";
    readonly reason: "startup";
};

type SessionStartContext = {
    readonly cwd: string;
    readonly mode: "print" | "tui";
    readonly ui: {
        getToolsExpanded(): boolean;
        setToolsExpanded(expanded: boolean): void;
    };
    readonly sessionManager: {
        getBranch(): readonly unknown[];
    };
    isProjectTrusted(): boolean;
};

type SessionStartHandler = (
    event: SessionStartEvent,
    context: SessionStartContext,
) => Promise<void> | void;

type ToolInputValue = string | ReadonlyArray<EditOperation>;
type ToolInput = Readonly<Record<string, ToolInputValue>>;

type EditOperation = {
    readonly oldText: string;
    readonly newText: string;
};

type ToolCallEvent = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: ToolInput;
};

type ToolCallContext = {
    readonly cwd: string;
    readonly signal?: AbortSignal;
};

type ToolCallHandler = (
    event: ToolCallEvent,
    context: ToolCallContext,
) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;

type ToolResultEvent = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: ToolInput;
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly details: Readonly<Record<string, string>>;
    readonly isError: boolean;
};

type RenderedToolDetails = {
    readonly diff?: string;
    readonly pierreDiff?: {
        readonly kind: string;
        readonly path: string;
        readonly stats: { readonly added: number; readonly removed: number };
    };
};

type ToolResultHandlerResult = { readonly details?: RenderedToolDetails } | void;

type ToolResultHandler = (
    event: ToolResultEvent,
    context: ToolCallContext,
) => Promise<ToolResultHandlerResult> | ToolResultHandlerResult;

type AssistantSourceMessage = {
    readonly role: "assistant";
    readonly content: ReadonlyArray<{
        readonly type: "toolCall";
        readonly id: string;
        readonly name: string;
        readonly arguments: Readonly<Record<string, string>>;
    }>;
};
type SourceMessageHandler = (event: { readonly message: AssistantSourceMessage }) => void;
type SessionTreeHandler = (
    event: SessionTreeEvent,
    context: Pick<SessionStartContext, "sessionManager">,
) => void;
type ExecutionStartHandler = (event: {
    readonly toolName: string;
    readonly toolCallId: string;
}) => void;

type RegisteredHandler =
    | SourceMessageHandler
    | SessionTreeHandler
    | ExecutionStartHandler
    | SessionStartHandler
    | SessionShutdownHandler
    | ToolCallHandler
    | ToolResultHandler
    | TurnHandler;

type TurnHandler = () => Promise<void> | void;

type SessionShutdownEvent = {
    readonly type: "session_shutdown";
    readonly reason: "quit" | "reload";
};

type SessionShutdownHandler = (event: SessionShutdownEvent) => Promise<void> | void;

class FakeExtensionApi {
    private readonly sourceMessageHandlers: SourceMessageHandler[] = [];
    private readonly sessionTreeHandlers: SessionTreeHandler[] = [];
    private readonly executionStartHandlers: ExecutionStartHandler[] = [];
    branch: readonly unknown[] = [];
    private readonly sessionStartHandlers: SessionStartHandler[] = [];
    private readonly sessionShutdownHandlers: SessionShutdownHandler[] = [];
    private readonly toolCallHandlers: ToolCallHandler[] = [];
    private readonly toolResultHandlers: ToolResultHandler[] = [];
    private readonly turnStartHandlers: TurnHandler[] = [];
    private readonly turnEndHandlers: TurnHandler[] = [];
    registeredToolCount = 0;
    toolExpansionRefreshes = 0;

    registerTool(): void {
        this.registeredToolCount += 1;
    }

    on(eventName: string, handler: RegisteredHandler): void {
        if (eventName === "session_tree") {
            // SAFETY: Tree reset only reads sessionManager.getBranch from its context.
            this.sessionTreeHandlers.push(handler as SessionTreeHandler);
            return;
        }
        if (eventName === "message_update") {
            // SAFETY: This event supplies the assistant source snapshot used by the extension.
            this.sourceMessageHandlers.push(handler as SourceMessageHandler);
            return;
        }
        if (eventName === "tool_execution_start") {
            // SAFETY: These are the fields read by the execution-start handler.
            this.executionStartHandlers.push(handler as ExecutionStartHandler);
            return;
        }
        if (eventName === "session_start") {
            // SAFETY: The extension API overload associates session_start with SessionStartHandler.
            this.sessionStartHandlers.push(handler as SessionStartHandler);
            return;
        }
        if (eventName === "tool_call") {
            // SAFETY: The extension API overload associates tool_call with ToolCallHandler.
            this.toolCallHandlers.push(handler as ToolCallHandler);
            return;
        }
        if (eventName === "tool_result") {
            // SAFETY: The extension API overload associates tool_result with ToolResultHandler.
            this.toolResultHandlers.push(handler as ToolResultHandler);
            return;
        }
        if (eventName === "turn_start") {
            // SAFETY: The extension API overload associates turn_start with TurnHandler.
            this.turnStartHandlers.push(handler as TurnHandler);
            return;
        }
        if (eventName === "turn_end") {
            // SAFETY: The extension API overload associates turn_end with TurnHandler.
            this.turnEndHandlers.push(handler as TurnHandler);
            return;
        }
        if (eventName === "session_shutdown") {
            // SAFETY: The extension API overload associates session_shutdown with SessionShutdownHandler.
            this.sessionShutdownHandlers.push(handler as SessionShutdownHandler);
        }
    }

    async startSession(
        cwd: string,
        trusted: boolean,
        mode: "print" | "tui" = "print",
    ): Promise<void> {
        for (const handler of this.sessionStartHandlers) {
            await handler(
                { type: "session_start", reason: "startup" },
                {
                    cwd,
                    mode,
                    ui: {
                        getToolsExpanded() {
                            return false;
                        },
                        setToolsExpanded: () => {
                            this.toolExpansionRefreshes += 1;
                        },
                    },
                    sessionManager: {
                        getBranch: () => this.branch,
                    },
                    isProjectTrusted() {
                        return trusted;
                    },
                },
            );
        }
    }

    navigateTree(): void {
        for (const handler of this.sessionTreeHandlers) {
            handler(
                { type: "session_tree", newLeafId: null, oldLeafId: null },
                { sessionManager: { getBranch: () => this.branch } },
            );
        }
    }

    updateAssistant(message: AssistantSourceMessage): void {
        for (const handler of this.sourceMessageHandlers) handler({ message });
    }

    startExecution(toolName: string, toolCallId: string): void {
        for (const handler of this.executionStartHandlers) handler({ toolName, toolCallId });
    }

    runToolCall(
        event: ToolCallEvent,
        cwd: string,
    ): ReadonlyArray<Promise<ToolCallEventResult | void>> {
        return this.toolCallHandlers.map(async (handler) =>
            handler(event, {
                cwd,
            }),
        );
    }

    runBashToolCall(command: string): ReadonlyArray<unknown> {
        return this.runToolCall(
            {
                toolName: "bash",
                toolCallId: "call-1",
                input: { command },
            },
            process.cwd(),
        );
    }

    async runToolResult(event: ToolResultEvent, cwd: string): Promise<ToolResultHandlerResult[]> {
        const results: ToolResultHandlerResult[] = [];
        for (const handler of this.toolResultHandlers) {
            results.push(await handler(event, { cwd }));
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
        for (const handler of this.turnStartHandlers) {
            await handler();
        }
        for (const handler of this.turnEndHandlers) {
            await handler();
        }
    }

    async shutdownSession(reason: SessionShutdownEvent["reason"] = "quit"): Promise<void> {
        for (const handler of this.sessionShutdownHandlers) {
            await handler({ type: "session_shutdown", reason });
        }
    }
}

function installGlowup(pi: FakeExtensionApi): void {
    // SAFETY: FakeExtensionApi retains exactly the lifecycle handlers registered by glowupExtension;
    // its invocation methods supply the matching concrete event and context contracts.
    const on = pi.on.bind(pi) as ExtensionAPI["on"];
    glowupExtension({ on });
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SCRIPT_FORMATTERS_ENV = "PI_GLOWUP_SCRIPT_FORMATTERS";

describe("extension lifecycle", () => {
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
        pi.runBashToolCall("printf hello");
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
        expect(results[0]).toMatchObject({
            details: {
                diff: expect.stringContaining("-1 export const value = 1;"),
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
        pi.runBashToolCall("true");
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
        pi.runBashToolCall("true");
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

        // SAFETY: ToolExecutionComponent only calls requestRender() on this boundary in the
        // exercised lifecycle. The concrete TUI contract is otherwise irrelevant to rendering.
        const tuiBoundary = { requestRender(): void {} };
        // SAFETY: ToolExecutionComponent only calls requestRender() on this boundary in the
        // exercised lifecycle. The concrete TUI contract is otherwise irrelevant to rendering.
        const tui = tuiBoundary as TUI;
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
            if (order !== "restored") pi.updateAssistant(message);
            // SAFETY: The real Pi component only requires requestRender at this test boundary.
            const tui = { requestRender(): void {} } as TUI;
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
                for (const call of boundaryCalls) pi.startExecution(call.name, call.id);
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
                for (const call of boundaryCalls) pi.startExecution(call.name, call.id);
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
            if (order !== "restored") pi.startExecution(liveBoundaryCall.name, liveBoundaryCall.id);
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
        pi.updateAssistant({ role: "assistant", content: calls });
        // SAFETY: This is the requestRender-only boundary used by Pi's real row.
        const tui = { requestRender(): void {} } as TUI;
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
        pi.navigateTree();
        pi.updateAssistant({ role: "assistant", content: calls });
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
