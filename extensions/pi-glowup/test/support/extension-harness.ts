import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import glowupExtension from "../../src/index.ts";

type ExtensionHandler = (...args: unknown[]) => unknown;

export class GlowupExtensionHarness {
    private readonly handlersByEvent = new Map<string, ExtensionHandler[]>();
    private readonly extensionApi: ExtensionAPI;

    constructor() {
        const apiBoundary = {
            on: (eventName: string, handler: unknown): void => {
                if (typeof handler !== "function") {
                    throw new TypeError(`${eventName} extension handler must be callable`);
                }
                const handlers = this.handlersByEvent.get(eventName) ?? [];
                // SAFETY: The runtime check above establishes a callable value. The extension
                // runner intentionally erases each event's distinct parameter tuple here.
                handlers.push(handler as ExtensionHandler);
                this.handlersByEvent.set(eventName, handlers);
            },
        };
        // SAFETY: pi-glowup only consumes ExtensionAPI.on during registration. Tests drive
        // every registered callback through the representative event context below.
        this.extensionApi = apiBoundary as unknown as ExtensionAPI;
    }

    async install(cwd: string, branch: readonly unknown[] = []): Promise<void> {
        glowupExtension(this.extensionApi);
        await this.emit(
            "session_start",
            { type: "session_start", reason: "startup" },
            {
                cwd,
                mode: "tui",
                ui: {
                    getToolsExpanded: () => false,
                    setToolsExpanded() {},
                },
                sessionManager: {
                    getBranch: () => branch,
                },
                isProjectTrusted: () => true,
            },
        );
    }

    async shutdown(reason: "quit" | "reload" = "quit"): Promise<void> {
        await this.emit("session_shutdown", { type: "session_shutdown", reason }, {});
    }

    async emitToolCall(event: ToolCallEvent, cwd: string): Promise<void> {
        await this.emit("tool_call", event, { cwd });
    }

    private async emit(eventName: string, event: unknown, context: unknown): Promise<void> {
        for (const handler of this.handlersByEvent.get(eventName) ?? []) {
            await handler(event, context);
        }
    }
}
