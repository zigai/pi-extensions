import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadMessageTimestampsSettings } from "./settings.ts";
import { Timestamps } from "./timestamps.ts";

export default function messageTimestampsExtension(pi: ExtensionAPI): void {
    let active: Timestamps | undefined;
    const reset = () => {
        active?.dispose();
        active = undefined;
    };

    pi.on("session_start", (event, ctx) => {
        reset();

        const loaded = loadMessageTimestampsSettings(ctx);
        for (const diagnostic of loaded.diagnostics)
            if (ctx.hasUI) ctx.ui.notify(diagnostic.message, diagnostic.severity);

        if (!ctx.hasUI || !loaded.settings.enabled) return;
        try {
            active = new Timestamps(ctx, loaded.settings);

            if (
                (event.reason === "reload" ||
                    event.reason === "resume" ||
                    event.reason === "fork") &&
                ctx.sessionManager
                    .getBranch()
                    .some(
                        (entry) =>
                            entry.type === "message" &&
                            (entry.message.role === "user" || entry.message.role === "assistant"),
                    )
            ) {
                ctx.ui.notify(
                    "Message timestamps may be unavailable on already-rendered history after reload or session switch.",
                    "warning",
                );
            }
        } catch {
            reset();
            ctx.ui.notify(
                "Message timestamps could not activate with this interactive host.",
                "warning",
            );
        }
    });

    pi.on("session_shutdown", reset);
}
