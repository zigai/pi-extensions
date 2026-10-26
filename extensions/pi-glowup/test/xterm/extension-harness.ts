import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    SessionManager,
    type SessionEntry,
    type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import glowupExtension from "../../src/index.ts";
import {
    createExtensionContext,
    ExtensionRegistrationFixture,
} from "../support/sdk-extension-fixture.ts";

export class GlowupExtensionHarness {
    private readonly api = new ExtensionRegistrationFixture();
    private cwd = process.cwd();

    async install(cwd: string, branch: readonly SessionEntry[] = []): Promise<void> {
        this.cwd = cwd;
        glowupExtension(this.api);

        const sessionManager = SessionManager.inMemory(cwd);
        const context = createExtensionContext(cwd, {
            mode: "tui",
            sessionManager: Object.assign(sessionManager, { getBranch: () => [...branch] }),
        });
        for (const registration of this.api.registrations) {
            if (registration[0] === "session_start") {
                await registration[1]({ type: "session_start", reason: "startup" }, context);
            }
        }
    }

    async shutdown(reason: "quit" | "reload" = "quit"): Promise<void> {
        for (const registration of this.api.registrations) {
            if (registration[0] === "session_shutdown") {
                await registration[1](
                    { type: "session_shutdown", reason },
                    createExtensionContext(this.cwd),
                );
            }
        }
    }

    async startAssistantToolCall(toolName: string, toolCallId: string): Promise<void> {
        const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
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
        for (const registration of this.api.registrations) {
            if (registration[0] === "message_start") {
                await registration[1](
                    { type: "message_start", message },
                    createExtensionContext(this.cwd, { mode: "tui" }),
                );
            }
        }
    }

    async emitToolCall(event: ToolCallEvent, cwd: string): Promise<void> {
        for (const registration of this.api.registrations) {
            if (registration[0] === "tool_call") {
                await registration[1](event, createExtensionContext(cwd));
            }
        }
    }
}
