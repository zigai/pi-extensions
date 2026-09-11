import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { TypedCommandUxOptions } from "../types.js";
import {
    notifySkillDiagnosticsForText,
    refreshTypedSkills,
    transformTypedSkillInput,
} from "./skill-input.js";
import { TypedCommandUxSession } from "./ux-session.js";
import { getPiTypedCommandRegistry } from "./registry.js";

const PI_UX_INSTALLATIONS_KEY = Symbol.for("pi-typed-args.ux-installations.v1");

type SharedTypedCommandUxInstallation = {
    mergeOptions(options: TypedCommandUxOptions): void;
};

type GlobalWithTypedCommandUxInstallations = typeof globalThis & {
    [PI_UX_INSTALLATIONS_KEY]?: WeakMap<object, SharedTypedCommandUxInstallation>;
};

function getTypedCommandUxInstallations(): WeakMap<object, SharedTypedCommandUxInstallation> {
    const globalObject: GlobalWithTypedCommandUxInstallations = globalThis;
    let installations = globalObject[PI_UX_INSTALLATIONS_KEY];
    if (installations === undefined) {
        installations = new WeakMap();
        globalObject[PI_UX_INSTALLATIONS_KEY] = installations;
    }

    return installations;
}

function installationKey(pi: ExtensionAPI): object {
    if (typeof pi.events === "object" && pi.events !== null) {
        return pi.events;
    }

    return pi;
}

/**
 * Install the live editor helper, typed autocomplete bridge, and Tab-to-form shortcut.
 *
 * This is installed automatically by the default extension export. Extension authors usually only
 * call it directly when composing pi-typed-args into a custom extension entrypoint.
 */
export function installTypedCommandUx(pi: ExtensionAPI, options: TypedCommandUxOptions = {}): void {
    const installations = getTypedCommandUxInstallations();
    const key = installationKey(pi);
    const existing = installations.get(key);
    if (existing !== undefined) {
        existing.mergeOptions(options);
        return;
    }

    const registry = getPiTypedCommandRegistry();
    const session = new TypedCommandUxSession(pi, options, registry);
    const installation: SharedTypedCommandUxInstallation = {
        mergeOptions(nextOptions) {
            session.mergeConfiguredOptions(nextOptions);
        },
    };

    installations.set(key, installation);

    pi.on("session_start", async (_event, ctx) => {
        refreshTypedSkills(pi, registry);
        await session.start(ctx);
    });

    pi.on("input", async (event, ctx) => {
        session.clearWidget(ctx);

        if (notifySkillDiagnosticsForText(event.text, ctx, registry)) {
            return { action: "handled" } as const;
        }

        const typedSkillResult = await transformTypedSkillInput(
            event.text,
            ctx,
            registry,
            session.resolvedOptions.appearance,
            "missing",
            ctx.signal,
        );
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

    pi.on("session_shutdown", async (event, ctx) => {
        await session.stop();
        session.clearWidget(ctx);

        if (event.reason === "reload" && installations.get(key) === installation) {
            installations.delete(key);
        }
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
