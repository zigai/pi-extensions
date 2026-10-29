import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExtensionDiagnostics } from "@zigai/pi-extension-internals";
import { installResponseRendering } from "./response-rendering.ts";
import { loadResponseRendererSettings } from "./settings.ts";
import { unwrapTableFences } from "./table-fence-normalization.ts";
import {
    selectTableRenderer,
    observeTableRendering,
    tableRenderingState,
} from "./table-rendering.ts";

export {
    registerTableRenderer,
    selectTableRenderer,
    renderCodexTable,
    type TableRenderer,
    type TableRenderInput,
} from "./table-rendering.ts";

export default function assistantRenderingExtension(pi: ExtensionAPI): void {
    pi.registerMarkdownTransformer((markdown, context) => {
        if (context.messageType === "assistant") return unwrapTableFences(markdown);

        return markdown;
    });

    let generation = 0;
    let inFlight: Promise<void> = Promise.resolve();
    let active: Awaited<ReturnType<typeof installResponseRendering>> | undefined;
    let stopObserving: (() => void) | undefined;
    const reset = (): void => {
        generation += 1;
        stopObserving?.();
        stopObserving = undefined;
        active?.dispose();
        active = undefined;
    };

    pi.on("session_start", async (_event, ctx) => {
        reset();

        const current = generation;

        inFlight = inFlight
            .catch(() => {})
            .then(async () => {
                if (current !== generation || !ctx.hasUI) return;

                const loaded = loadResponseRendererSettings(ctx);
                for (const diagnostic of loaded.diagnostics)
                    ctx.ui.notify(diagnostic.message, diagnostic.severity);

                const handle = await installResponseRendering({
                    ...loaded.settings,
                    accent: (text) => ctx.ui.theme.fg("accent", text),
                });
                if (current !== generation) {
                    handle.dispose();
                    return;
                }

                active = handle;

                try {
                    selectTableRenderer(loaded.settings.tableRenderer);
                } catch {
                    ctx.ui.notify("Selected response table renderer is unavailable.", "error");
                    selectTableRenderer("native");
                }

                stopObserving = observeTableRendering(() =>
                    ctx.ui.setStatus("response-tables", `Tables: ${tableRenderingState().name}`),
                );
            });

        return inFlight;
    });

    pi.on("session_shutdown", async () => {
        reset();
        await inFlight;
    });
    registerExtensionDiagnostics(pi);
}
