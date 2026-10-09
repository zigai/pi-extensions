import { getTypedCommandRefinementIssues } from "../parser.ts";
import { formatFormIssueMessage } from "../pi-tui/form-model.ts";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    FormMode,
    ParsedCommandArguments,
} from "../types.ts";
import type { RegisteredTypedCommand } from "../pi/command-types.ts";
import { formatIssues } from "../usage.ts";
import { openDenseArgumentForm } from "./dense.ts";
import { SequentialArgumentForm } from "./sequential.ts";
import type { ResolvedPiTypedCommandsAppearance } from "../pi/presentation-config.ts";
import type { ArgumentFormContext } from "./context.ts";
import type { CompletionCapabilities } from "../completions.ts";

export type OpenArgumentFormOptions = {
    readonly appearance: ResolvedPiTypedCommandsAppearance;
    readonly signal?: AbortSignal;

    /** Title already adapted from any Pi-specific form-title callback. */
    readonly title?: string;

    /** Runtime capabilities used by completion-backed form controls. */
    readonly completionCapabilities?: CompletionCapabilities;

    /** Receives the exact submit input after a dense TUI form closes successfully. */
    readonly onTuiSubmitInput?: (data: string) => void;
};

/**
 * Prompt for typed command arguments using the dense TUI form when available, otherwise sequential prompts.
 *
 * Returns collected argument values, or `undefined` when the user cancels or no UI value is submitted.
 */
export async function openArgumentForm<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
    ctx: ArgumentFormContext,
    options: OpenArgumentFormOptions,
): Promise<Record<string, ArgumentValue> | undefined> {
    let result: Record<string, ArgumentValue> | undefined;
    if (ctx.mode === "tui") {
        result = await openDenseArgumentForm(command, parsed, mode, ctx, options);
    } else {
        result = await new SequentialArgumentForm(command, parsed, mode, ctx, options.signal).run();
    }

    if (result === undefined) {
        return undefined;
    }

    const refinementIssues = getTypedCommandRefinementIssues(command, result, parsed.provided);
    if (refinementIssues.length > 0 && options.signal?.aborted !== true) {
        ctx.ui.notify(formatIssues(refinementIssues.map(formatFormIssueMessage)), "error");
        return undefined;
    }

    return result;
}
