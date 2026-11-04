import type {
    ExtensionContext,
    InputEvent,
    InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { loadInputCorrectionsSettings, type LoadedInputCorrectionsSettings } from "./settings.ts";

export type InputCorrectionsContext = Pick<
    ExtensionContext,
    "cwd" | "hasUI" | "isProjectTrusted"
> & {
    ui: Pick<ExtensionContext["ui"], "notify">;
};

interface InputCorrectionsHost {
    on(event: "session_start" | "session_shutdown", handler: () => void): () => void;
    on(
        event: "input",
        handler: (event: InputEvent, ctx: InputCorrectionsContext) => InputEventResult,
    ): () => void;
}

export default function inputCorrectionsExtension(pi: InputCorrectionsHost): void {
    let loaded: LoadedInputCorrectionsSettings | undefined;
    let reported = false;

    function getSettings(ctx: InputCorrectionsContext) {
        loaded ??= loadInputCorrectionsSettings();
        if (!reported) {
            reported = true;

            for (const diagnostic of loaded.diagnostics) {
                if (ctx.hasUI) ctx.ui.notify(diagnostic.message, diagnostic.severity);
                else console.error(diagnostic.message);
            }
        }

        return loaded;
    }

    function reset() {
        loaded = undefined;
        reported = false;
    }

    pi.on("session_start", reset);
    pi.on("session_shutdown", reset);
    pi.on("input", (event, ctx) => {
        if (event.source !== "interactive") return { action: "continue" };

        const text = getSettings(ctx).engine.correct(event.text);
        if (text === event.text) return { action: "continue" };

        return { action: "transform", text, images: event.images };
    });
}
