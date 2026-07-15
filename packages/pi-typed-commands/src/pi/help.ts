import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegisteredTypedCommand } from "../types.js";
import { formatDetailedHelp } from "../usage.js";
import {
    type ResolvedDetailedHelpAppearance,
    type ResolvedPiTypedCommandsAppearance,
} from "./presentation-config.js";

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
    ctx: ExtensionContext,
    command: TCommand,
    appearance: ResolvedPiTypedCommandsAppearance,
): void {
    ctx.ui.notify(
        formatDetailedHelp(command, detailedHelpOptions(appearance.detailedHelp)),
        "info",
    );
}
