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

function helperPlacementFromSettings(settings: unknown): WidgetPlacement | undefined {
    try {
        return Schema.Parse(PiSettingsSchema, settings).piTypedCommands?.helperPlacement;
    } catch {
        return undefined;
    }
}

function helperPlacementFromPiSettings(ctx: ExtensionContext): WidgetPlacement | undefined {
    try {
        let projectTrusted = true;
        if (typeof ctx.isProjectTrusted === "function") {
            projectTrusted = ctx.isProjectTrusted();
        }
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
        return (
            helperPlacementFromSettings(settings.getProjectSettings()) ??
            helperPlacementFromSettings(settings.getGlobalSettings())
        );
    } catch {
        return undefined;
    }
}

/** Resolve typed-command UX options from explicit options and Pi settings. */
export function resolveTypedCommandUxOptions(
    options: TypedCommandUxOptions = {},
    ctx?: ExtensionContext,
): Required<TypedCommandUxOptions> {
    let settingsHelperPlacement: WidgetPlacement | undefined;
    if (ctx !== undefined) {
        settingsHelperPlacement = helperPlacementFromPiSettings(ctx);
    }
    return {
        helperPlacement:
            options.helperPlacement ?? settingsHelperPlacement ?? DEFAULT_HELPER_PLACEMENT,
    };
}
