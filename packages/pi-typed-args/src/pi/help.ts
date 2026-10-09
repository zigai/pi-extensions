import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegisteredTypedCommand } from "./command-types.ts";
import { formatDetailedHelp } from "../usage.ts";
import {
    type ResolvedDetailedHelpAppearance,
    type ResolvedPiTypedCommandsAppearance,
} from "./presentation-config.ts";

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
