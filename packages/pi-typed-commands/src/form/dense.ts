import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHeadlessFormModel } from "../pi-tui/form-model.js";
import type {
    ArgumentDefinitions,
    ArgumentValue,
    FormMode,
    ParsedCommandArguments,
    RegisteredTypedCommand,
} from "../types.js";
import { ArgumentFormComponent, type FormResult } from "./dense-component.js";
import { resolveTypedCommandAppearance } from "../pi/settings.js";

function resolveFormTitle<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    ctx: ExtensionCommandContext,
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
    ctx: ExtensionCommandContext,
): Promise<Record<string, ArgumentValue> | undefined> {
    const { state, fields, initialSelection } = createHeadlessFormModel(command.args, parsed, mode);
    const appearance = resolveTypedCommandAppearance(ctx).form;

    if (fields.length === 0) {
        return state;
    }

    const result = await ctx.ui.custom<FormResult | undefined>(
        (tui, theme, _keybindings, done) =>
            new ArgumentFormComponent(
                tui,
                resolveFormTitle(command, ctx),
                fields,
                state,
                theme,
                command.formSymbols,
                appearance,
                done,
                initialSelection,
            ),
    );

    if (result === undefined || !result.confirmed) {
        return undefined;
    }

    return result.state;
}
