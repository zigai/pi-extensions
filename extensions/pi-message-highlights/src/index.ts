import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    MessageHighlightSettingsController,
    type MessageHighlightSettingsContext,
} from "./settings-controller.ts";
import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
    type MessageHighlightPatchHandle,
} from "./message-highlight-patch.ts";

export type MessageHighlightsApi = {
    on(
        event: "session_start" | "session_shutdown",
        handler: (
            event: { readonly type: "session_start" | "session_shutdown" },
            ctx: MessageHighlightSettingsContext,
        ) => void | Promise<void>,
    ): void;
};

export function registerMessageHighlights(
    pi: MessageHighlightsApi,
    settings = new MessageHighlightSettingsController(),
    loadTargets = loadMessageHighlightTargets,
): void {
    let generation = 0;
    let patch: MessageHighlightPatchHandle | undefined;
    let activation: Promise<void> | undefined;

    function reset(): void {
        generation += 1;
        patch?.dispose();
        patch = undefined;
        activation = undefined;
        settings.reset();
    }

    async function activate(ctx: MessageHighlightSettingsContext): Promise<void> {
        if (activation !== undefined) return activation;

        const config = settings.apply(ctx);
        const activeGeneration = generation;

        activation = (async () => {
            const targets = await loadTargets();
            if (activeGeneration !== generation || targets === undefined) return;

            patch = installMessageHighlightPatch(targets, config, () => {
                if (!ctx.hasUI) return undefined;
                try {
                    return ctx.ui.theme;
                } catch {
                    // Early renders can precede theme initialization. Retry on the next render.
                    return undefined;
                }
            });
        })();

        return activation;
    }

    pi.on("session_start", async (_event, ctx) => {
        reset();
        return activate(ctx);
    });
    pi.on("session_shutdown", reset);
}

export default function messageHighlightsExtension(pi: ExtensionAPI): void {
    registerMessageHighlights(pi);
}
