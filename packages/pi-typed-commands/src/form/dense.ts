import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHeadlessFormModel } from "../pi-tui/form-model.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    FormMode,
    ParsedCommandArguments,
    RegisteredTypedCommand,
} from "../types.js";
import { ArgumentFormComponent, type FormResult } from "./dense-component.js";
import type { OpenArgumentFormOptions } from "./open.js";

function signalAborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
}

function resolveFormTitle<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    ctx: ExtensionContext,
): string {
    const title = command.formTitle;
    if (typeof title === "function") {
        return title(ctx);
    }
    if (title !== undefined) {
        return title;
    }
    return command.name;
}

/** Open the dense TUI argument form for a parsed typed command. */
export async function openDenseArgumentForm<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: FormMode,
    ctx: ExtensionContext,
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
        result = await ctx.ui.custom<FormResult | undefined>((tui, theme, _keybindings, done) => {
            const abort = (): void => {
                done(undefined);
            };
            options.signal?.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => {
                options.signal?.removeEventListener("abort", abort);
            };
            return new ArgumentFormComponent(
                tui,
                resolveFormTitle(command, ctx),
                fields,
                state,
                theme,
                command.formSymbols,
                appearance,
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
