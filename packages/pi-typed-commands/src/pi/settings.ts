import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    getAgentDir,
    SettingsManager,
    type ExtensionContext,
    type WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import type SchemaModule from "typebox/schema";
import type { TypedCommandUxOptions } from "../types.js";
import { DEFAULT_HELPER_PLACEMENT } from "./helper.js";
import {
    DEFAULT_PI_TYPED_COMMANDS_APPEARANCE,
    parsePiTypedCommandsAppearanceFromSettings,
    type ResolvedPiTypedCommandsAppearance,
} from "./presentation-config.js";

const require = createRequire(import.meta.url);
const Schema: typeof SchemaModule = await import(
    pathToFileURL(join(dirname(require.resolve("typebox")), "schema/index.mjs")).href
);

const PiSettingsSchema = Type.Object(
    {
        piTypedCommands: Type.Optional(
            Type.Object(
                {
                    helperPlacement: Type.Optional(
                        Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]),
                    ),
                },
                { additionalProperties: true },
            ),
        ),
    },
    { additionalProperties: true },
);

type PiSettingsSnapshot = {
    projectSettings: unknown;
    globalSettings: unknown;
};

function helperPlacementFromSettings(settings: unknown): WidgetPlacement | undefined {
    try {
        return Schema.Parse(PiSettingsSchema, settings).piTypedCommands?.helperPlacement;
    } catch {
        return undefined;
    }
}

function projectTrusted(ctx: ExtensionContext): boolean {
    if (typeof ctx.isProjectTrusted === "function") {
        return ctx.isProjectTrusted();
    }
    return true;
}

function readSetting(read: () => unknown): unknown {
    try {
        return read();
    } catch {
        return undefined;
    }
}

function piSettingsSnapshot(ctx: ExtensionContext): PiSettingsSnapshot | undefined {
    try {
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: projectTrusted(ctx),
        });
        return {
            projectSettings: readSetting(() => settings.getProjectSettings()),
            globalSettings: readSetting(() => settings.getGlobalSettings()),
        };
    } catch {
        return undefined;
    }
}

function helperPlacementFromPiSettings(
    snapshot: PiSettingsSnapshot | undefined,
): WidgetPlacement | undefined {
    if (snapshot === undefined) {
        return undefined;
    }
    return (
        helperPlacementFromSettings(snapshot.projectSettings) ??
        helperPlacementFromSettings(snapshot.globalSettings)
    );
}

function appearanceFromPiSettings(
    snapshot: PiSettingsSnapshot | undefined,
): ResolvedPiTypedCommandsAppearance {
    if (snapshot === undefined) {
        return DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    }
    return parsePiTypedCommandsAppearanceFromSettings(snapshot.globalSettings);
}

/** Resolved UX settings for typed-command Pi integrations. */
export type ResolvedTypedCommandUxOptions = {
    helperPlacement: WidgetPlacement;
    appearance: ResolvedPiTypedCommandsAppearance;
};

/** Resolve global-only typed-command appearance settings from Pi settings. */
export function resolveTypedCommandAppearance(
    ctx?: ExtensionContext,
): ResolvedPiTypedCommandsAppearance {
    if (ctx === undefined) {
        return DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    }

    return appearanceFromPiSettings(piSettingsSnapshot(ctx));
}

/** Resolve typed-command UX options from explicit options and Pi settings. */
export function resolveTypedCommandUxOptions(
    options: TypedCommandUxOptions = {},
    ctx?: ExtensionContext,
): ResolvedTypedCommandUxOptions {
    let settingsHelperPlacement: WidgetPlacement | undefined;
    let appearance = DEFAULT_PI_TYPED_COMMANDS_APPEARANCE;
    if (ctx !== undefined) {
        const snapshot = piSettingsSnapshot(ctx);
        settingsHelperPlacement = helperPlacementFromPiSettings(snapshot);
        appearance = appearanceFromPiSettings(snapshot);
    }
    return {
        helperPlacement:
            options.helperPlacement ?? settingsHelperPlacement ?? DEFAULT_HELPER_PLACEMENT,
        appearance,
    };
}
