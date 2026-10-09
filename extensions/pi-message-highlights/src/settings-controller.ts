import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HighlightTheme } from "./highlight-styles.ts";
import {
    loadMessageHighlightsSettings,
    type LoadedMessageHighlightsConfig,
    type MessageHighlightsConfig,
} from "./settings.ts";

export type MessageHighlightSettingsContext = Pick<
    ExtensionContext,
    "cwd" | "hasUI" | "isProjectTrusted"
> & {
    readonly ui: Pick<ExtensionContext["ui"], "notify"> & { readonly theme?: HighlightTheme };
};

export class MessageHighlightSettingsController {
    private snapshot: LoadedMessageHighlightsConfig | undefined;

    constructor(private readonly loadSettings = loadMessageHighlightsSettings) {}

    reset(): void {
        this.snapshot = undefined;
    }

    apply(ctx: MessageHighlightSettingsContext): MessageHighlightsConfig {
        if (this.snapshot !== undefined) return this.snapshot.config;

        this.snapshot = this.loadSettings(ctx.cwd, ctx.isProjectTrusted());
        if (ctx.hasUI) {
            for (const error of this.snapshot.errors) {
                ctx.ui.notify(`[pi-message-highlights] ${error}`, "error");
            }
        }

        return this.snapshot.config;
    }
}
