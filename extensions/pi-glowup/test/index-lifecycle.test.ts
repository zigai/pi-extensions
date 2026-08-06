import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initTheme,
    ToolExecutionComponent,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlowupGlobalConfigPath } from "../src/config/config.ts";
import glowupExtension from "../src/index.ts";
import { disposeSyntaxHighlighting, isSyntaxHighlightingReady } from "../src/syntax/highlighter.ts";

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

type ToolCallEvent = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: Readonly<Record<string, unknown>>;
};

type ToolCallContext = {
    readonly cwd: string;
    readonly signal?: AbortSignal;
};

type ToolCallHandler = (event: ToolCallEvent, context: ToolCallContext) => unknown;

type ToolResultEvent = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
    readonly details: unknown;
    readonly isError: boolean;
};

type ToolResultHandler = (event: ToolResultEvent, context: ToolCallContext) => unknown;

type TurnHandler = () => Promise<void> | void;

type SessionShutdownEvent = {
    readonly type: "session_shutdown";
    readonly reason: "quit" | "reload";
};

type SessionShutdownHandler = (event: SessionShutdownEvent) => Promise<void> | void;

class FakeExtensionApi {
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

    on(eventName: string, handler: unknown): void {
        if (typeof handler !== "function") {
            throw new Error(`${eventName} handler must be a function`);
        }
        if (eventName === "session_start") {
            this.sessionStartHandlers.push(handler as SessionStartHandler);
            return;
        }
        if (eventName === "tool_call") {
            this.toolCallHandlers.push(handler as ToolCallHandler);
            return;
        }
        if (eventName === "tool_result") {
            this.toolResultHandlers.push(handler as ToolResultHandler);
            return;
        }
        if (eventName === "turn_start") {
            this.turnStartHandlers.push(handler as TurnHandler);
            return;
        }
        if (eventName === "turn_end") {
            this.turnEndHandlers.push(handler as TurnHandler);
            return;
        }
        if (eventName === "session_shutdown") {
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
                        getBranch() {
                            return [];
                        },
                    },
                    isProjectTrusted() {
                        return trusted;
                    },
                },
            );
        }
    }

    runToolCall(event: ToolCallEvent, cwd: string): ReadonlyArray<unknown> {
        return this.toolCallHandlers.map((handler) =>
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

    async runToolResult(event: ToolResultEvent, cwd: string): Promise<unknown[]> {
        const results: unknown[] = [];
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

        await glowupExtension(pi as unknown as ExtensionAPI);

        expect(pi.registeredToolCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(isSyntaxHighlightingReady()).toBe(true);

        await pi.startSession(join(root, "project"), false);

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

        await glowupExtension(pi as unknown as ExtensionAPI);
        await pi.startSession(join(root, "project"), false);

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

        await glowupExtension(pi as unknown as ExtensionAPI);
        await pi.startSession(join(root, "project"), false);
        pi.runBashToolCall("printf hello");
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

        await glowupExtension(pi as unknown as ExtensionAPI);
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

        await glowupExtension(pi as unknown as ExtensionAPI);
        await pi.startSession(join(root, "project"), false);
        await pi.shutdownSession("reload");

        expect(isSyntaxHighlightingReady()).toBe(true);
    });

    it("refreshes retained tool components after TUI syntax startup", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();

        await glowupExtension(pi as unknown as ExtensionAPI);
        await pi.startSession(join(root, "project"), false, "tui");

        expect(pi.toolExpansionRefreshes).toBe(1);
    });

    it("does not block bash tool-call preflight on configured script formatters", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        process.env[SCRIPT_FORMATTERS_ENV] = JSON.stringify({
            python: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
        });
        const pi = new FakeExtensionApi();

        await glowupExtension(pi as unknown as ExtensionAPI);

        expect(pi.runBashToolCall("python - <<'PY'\nprint('hi')\nPY")).toEqual([undefined]);

        await pi.shutdownSession();
    });

    it("renders generic Bash calls before a long-running command completes", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();
        await glowupExtension(pi as unknown as ExtensionAPI);
        initTheme("dark");

        // SAFETY: ToolExecutionComponent only calls requestRender() on this boundary in the
        // exercised lifecycle. The concrete TUI contract is otherwise irrelevant to rendering.
        const tui = { requestRender(): void {} } as unknown as TUI;
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
});

function readLogEvents(filePath: string): string[] {
    return readLogEntries(filePath).flatMap((entry) =>
        typeof entry.event === "string" ? [entry.event] : [],
    );
}

function readLogEntries(filePath: string): Record<string, unknown>[] {
    return readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => {
            const entry: unknown = JSON.parse(line);
            return isRecord(entry) ? [entry] : [];
        });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAnsi(text: string): string {
    return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}
