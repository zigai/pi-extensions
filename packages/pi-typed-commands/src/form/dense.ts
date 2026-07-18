import { createHeadlessFormModel } from "../pi-tui/form-model.js";
import { getTypedCommandRefinementIssues, serializeTypedCommandArgs } from "../parser.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    FormMode,
    ParsedCommandArguments,
} from "../types.js";
import type { RegisteredTypedCommand } from "../pi/command-types.js";
import { ArgumentFormComponent, type FormResult } from "./dense-component.js";
import type { OpenArgumentFormOptions } from "./open.js";
import type { ArgumentFormContext } from "./context.js";

function serializeFormPreview(
    command: RegisteredTypedCommand,
    values: Record<string, ArgumentValue>,
): string {
    const serialized = serializeTypedCommandArgs(command, values);
    if (serialized.length === 0) {
        return `/${command.name}`;
    }
    return `/${command.name} ${serialized}`;
}

function signalAborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
}

function resolveFormTitle<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    options: OpenArgumentFormOptions,
): string {
    if (options.title !== undefined) {
        return options.title;
    }
    const title = command.formTitle;
    if (title !== undefined) {
        if (typeof title === "string") {
            return title;
        }
    }
    return command.name.replace(" ", " › ");
}

/** Open the dense TUI argument form for a parsed typed command. */
export async function openDenseArgumentForm<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
    ctx: ArgumentFormContext,
    options: OpenArgumentFormOptions,
): Promise<Record<string, ArgumentValue> | undefined> {
    const { state, fields, initialSelection } = createHeadlessFormModel(command.args, parsed, mode);
    const appearance = options.appearance.form;

    if (fields.length === 0 && !signalAborted(options.signal)) {
        return state;
    }
    if (signalAborted(options.signal)) {
        return undefined;
    }

    let removeAbortListener = (): void => {};
    let result: FormResult | undefined;
    try {
        result = await ctx.ui.custom<FormResult | undefined>((tui, theme, keybindings, done) => {
            const abort = (): void => {
                done(undefined);
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => {
                options.signal?.removeEventListener("abort", abort);
            };
            return new ArgumentFormComponent(
                tui,
                resolveFormTitle(command, options),
                fields,
                state,
                theme,
                command.formSymbols,
                appearance,
                options.completionCapabilities,
                keybindings,
                (values) => getTypedCommandRefinementIssues(command, values, parsed.provided),
                (values) => {
                    const safeValues = { ...values };
                    for (const [name, definition] of Object.entries(command.args)) {
                        if (definition.type === "string" && definition.sensitive === true) {
                            safeValues[name] = undefined;
                        }
                    }
                    return serializeFormPreview(command, safeValues);
                },
                done,
                initialSelection,
            );
        });
    } finally {
        removeAbortListener();
    }

    if (signalAborted(options.signal) || result === undefined || !result.confirmed) {
        return undefined;
    }

    return result.state;
}
