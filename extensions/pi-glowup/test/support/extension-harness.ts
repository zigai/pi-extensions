import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexLookExtension from "../../src/index.ts";

type ExtensionHandler = (...args: unknown[]) => unknown;

export class CodexLookExtensionHarness {
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
        // SAFETY: pi-codex-look only consumes ExtensionAPI.on during registration. Tests drive
        // every registered callback through the representative event context below.
        this.extensionApi = apiBoundary as unknown as ExtensionAPI;
    }

    async install(cwd: string, branch: readonly unknown[] = []): Promise<void> {
        await codexLookExtension(this.extensionApi);
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

    private async emit(eventName: string, event: unknown, context: unknown): Promise<void> {
        for (const handler of this.handlersByEvent.get(eventName) ?? []) {
            await handler(event, context);
        }
    }
}
