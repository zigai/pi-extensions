import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { TypedCommandUxOptions } from "../types.js";
import {
    notifySkillDiagnosticsForText,
    refreshTypedSkills,
    transformTypedSkillInput,
} from "./skill-input.js";
import { TypedCommandUxSession } from "./ux-session.js";

/**
 * Install the live editor helper, typed autocomplete bridge, and Tab-to-form shortcut.
 *
 * This is installed automatically by the default extension export. Extension authors usually only
 * call it directly when composing pi-typed-args into a custom extension entrypoint.
 */
export function installTypedCommandUx(pi: ExtensionAPI, options: TypedCommandUxOptions = {}): void {
    const session = new TypedCommandUxSession(pi, options);

    pi.on("session_start", async (_event, ctx) => {
        refreshTypedSkills(pi);
        session.start(ctx);
    });

    pi.on("input", async (event, ctx) => {
        session.clearWidget(ctx);
        const commandCtx = ctx as ExtensionCommandContext;
        if (notifySkillDiagnosticsForText(event.text, commandCtx)) {
            return { action: "handled" } as const;
        }
        const typedSkillResult = await transformTypedSkillInput(event.text, commandCtx);
        if (typedSkillResult?.action === "handled") {
            return { action: "handled" } as const;
        }
        if (typedSkillResult?.action === "transform") {
            if (event.images !== undefined) {
                return {
                    action: "transform",
                    text: typedSkillResult.text,
                    images: event.images,
                } as const;
            }
            return { action: "transform", text: typedSkillResult.text } as const;
        }
        return { action: "continue" } as const;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        session.stop();
        session.clearWidget(ctx);
    });
}

/** Create a Pi extension entrypoint with custom typed-command UX options. */
export function createTypedCommandUxExtension(
    options: TypedCommandUxOptions = {},
): ExtensionFactory {
    return (pi) => {
        installTypedCommandUx(pi, options);
    };
}

/** Pi extension entrypoint that installs the typed-args UX. */
export default function piTypedCommandsExtension(pi: ExtensionAPI): void {
    installTypedCommandUx(pi);
}
