import { parseSlashCommandText } from "../invocation.js";
import type { PiTypedCommandLookup, RegisteredTypedCommand } from "./command-types.js";

/** A typed command invocation parsed from the Pi editor's first line and trailing body. */
export type EditorTypedCommandInvocation = {
    command: RegisteredTypedCommand;
    rawArgs: string;
    trailingBody: string;
};

/** Return the display/invocation name for a typed command. */
export function commandDisplayName(command: RegisteredTypedCommand): string {
    return command.invocationName ?? command.name;
}

/** Parse slash-command text into command name, raw arguments, and trailing body text. */
export function slashCommandMatch(editorText: string): ReturnType<typeof parseSlashCommandText> {
    return parseSlashCommandText(editorText);
}

/** Return the typed command invocation represented by editor text, when it targets one. */
export function commandInvocationForEditorText(
    editorText: string,
    commands: PiTypedCommandLookup,
): EditorTypedCommandInvocation | undefined {
    const match = slashCommandMatch(editorText);
    if (match === undefined) {
        return undefined;
    }

    const command = commands.get(match.commandName);
    if (command === undefined) {
        return undefined;
    }

    return {
        command,
        rawArgs: match.rawArgs,
        trailingBody: match.trailingBody,
    };
}

/** Return the typed command invocation eligible for the live helper widget. */
export function helperInvocationForEditorText(
    editorText: string,
    commands: PiTypedCommandLookup,
): EditorTypedCommandInvocation | undefined {
    const invocation = commandInvocationForEditorText(editorText, commands);
    if (invocation === undefined) {
        return undefined;
    }

    const { command } = invocation;

    if (Object.keys(command.args).length === 0) {
        return undefined;
    }

    return invocation;
}

/** Format an invocation back into the exact editor command text shape. */
export function editorTextForInvocation(invocation: EditorTypedCommandInvocation): string {
    let text = `/${commandDisplayName(invocation.command)}`;
    if (invocation.rawArgs.length > 0) {
        text += ` ${invocation.rawArgs}`;
    }
    if (invocation.trailingBody.length > 0) {
        text += `\n${invocation.trailingBody}`;
    }
    return text;
}
