import { parseSlashCommandText } from "../invocation.ts";
import type { PiTypedCommandLookup, RegisteredTypedCommand } from "./command-types.ts";

export type EditorTypedCommandInvocation = {
    command: RegisteredTypedCommand;
    rawArgs: string;
    trailingBody: string;
};

export function commandDisplayName(command: RegisteredTypedCommand): string {
    return command.invocationName ?? command.name;
}

export function slashCommandMatch(editorText: string): ReturnType<typeof parseSlashCommandText> {
    return parseSlashCommandText(editorText);
}

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

export function helperInvocationForEditorText(
    editorText: string,
    commands: PiTypedCommandLookup,
): EditorTypedCommandInvocation | undefined {
    const invocation = commandInvocationForEditorText(editorText, commands);
    if (invocation === undefined) {
        return undefined;
    }

    const { command } = invocation;
    if (Object.keys(command.args).length === 0 && command.subcommands === undefined) {
        return undefined;
    }

    return invocation;
}

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
