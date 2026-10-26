import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import {
    createEditTool,
    createReadToolDefinition,
    initTheme,
    ToolExecutionComponent,
    SessionManager,
    type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { VirtualTerminal } from "../support/virtual-terminal.ts";
import { createPlainTheme } from "../support/plain-theme.ts";
import { renderGlowupOutput } from "../../src/rendering/output.ts";
import {
    createExtensionContext,
    ExtensionRegistrationFixture,
} from "../support/sdk-extension-fixture.ts";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/load.ts";
import glowupExtension from "../../src/index.ts";
import { registerGlowupToolRenderer } from "../../src/presentation.ts";
import { output } from "../../src/tools/protocol/contract.ts";
import {
    disposeSyntaxHighlighting,
    highlightSyntaxCodeAsync,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
} from "../../src/rendering/syntax/highlighter.ts";
import { getScriptFormatterWorkload } from "../../src/tools/built-in/bash/formatter.ts";

type AssistantSourceMessage = { readonly role: "assistant"; readonly content: readonly ToolCall[] };
type ToolCallInput = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly input: Record<string, string | readonly { oldText: string; newText: string }[]>;
};
type ToolResultInput = ToolCallInput & Pick<ToolResultEvent, "content" | "details" | "isError">;

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

    async startAssistant(source: AssistantSourceMessage): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "message_start") {
                await registration[1](
                    { type: "message_start", message: assistantMessage(source) },
                    this.context,
                );
            }
        }
    }

    async endAssistant(
        source: AssistantSourceMessage,
        stopReason: AssistantMessage["stopReason"] = "toolUse",
    ): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "message_end") {
                await registration[1](
                    { type: "message_end", message: { ...assistantMessage(source), stopReason } },
                    this.context,
                );
            }
        }
    }

    async endAgent(): Promise<void> {
        for (const registration of this.registrations) {
            if (registration[0] === "agent_end") {
                await registration[1]({ type: "agent_end", messages: [] }, this.context);
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

    async runTurn(outcome: "completed" | "aborted" = "completed"): Promise<void> {
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
                        messageEntryId: "message-1",
                        toolResults: [],
                        toolResultEntryIds: [],
                        entries: [],
                        continue: false,
                        context: {
                            contextEntries: [],
                            contextMessages: [],
                            llmMessages: [],
                            pendingMessages: [],
                            canContinue: false,
                        },
                        outcome,
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
    it.each(["import", "registration"])("keeps settings unchanged during %s", async (phase) => {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-registration-contract-"));
        onTestFinished(async () => {
            await rm(root, { recursive: true, force: true });
        });

        const agentDir = join(root, "agent");
        const legacyDirectory = join(agentDir, "pi-glowup");
        await mkdir(legacyDirectory, { recursive: true });
        await writeFile(join(legacyDirectory, "config.json"), "{}\n");
        const child = spawnSync(
            process.execPath,
            [
                "--import",
                new URL("../pty/fixtures/no-network.js", import.meta.url).href,
                "--import",
                import.meta.resolve("tsx"),
                fileURLToPath(new URL("./fixtures/register-without-session.ts", import.meta.url)),
                phase,
            ],
            {
                cwd: root,
                env: {
                    PATH: process.env.PATH ?? "/usr/bin:/bin",
                    HOME: root,
                    PI_CODING_AGENT_DIR: agentDir,
                    PI_OFFLINE: "1",
                    PI_SKIP_VERSION_CHECK: "1",
                },
                encoding: "utf8",
                timeout: 10_000,
                killSignal: "SIGKILL",
                maxBuffer: 256 * 1024,
            },
        );

        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status).toBe(0);
        expect(child.stdout).toContain("completed without settings writes");
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

        expect(isSyntaxHighlightingReady()).toBe(false);

        await pi.startSession(join(root, "project"), false);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitUntil(() => isSyntaxHighlightingReady());

        expect(isSyntaxHighlightingReady()).toBe(true);
        expect(existsSync(join(agentDir, "pi-glowup", "debug.log"))).toBe(false);

        await pi.shutdownSession();
        expect(isSyntaxHighlightingReady()).toBe(false);
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

        expect(readLogEvents(join(agentDir, "pi-glowup", "debug.log"))).toEqual(
            expect.arrayContaining(["config_applied", "extension_loaded", "session_start"]),
        );

        await pi.shutdownSession();
    });

    it("writes render diagnostics only when debugLog itself is enabled", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-render-diagnostics-"));
        const agentDir = join(root, "agent");
        const log = join(agentDir, "pi-glowup", "debug.log");
        const marker = join(root, "formatter-ran");
        const originalRetainedLog = process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG;
        process.env[AGENT_DIR_ENV] = agentDir;
        process.env[SCRIPT_FORMATTERS_ENV] = JSON.stringify({
            python: {
                kind: "command",
                command: [
                    process.execPath,
                    "-e",
                    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x");process.stdin.pipe(process.stdout)`,
                ],
            },
        });
        onTestFinished(async () => {
            if (originalRetainedLog === undefined) delete process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG;
            else process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG = originalRetainedLog;

            await rm(root, { recursive: true, force: true });
        });
        const command = "python - <<'PY'\nprint('hi')\nPY";
        const renderEvents = (): Static<typeof renderLogEntrySchema>[] =>
            readFileSync(log, "utf8")
                .trim()
                .split("\n")
                .map((line) => Value.Parse(renderLogEntrySchema, JSON.parse(line)))
                .filter((entry) =>
                    [
                        "script_analysis",
                        "script_format",
                        "syntax_highlight",
                        "render_error",
                    ].includes(entry.event),
                );

        // Retained-output telemetry activates the logger without enabling debugLog.
        process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG = "1";
        const quiet = new FakeExtensionApi();
        installGlowup(quiet);
        await quiet.startSession(join(root, "project"), false);
        await Promise.all(quiet.runBashToolCall(command));
        await vi.waitUntil(() => existsSync(marker), { timeout: 10_000 });
        await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await quiet.shutdownSession();
        expect(readLogEvents(log)).toContain("session_start");
        expect(renderEvents()).toEqual([]);

        delete process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG;
        await rm(log);
        const configPath = getGlowupGlobalConfigPath(agentDir);
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(
            configPath,
            JSON.stringify({ debugLog: { enabled: true, memorySampleIntervalMs: 0 } }),
        );
        const verbose = new FakeExtensionApi();
        installGlowup(verbose);
        try {
            await verbose.startSession(join(root, "project"), false);
            await Promise.all(verbose.runBashToolCall(command));
            await vi.waitUntil(
                () => renderEvents().some((entry) => entry.event === "script_analysis"),
                { timeout: 10_000 },
            );
        } finally {
            await verbose.shutdownSession();
        }

        const analysis = renderEvents().find((entry) => entry.event === "script_analysis");
        expect(analysis?.fields).toMatchObject({
            toolName: "bash",
            toolCallId: "call-1",
            path: "standalone",
            standalone: { language: "python" },
            segments: [{ language: "python", origin: "standalone", formattable: true }],
        });
        const codeHash = analysis?.fields.segments?.[0]?.codeHash;
        const format = renderEvents().find(
            (entry) => entry.event === "script_format" && entry.fields.codeHash === codeHash,
        );
        expect(format?.fields).toMatchObject({
            toolCallId: "call-1",
            stage: "preview",
            outcome: "unchanged",
        });
    });

    it("sends opt-in retained-output telemetry to the debug file instead of the terminal", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-retained-diagnostics-"));
        const agentDir = join(root, "agent");
        const originalRetainedLog = process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG;
        process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG = "1";
        process.env[AGENT_DIR_ENV] = agentDir;
        onTestFinished(async () => {
            if (originalRetainedLog === undefined) delete process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG;
            else process.env.PI_GLOWUP_RETAINED_OUTPUT_LOG = originalRetainedLog;

            await rm(root, { recursive: true, force: true });
        });
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        try {
            await pi.startSession(join(root, "project"), false, "tui");
            renderGlowupOutput(createPlainTheme(), "SENSITIVE_OUTPUT", { expanded: false }).render(
                40,
            );
            await Promise.resolve();
            const log = join(agentDir, "pi-glowup", "debug.log");
            expect(readLogEvents(log)).toContain("retained_output");
            expect(readFileSync(log, "utf8")).not.toContain("SENSITIVE_OUTPUT");
        } finally {
            await pi.shutdownSession();
        }
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
                    patch: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
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

    it("persists each native edit independently when both preflights precede execution", async () => {
        const root = await mkdtemp(join(import.meta.dirname, ".parallel-edit-"));
        onTestFinished(async () => rm(root, { recursive: true, force: true }));
        const project = join(root, "project");
        await mkdir(project);
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        await writeFile(join(project, "sample.txt"), "item0=0\nitem1=0\n");
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        onTestFinished(async () => pi.shutdownSession());
        await pi.startSession(project, false);
        const first = {
            toolName: "edit",
            toolCallId: "first-edit",
            input: { path: "sample.txt", edits: [{ oldText: "item0=0", newText: "item0=1" }] },
        };
        const second = {
            toolName: "edit",
            toolCallId: "second-edit",
            input: { path: "sample.txt", edits: [{ oldText: "item1=0", newText: "item1=1" }] },
        };
        await Promise.all(pi.runToolCall(first, project));
        await Promise.all(pi.runToolCall(second, project));

        const tool = createEditTool(project);

        const operations = [
            {
                call: first,
                deletionLines: ["item0=0\n", "item1=0\n"],
                additionLines: ["item0=1\n", "item1=0\n"],
            },
            {
                call: second,
                deletionLines: ["item0=1\n", "item1=0\n"],
                additionLines: ["item0=1\n", "item1=1\n"],
            },
        ];
        for (const { call, deletionLines, additionLines } of operations) {
            const result = await tool.execute(call.toolCallId, call.input);
            const persisted = await pi.runToolResult(
                {
                    ...call,
                    ...result,
                    isError: false,
                },
                project,
            );
            expect(persisted).toHaveLength(1);
            expect(persisted[0]).toMatchObject({
                details: {
                    pierreDiff: {
                        kind: "renderable",
                        stats: { added: 1, removed: 1 },
                        metadata: { deletionLines, additionLines },
                    },
                },
            });
        }

        expect(readFileSync(join(project, "sample.txt"), "utf8")).toBe("item0=1\nitem1=1\n");
    });

    it("releases syntax workers on reload and highlights again in the next session", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const workers: Worker[] = [];
        const observeWorker = (worker: Worker): void => {
            workers.push(worker);
        };
        process.on("worker", observeWorker);
        onTestFinished(async () => {
            process.off("worker", observeWorker);
            await Promise.all(workers.map(async (worker) => worker.terminate()));
            await rm(root, { recursive: true, force: true });
        });
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        onTestFinished(async () => pi.shutdownSession());
        const code = "const total = 3;";

        await pi.startSession(join(root, "project"), false);
        await Promise.all(pi.runBashToolCall("true"));
        await vi.waitUntil(() => isSyntaxHighlightingReady());
        const beforeReload = await highlightSyntaxCodeAsync(code, "typescript");
        expect(beforeReload.map(stripAnsi)).toEqual([code]);
        expect(beforeReload).not.toEqual([code]);
        expect(workers).toHaveLength(1);
        expect(workers[0]?.threadId).toBeGreaterThan(0);

        await pi.shutdownSession("reload");

        expect(workers[0]?.threadId).toBe(-1);
        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(await highlightSyntaxCodeAsync(code, "typescript")).toEqual([code]);

        const nextPi = new FakeExtensionApi();
        installGlowup(nextPi);
        onTestFinished(async () => nextPi.shutdownSession());
        await nextPi.startSession(join(root, "project"), false);
        await Promise.all(nextPi.runBashToolCall("true"));
        await vi.waitUntil(() => isSyntaxHighlightingReady());

        expect(await highlightSyntaxCodeAsync(code, "typescript")).toEqual(beforeReload);
        expect(workers).toHaveLength(2);
        expect(workers[0]?.threadId).toBe(-1);
        expect(workers[1]?.threadId).toBeGreaterThan(0);

        await nextPi.shutdownSession("reload");
        expect(workers[1]?.threadId).toBe(-1);
    });

    it("refreshes retained tool components after TUI syntax startup", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();

        installGlowup(pi);
        await pi.startSession(join(root, "project"), false, "tui");

        initTheme("dark");
        const row = new ToolExecutionComponent(
            "write",
            "syntax",
            { path: "sample.ts", content: "const total = 3;" },
            undefined,
            undefined,
            createTui(),
            root,
        );
        row.setArgsComplete();
        const before = row.render(80).join("\n");
        expect(stripAnsi(before)).toContain("const total = 3;");
        await initializeSyntaxHighlighting();
        await vi.waitFor(() => expect(row.render(80).join("\n")).not.toBe(before));
        expect(stripAnsi(row.render(80).join("\n"))).toContain("const total = 3;");
    });

    async function argumentSession(presentation = "compact") {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-arguments-"));
        const agentDir = join(root, "agent");
        process.env[AGENT_DIR_ENV] = agentDir;
        process.env[SCRIPT_FORMATTERS_ENV] = "{}";
        const settingsPath = getGlowupGlobalConfigPath(agentDir);
        await mkdir(dirname(settingsPath), { recursive: true });
        await writeFile(
            settingsPath,
            JSON.stringify({ presentation, streaming: { prose: "token", code: "block" } }),
        );
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        initTheme("dark");
        await pi.startSession(root, false, "tui");
        onTestFinished(async () => {
            await pi.shutdownSession();
            await rm(root, { recursive: true, force: true });
        });
        const row = (id: string, command: string) =>
            new ToolExecutionComponent(
                "bash",
                id,
                { command },
                undefined,
                undefined,
                createTui(),
                root,
            );
        return { pi, root, row };
    }

    function bashMessage(id: string, command: string): AssistantSourceMessage {
        return {
            role: "assistant",
            content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
        };
    }

    it.each(["compact", "outline"])(
        "renders resultless history while another call streams in %s",
        async (presentation) => {
            const { pi, row } = await argumentSession(presentation);
            await pi.startAssistant(bashMessage("live", "printf held"));
            const live = row("live", "printf held");
            const historical = row("historical", "printf restored");
            const screen = (tool: ToolExecutionComponent, width = 80) =>
                stripAnsi(tool.render(width).join("\n"));
            expect(screen(live)).not.toContain("held");
            await vi.waitFor(() => expect(screen(historical)).toContain("printf restored"));
            await pi.updateAssistant(bashMessage("live", "printf held_tail"));
            live.updateArgs({ command: "printf held_tail" });
            live.setExpanded(true);
            for (const width of [80, 45, 100])
                expect(screen(live, width)).not.toContain("held_tail");
            await pi.endAssistant(bashMessage("live", "printf held_tail"));
            await vi.waitFor(() => expect(screen(live)).toContain("printf held_tail"));
        },
    );

    it.each(["aborted", "error", "turn", "agent"])(
        "releases resultless arguments after %s without a host completion update",
        async (ending) => {
            const { pi, row } = await argumentSession();
            const source = bashMessage("interrupted", "printf interrupted_tail");
            await pi.startAssistant(source);
            const interrupted = row("interrupted", "printf interrupted_tail");
            const screen = () => stripAnsi(interrupted.render(80).join("\n"));
            expect(screen()).not.toContain("interrupted_tail");
            if (ending === "turn") await pi.runTurn("aborted");
            else if (ending === "agent") await pi.endAgent();
            else if (ending === "aborted") await pi.endAssistant(source, "aborted");
            else await pi.endAssistant(source, "error");
            await vi.waitFor(() => expect(screen()).toContain("printf interrupted_tail"));
        },
    );

    it("does not complete a new stream from a previous agent's deferred repaint", async () => {
        const { pi, row } = await argumentSession();
        await pi.startAssistant(bashMessage("previous", "printf previous"));
        const previous = row("previous", "printf previous");
        previous.render(80);
        const ending = pi.endAgent();
        await pi.startAssistant(bashMessage("next", "printf next_tail"));
        const next = row("next", "printf next_tail");
        const screen = () => stripAnsi(next.render(80).join("\n"));
        expect(screen()).not.toContain("next_tail");
        await ending;
        next.invalidate();
        expect(screen()).not.toContain("next_tail");
        await pi.endAssistant(bashMessage("next", "printf next_tail"));
        await vi.waitFor(() => expect(screen()).toContain("printf next_tail"));
    });

    it.each(["resume", "reload", "tree"])(
        "clears unfinished argument ownership on %s",
        async (reset) => {
            const { pi, row, root } = await argumentSession();
            await pi.startAssistant(bashMessage("retained", "printf retained_tail"));
            const live = row("retained", "printf retained_tail");
            expect(stripAnsi(live.render(80).join("\n"))).not.toContain("retained_tail");
            if (reset === "tree") {
                await pi.navigateTree();
                await vi.waitFor(() =>
                    expect(stripAnsi(live.render(80).join("\n"))).toContain("printf retained_tail"),
                );
            } else {
                if (reset === "reload") await pi.shutdownSession("reload");
                await pi.startSession(root, false, "tui");
                const restored = row("retained", "printf retained_tail");
                await vi.waitFor(() =>
                    expect(stripAnsi(restored.render(80).join("\n"))).toContain(
                        "printf retained_tail",
                    ),
                );
            }
        },
    );

    it.each(["compact", "outline"])(
        "applies configured statement formatting while write arguments are streaming in %s",
        async (presentation) => {
            const cache = join(import.meta.dirname, "../../.cache");
            await mkdir(cache, { recursive: true });
            const root = await mkdtemp(join(cache, "streaming-session-"));
            const agentDir = join(root, "agent");
            process.env[AGENT_DIR_ENV] = agentDir;
            delete process.env[SCRIPT_FORMATTERS_ENV];
            const settingsPath = getGlowupGlobalConfigPath(agentDir);
            await mkdir(dirname(settingsPath), { recursive: true });
            await writeFile(
                settingsPath,
                JSON.stringify({
                    presentation,
                    streaming: { prose: "sentence", code: "statement" },
                    scriptPreview: {
                        formatters: {
                            javascript: {
                                kind: "javascript",
                                command: [
                                    join(
                                        dirname(
                                            createRequire(import.meta.url).resolve(
                                                "oxfmt/package.json",
                                            ),
                                        ),
                                        "bin",
                                        "oxfmt",
                                    ),
                                ],
                            },
                        },
                    },
                }),
            );
            const pi = new FakeExtensionApi();
            installGlowup(pi);
            initTheme("dark");
            try {
                await pi.startSession(root, false, "tui");
                await pi.updateAssistant({
                    role: "assistant",
                    content: [
                        {
                            type: "toolCall",
                            id: "streamed-write",
                            name: "write",
                            arguments: {
                                path: "example.js",
                                content: "const first={value:1};\nconst second =",
                            },
                        },
                    ],
                });
                const row = new ToolExecutionComponent(
                    "write",
                    "streamed-write",
                    {
                        path: "example.js",
                        content: "const first={value:1};\nconst second =",
                    },
                    undefined,
                    undefined,
                    createTui(),
                    root,
                );
                const screen = () => stripAnsi(row.render(100).join("\n"));
                expect(screen()).not.toContain("const second");
                await vi.waitFor(() => expect(screen()).toContain("const first = { value: 1 };"));
                expect(screen()).not.toContain("const second");
                row.updateArgs({
                    path: "example.js",
                    content: "const first={value:1};\nconst second={value:2};",
                });
                row.setArgsComplete();
                row.setExpanded(true);
                await vi.waitFor(() => expect(screen()).toContain("const second = { value: 2 };"));
                expect(screen()).toContain("const first = { value: 1 };");
                row.updateResult({ content: [{ type: "text", text: "cancelled" }], isError: true });
                expect(screen()).toContain("const first = { value: 1 };");
                expect(screen()).toContain("const second = { value: 2 };");
            } finally {
                await pi.shutdownSession();
                await rm(root, { recursive: true, force: true });
            }
        },
    );

    it("does not block bash tool-call preflight on configured script formatters", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        process.env[SCRIPT_FORMATTERS_ENV] = JSON.stringify({
            python: {
                kind: "command",
                command: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
            },
        });
        const pi = new FakeExtensionApi();

        installGlowup(pi);

        await expect(
            Promise.all(pi.runBashToolCall("python - <<'PY'\nprint('hi')\nPY")),
        ).resolves.toEqual([undefined]);

        await pi.shutdownSession();
    });

    it("renders native history on the first frame after activation", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-native-history-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        onTestFinished(async () => rm(root, { recursive: true, force: true }));
        initTheme("dark");
        const row = new ToolExecutionComponent(
            "read",
            "history-read",
            { path: "sample.ts" },
            undefined,
            createReadToolDefinition(root),
            createTui(),
            root,
        );
        row.updateResult({
            content: [{ type: "text", text: "const sample = 1;" }],
            isError: false,
        });
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        try {
            await pi.startSession(root, false, "tui");

            expect(stripAnsi(row.render(100).join("\n"))).toContain("sample.ts");
        } finally {
            await pi.shutdownSession();
        }
    });

    it("preserves native image read output when images are hidden", async () => {
        const root = await mkdtemp(join(tmpdir(), "pi-glowup-image-fallback-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        onTestFinished(async () => rm(root, { recursive: true, force: true }));
        initTheme("dark");
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        try {
            await pi.startSession(root, false, "tui");
            const row = new ToolExecutionComponent(
                "read",
                "image-read",
                { path: "sample.png" },
                { showImages: false },
                createReadToolDefinition(root),
                createTui(),
                root,
            );
            row.updateResult({
                content: [
                    { type: "text", text: "Read image file [image/png]" },
                    { type: "image", mimeType: "image/png", data: "" },
                ],
                isError: false,
            });
            row.setExpanded(true);

            expect(stripAnsi(row.render(100).join("\n"))).toContain("Read image file [image/png]");
        } finally {
            await pi.shutdownSession();
        }
    });

    it("formats a restored Node call in the transcript", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-restored-node-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        process.env[SCRIPT_FORMATTERS_ENV] = JSON.stringify({
            javascript: {
                kind: "javascript",
                command: [
                    join(
                        dirname(createRequire(import.meta.url).resolve("oxfmt/package.json")),
                        "bin",
                        "oxfmt",
                    ),
                ],
            },
        });
        const command = `node -e 'const item = "RESTORED_NODE"; console.log(item)'`;
        const call = {
            type: "toolCall" as const,
            id: "restored-node",
            name: "bash",
            arguments: { command },
        };
        const pi = new FakeExtensionApi();
        pi.branch = [{ type: "message", message: { role: "assistant", content: [call] } }];
        installGlowup(pi);
        initTheme("dark");

        await pi.startSession(root, false, "tui");
        const row = new ToolExecutionComponent(
            call.name,
            call.id,
            call.arguments,
            undefined,
            undefined,
            createTui(),
            root,
        );
        row.updateResult({ content: [], isError: false });
        await vi.waitFor(() => {
            const rendered = stripAnsi(row.render(100).join("\n"));
            expect(rendered).toContain("$ node -e\n  const item");
            expect(rendered).toContain("\n  console.log(item)");
        });
        await pi.shutdownSession();
    });

    it("restores structured schema results through the actual host tool component", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-schema-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        initTheme("dark");
        await pi.startSession(root, false, "tui");
        const definition = {
            name: "inventory",
            label: "Inventory",
            description: "Inventory result",
            parameters: Type.Object({ folder: Type.String() }),
            outputSchema: Type.Object({ count: Type.Number({ title: "Count" }) }),
            execute: async () => {
                throw new Error("Restored results do not execute tools");
            },
        };
        const row = new ToolExecutionComponent(
            "inventory",
            "schema",
            { folder: "samples" },
            undefined,
            definition,
            createTui(),
            root,
        );
        const result = {
            content: [{ type: "text" as const, text: "Text fallback" }],
            structuredContent: { count: 2 },
            isError: false,
        };
        row.updateResult(result);
        const rendered = stripAnsi(row.render(80).join("\n"));
        expect(rendered).toContain("Count → 2");
        expect(rendered).not.toContain("Text fallback");
        const registration = registerGlowupToolRenderer(
            "inventory-view",
            (name) => name === "inventory",
            {
                version: 3,
                parseArgs: (value) => value,
                parseResult: (value) => value,
                renderResult: () => output("Contribution result"),
            },
        );
        try {
            expect(stripAnsi(row.render(80).join("\n"))).toContain("Contribution result");
            registration.dispose();
            expect(stripAnsi(row.render(80).join("\n"))).toContain("Count → 2");
        } finally {
            registration.dispose();
            await pi.shutdownSession();
        }
    });

    it("renders generic Bash calls before a long-running command completes", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();
        installGlowup(pi);
        initTheme("dark");

        const tui = createTui();
        await pi.startSession(root, false, "tui");
        const command = "cd /tmp && sleep 300";
        await pi.updateAssistant({
            role: "assistant",
            content: [
                {
                    type: "toolCall",
                    id: "call-complete-args",
                    name: "bash",
                    arguments: { command },
                },
                {
                    type: "toolCall",
                    id: "call-started-execution",
                    name: "bash",
                    arguments: { command },
                },
            ],
        });
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
        expect(stripAnsi(completedArgs.render(100).join("\n"))).toContain("$ cd /tmp && sleep 300");

        startedExecution.markExecutionStarted();
        expect(stripAnsi(startedExecution.render(100).join("\n"))).toContain(
            "$ cd /tmp && sleep 300",
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

const renderLogEntrySchema = Type.Object({
    event: Type.String(),
    fields: Type.Object(
        {
            toolCallId: Type.Optional(Type.String()),
            stage: Type.Optional(Type.String()),
            codeHash: Type.Optional(Type.String()),
            outcome: Type.Optional(Type.String()),
            segments: Type.Optional(
                Type.Array(
                    Type.Object({ codeHash: Type.String() }, { additionalProperties: true }),
                ),
            ),
        },
        { additionalProperties: true },
    ),
});

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
