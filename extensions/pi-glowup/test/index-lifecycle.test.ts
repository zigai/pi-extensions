import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexLookExtension from "../src/index.ts";

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

class FakeExtensionApi {
    private readonly sessionStartHandlers: SessionStartHandler[] = [];
    registeredToolCount = 0;

    registerTool(): void {
        this.registeredToolCount += 1;
    }

    on(eventName: string, handler: unknown): void {
        if (eventName !== "session_start") {
            return;
        }
        if (typeof handler !== "function") {
            throw new Error("session_start handler must be a function");
        }
        this.sessionStartHandlers.push(handler as SessionStartHandler);
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
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

describe("extension lifecycle", () => {
    const originalAgentDir = process.env[AGENT_DIR_ENV];

    afterEach(() => {
        if (originalAgentDir === undefined) {
            delete process.env[AGENT_DIR_ENV];
        } else {
            process.env[AGENT_DIR_ENV] = originalAgentDir;
        }
        vi.useRealTimers();
    });

    it("defers syntax preload timers until a session starts", async () => {
        vi.useFakeTimers();
        const root = mkdtempSync(join(tmpdir(), "pi-codex-look-lifecycle-"));
        process.env[AGENT_DIR_ENV] = join(root, "agent");
        const pi = new FakeExtensionApi();

        await codexLookExtension(pi as unknown as ExtensionAPI);

        expect(pi.registeredToolCount).toBe(0);
        expect(vi.getTimerCount()).toBe(0);

        await pi.startSession(join(root, "project"), false);

        expect(vi.getTimerCount()).toBe(1);
    });
});
