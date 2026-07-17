import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadAutonameSessionSettings } from "./settings.ts";

/** Register the Pi Autoname Session Pi extension. */
export default function extension(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
        const loaded = loadAutonameSessionSettings(ctx);
        for (const diagnostic of loaded.diagnostics) {
            ctx.ui.notify(diagnostic.message, diagnostic.severity);
        }
    });
}
