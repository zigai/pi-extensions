import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexLookExtension from "../src/index.ts";
import { disposeSyntaxHighlighting, isSyntaxHighlightingReady } from "../src/syntax/highlighter.ts";

type SessionStartEvent = {
    readonly type: "session_start";
    readonly reason: "startup";
};

type SessionStartContext = {
    readonly cwd: string;
    isProjectTrusted(): boolean;
};

type SessionStartHandler = (
    event: SessionStartEvent,
    context: SessionStartContext,
) => Promise<void> | void;

type ToolCallEvent = {
    readonly toolName: "bash";
    readonly toolCallId: string;
    readonly input: {
        readonly command: string;
    };
};

type ToolCallContext = {
    readonly signal?: AbortSignal;
};

type ToolCallHandler = (event: ToolCallEvent, context: ToolCallContext) => Promise<void> | void;

class FakeExtensionApi {
    private readonly sessionStartHandlers: SessionStartHandler[] = [];
    private readonly toolCallHandlers: ToolCallHandler[] = [];
    registeredToolCount = 0;

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
        }
    }

    async startSession(cwd: string, trusted: boolean): Promise<void> {
        for (const handler of this.sessionStartHandlers) {
            await handler(
                { type: "session_start", reason: "startup" },
                {
                    cwd,
                    isProjectTrusted() {
                        return trusted;
                    },
                },
            );
        }
    }

    runBashToolCall(command: string): ReadonlyArray<Promise<void> | void> {
        return this.toolCallHandlers.map((handler) =>
            handler(
                {
                    toolName: "bash",
                    toolCallId: "call-1",
                    input: { command },
                },
                {},
            ),
        );
    }
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SCRIPT_FORMATTERS_ENV = "PI_CODEX_LOOK_SCRIPT_FORMATTERS";

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

    it("initializes syntax highlighting at session start without timers", async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(join(tmpdir(), "pi-codex-look-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();

        await codexLookExtension(pi as unknown as ExtensionAPI);

        expect(pi.registeredToolCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);

        await pi.startSession(join(root, "project"), false);

        expect(vi.getTimerCount()).toBe(0);
        expect(isSyntaxHighlightingReady()).toBe(true);
    });

    it("does not block bash tool-call preflight on configured script formatters", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-codex-look-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        process.env[SCRIPT_FORMATTERS_ENV] = JSON.stringify({
            python: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
        });
        const pi = new FakeExtensionApi();

        await codexLookExtension(pi as unknown as ExtensionAPI);

        expect(pi.runBashToolCall("python - <<'PY'\nprint('hi')\nPY")).toEqual([undefined]);
    });
});
