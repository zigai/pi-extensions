import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getTypedCommandRefinementIssues } from "../parser.js";
import { formatFormIssueMessage } from "../pi-tui/form-model.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    FormMode,
    ParsedCommandArguments,
    RegisteredTypedCommand,
} from "../types.js";
import { formatIssues } from "../usage.js";
import { openDenseArgumentForm } from "./dense.js";
import { SequentialArgumentForm } from "./sequential.js";

/**
 * Prompt for typed command arguments using the dense TUI form when available, otherwise sequential prompts.
 *
 * Returns collected argument values, or `undefined` when the user cancels or no UI value is submitted.
 */
export async function openArgumentForm<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
    ctx: ExtensionCommandContext,
): Promise<Record<string, ArgumentValue> | undefined> {
    let result: Record<string, ArgumentValue> | undefined;
    if (ctx.mode === "tui") {
        result = await openDenseArgumentForm(command, parsed, mode, ctx);
    } else {
        result = await new SequentialArgumentForm(command, parsed, mode, ctx).run();
    }
    if (result === undefined) {
        return undefined;
    }

    const refinementIssues = getTypedCommandRefinementIssues(command, result, parsed.provided);
    if (refinementIssues.length > 0) {
        ctx.ui.notify(formatIssues(refinementIssues.map(formatFormIssueMessage)), "error");
        return undefined;
    }
    return result;
}
