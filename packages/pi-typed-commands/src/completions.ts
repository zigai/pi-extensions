import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { formatFlagName, normalizeFlagName } from "./names.js";
import { getTypedCommand } from "./registry.js";
import type { ArgumentDefinition, RegisteredTypedCommand } from "./types.js";

type CommandLineContext = {
    command: RegisteredTypedCommand;
    argsBeforeCursor: string;
    currentPrefix: string;
    previousToken?: string;
};

function tokenizeLoose(input: string): string[] {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return [];
    }
    return trimmed.split(/\s+/);
}

function buildFlagLookup<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const [name, definition] of Object.entries(command.args)) {
        lookup.set(normalizeFlagName(name), name);
        if (definition.aliases !== undefined) {
            for (const alias of definition.aliases) {
                lookup.set(normalizeFlagName(alias), name);
            }
        }
    }
    return lookup;
}

function providedArgumentNames<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    tokens: string[],
): Set<string> {
    const lookup = buildFlagLookup(command);
    const provided = new Set<string>();

    for (const token of tokens) {
        if (!token.startsWith("-")) {
            continue;
        }

        let flag = token;
        const equalsIndex = flag.indexOf("=");
        if (equalsIndex >= 0) {
            flag = flag.slice(0, equalsIndex);
        }
        if (flag.startsWith("--no-")) {
            flag = `--${flag.slice(5)}`;
        }

        const name = lookup.get(normalizeFlagName(flag));
        if (name !== undefined) {
            provided.add(name);
        }
    }

    return provided;
}

function flagItem(name: string, definition: ArgumentDefinition): AutocompleteItem {
    let value = `${formatFlagName(name)} `;
    if (definition.type === "boolean") {
        value = formatFlagName(name);
    }

    const description = definition.description ?? definition.type;

    return {
        value,
        label: formatFlagName(name),
        description,
    };
}

function argumentValueItems(definition: ArgumentDefinition, query: string): AutocompleteItem[] {
    if (definition.type === "boolean") {
        return [
            { value: "true", label: "true" },
            { value: "false", label: "false" },
        ].filter((item) => item.value.startsWith(query));
    }

    if (definition.type !== "enum") {
        return [];
    }

    return definition.values
        .filter((value) => value.startsWith(query))
        .map((value) => {
            const item: AutocompleteItem = { value, label: value };
            if (definition.description !== undefined) {
                item.description = definition.description;
            }
            return item;
        });
}

function valueCompletionForPreviousFlag(
    context: CommandLineContext,
): AutocompleteItem[] | undefined {
    if (context.previousToken === undefined) {
        return undefined;
    }
    if (!context.previousToken.startsWith("-")) {
        return undefined;
    }
    if (context.previousToken.includes("=")) {
        return undefined;
    }

    const lookup = buildFlagLookup(context.command);
    const name = lookup.get(normalizeFlagName(context.previousToken));
    if (name === undefined) {
        return undefined;
    }

    const definition = context.command.args[name];
    if (definition === undefined) {
        return undefined;
    }

    if (definition.type === "boolean") {
        return undefined;
    }

    const items = argumentValueItems(definition, context.currentPrefix);
    if (items.length === 0) {
        return undefined;
    }
    return items;
}

export function getTypedArgumentCompletions<
    TDefinitions extends Record<string, ArgumentDefinition>,
>(
    command: RegisteredTypedCommand<TDefinitions>,
    argumentPrefix: string,
): AutocompleteItem[] | null {
    const tokens = tokenizeLoose(argumentPrefix);
    const lastToken = tokens[tokens.length - 1];
    let query = "";
    if (lastToken !== undefined) {
        query = lastToken;
    }

    if (argumentPrefix.endsWith(" ")) {
        query = "";
    }

    const provided = providedArgumentNames(command, tokens);
    const items = Object.entries(command.args)
        .filter(([name]) => !provided.has(name))
        .map(([name, definition]) => flagItem(name, definition))
        .filter((item) => item.value.startsWith(query) || item.label.startsWith(query));

    if (items.length === 0) {
        return null;
    }
    return items;
}

function commandLineContext(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
): CommandLineContext | undefined {
    const line = lines[cursorLine];
    if (line === undefined) {
        return undefined;
    }

    const beforeCursor = line.slice(0, cursorCol);
    const match = /^\/(\S+)(?:\s+(.*))?$/.exec(beforeCursor);
    if (match === null) {
        return undefined;
    }

    const commandName = match[1];
    if (commandName === undefined) {
        return undefined;
    }

    const command = getTypedCommand(commandName);
    if (command === undefined) {
        return undefined;
    }

    let argsBeforeCursor = "";
    if (match[2] !== undefined) {
        argsBeforeCursor = match[2];
    }

    const tokens = tokenizeLoose(argsBeforeCursor);
    let currentPrefix = "";
    if (!argsBeforeCursor.endsWith(" ")) {
        const lastToken = tokens[tokens.length - 1];
        if (lastToken !== undefined) {
            currentPrefix = lastToken;
        }
    }

    let previousToken: string | undefined;
    if (argsBeforeCursor.endsWith(" ")) {
        previousToken = tokens[tokens.length - 1];
    } else {
        previousToken = tokens[tokens.length - 2];
    }

    const context: CommandLineContext = {
        command,
        argsBeforeCursor,
        currentPrefix,
    };
    if (previousToken !== undefined) {
        context.previousToken = previousToken;
    }
    return context;
}

export function getTypedAutocompleteSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
): AutocompleteSuggestions | undefined {
    const context = commandLineContext(lines, cursorLine, cursorCol);
    if (context === undefined) {
        return undefined;
    }

    const valueItems = valueCompletionForPreviousFlag(context);
    if (valueItems !== undefined) {
        return {
            items: valueItems,
            prefix: context.currentPrefix,
        };
    }

    const tokens = tokenizeLoose(context.argsBeforeCursor);
    const provided = providedArgumentNames(context.command, tokens);
    const flagItems = Object.entries(context.command.args)
        .filter(([name]) => !provided.has(name))
        .map(([name, definition]) => flagItem(name, definition))
        .filter(
            (item) =>
                item.value.startsWith(context.currentPrefix) ||
                item.label.startsWith(context.currentPrefix),
        );

    if (flagItems.length === 0) {
        return undefined;
    }

    return {
        items: flagItems,
        prefix: context.currentPrefix,
    };
}
