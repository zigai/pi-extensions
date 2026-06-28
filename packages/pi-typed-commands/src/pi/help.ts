import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RegisteredTypedCommand } from "../types.js";
import { formatDetailedHelp } from "../usage.js";
import {
    type ResolvedDetailedHelpAppearance,
    type ResolvedPiTypedCommandsAppearance,
} from "./presentation-config.js";
import { resolveTypedCommandAppearance } from "./settings.js";

function detailedHelpOptions(
    appearance: ResolvedDetailedHelpAppearance,
): ResolvedDetailedHelpAppearance | undefined {
    if (appearance.configured) {
        return appearance;
    }
    return undefined;
}

/** Notify the user with generated detailed help using resolved Pi appearance settings. */
export function notifyDetailedHelp<TCommand extends RegisteredTypedCommand>(
    ctx: ExtensionCommandContext,
    command: TCommand,
    appearance: ResolvedPiTypedCommandsAppearance = resolveTypedCommandAppearance(ctx),
): void {
    ctx.ui.notify(
        formatDetailedHelp(command, detailedHelpOptions(appearance.detailedHelp)),
        "info",
    );
}
