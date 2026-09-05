import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import glowupExtension from "../../src/index.ts";

type HarnessEvent =
    | ToolCallEvent
    | { readonly type: "session_start"; readonly reason: "startup" }
    | { readonly type: "session_shutdown"; readonly reason: "quit" | "reload" };

type HarnessContext = {
    readonly cwd?: string;
    readonly mode?: "tui";
    readonly ui?: {
        readonly getToolsExpanded: () => boolean;
        readonly setToolsExpanded: () => void;
    };
    readonly sessionManager?: { readonly getBranch: () => readonly unknown[] };
    readonly isProjectTrusted?: () => boolean;
};

type ExtensionHandler = (event: HarnessEvent, context: HarnessContext) => void | Promise<void>;

export class GlowupExtensionHarness {
    private readonly handlersByEvent = new Map<string, ExtensionHandler[]>();
    private readonly extensionApi: ExtensionAPI;

    constructor() {
        const apiBoundary = {
            on: (eventName: string, handler: ExtensionHandler): void => {
                const handlers = this.handlersByEvent.get(eventName) ?? [];
                handlers.push(handler);
                this.handlersByEvent.set(eventName, handlers);
            },
        };
        // SAFETY: pi-glowup only consumes ExtensionAPI.on during registration. Object.assign
        // installs that tested seam before the fixture is exposed to the extension.
        const extensionApiFixture = {} as ExtensionAPI;
        this.extensionApi = Object.assign(extensionApiFixture, apiBoundary);
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

    private async emit(
        eventName: string,
        event: HarnessEvent,
        context: HarnessContext,
    ): Promise<void> {
        for (const handler of this.handlersByEvent.get(eventName) ?? []) {
            await handler(event, context);
        }
    }
}
