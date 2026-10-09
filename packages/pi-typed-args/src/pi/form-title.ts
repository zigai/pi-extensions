import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArgumentDefinitions } from "../types.ts";
import type { RegisteredTypedCommand } from "./command-types.ts";

/** Adapt a Pi-facing form-title callback into the string consumed by the form module. */
export function resolveTypedCommandFormTitle<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    ctx: ExtensionContext,
): string {
    const title = command.formTitle;
    if (typeof title === "function") {
        return title(ctx);
    }

    return title ?? command.name.replace(" ", " › ");
}
