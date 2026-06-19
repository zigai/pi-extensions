import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { lexTypedArgumentString, type Token } from "./parser.js";
import { getTypedCommand, isTypedCommandEnabled } from "./registry.js";
import {
    completionValuesForArgument,
    createArgumentLookup,
    findArgumentName,
    formatArgumentFlagName,
    isPositionalArgument,
} from "./schema.js";
import type { ArgumentDefinition, RegisteredTypedCommand } from "./types.js";

type CommandLineContext = {
    command: RegisteredTypedCommand;
    argsBeforeCursor: string;
    currentPrefix: string;
    previousToken?: Token;
};

function tokenizeLoose(input: string): Token[] {
    return lexTypedArgumentString(input).tokens;
}

function providedArgumentNames<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    tokens: Token[],
): Set<string> {
    const lookup = createArgumentLookup(command.args);
    const provided = new Set<string>();
    let optionsEnded = false;

    for (const token of tokens) {
        if (token.quote === undefined && token.value === "--") {
            optionsEnded = true;
            continue;
        }
        if (optionsEnded || token.quote !== undefined || !token.value.startsWith("-")) {
            continue;
        }

        let flag = token.value;
        const equalsIndex = flag.indexOf("=");
        if (equalsIndex >= 0) {
            flag = flag.slice(0, equalsIndex);
        }
        if (flag.startsWith("--no-")) {
            flag = `--${flag.slice(5)}`;
        }

        const name = findArgumentName(lookup, flag);
        if (name !== undefined) {
            provided.add(name);
        }
    }

    return provided;
}

function flagItem(name: string, definition: ArgumentDefinition): AutocompleteItem {
    let value = `${formatArgumentFlagName(name, definition)} `;
    if (definition.type === "boolean") {
        value = formatArgumentFlagName(name, definition);
    }

    const description = definition.description ?? definition.type;

    return {
        value,
        label: formatArgumentFlagName(name, definition),
        description,
    };
}

function argumentValueItems(definition: ArgumentDefinition, query: string): AutocompleteItem[] {
    return completionValuesForArgument(definition)
        .filter((value) => value.startsWith(query))
        .map((value) => {
            const item: AutocompleteItem = { value, label: value };
            if (definition.description !== undefined) {
                item.description = definition.description;
            }
            return item;
        });
}

function inlineFlagValueCompletion(context: CommandLineContext): AutocompleteItem[] | undefined {
    if (!context.currentPrefix.startsWith("-")) {
        return undefined;
    }

    const equalsIndex = context.currentPrefix.indexOf("=");
    if (equalsIndex < 0) {
        return undefined;
    }

    const flagToken = context.currentPrefix.slice(0, equalsIndex);
    const rawQuery = context.currentPrefix.slice(equalsIndex + 1);
    const commaIndex = rawQuery.lastIndexOf(",");
    let query = rawQuery;
    let valuePrefix = "";
    if (commaIndex >= 0) {
        query = rawQuery.slice(commaIndex + 1);
        valuePrefix = rawQuery.slice(0, commaIndex + 1);
    }

    const lookup = createArgumentLookup(context.command.args);
    const name = findArgumentName(lookup, flagToken);
    if (name === undefined) {
        return undefined;
    }

    const definition = context.command.args[name];
    if (definition === undefined || definition.type === "boolean") {
        return undefined;
    }
    if (definition.type !== "multi-enum" && commaIndex >= 0) {
        return undefined;
    }

    const items = argumentValueItems(definition, query).map((item) => ({
        ...item,
        value: `${flagToken}=${valuePrefix}${item.value}`,
    }));
    if (items.length === 0) {
        return undefined;
    }
    return items;
}

function valueCompletionForPreviousFlag(
    context: CommandLineContext,
): AutocompleteItem[] | undefined {
    if (context.previousToken === undefined) {
        return undefined;
    }
    if (context.previousToken.quote !== undefined || !context.previousToken.value.startsWith("-")) {
        return undefined;
    }
    if (context.previousToken.value.includes("=")) {
        return undefined;
    }

    const lookup = createArgumentLookup(context.command.args);
    const name = findArgumentName(lookup, context.previousToken.value);
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

function shouldSuggestFlag(
    name: string,
    definition: ArgumentDefinition,
    provided: Set<string>,
): boolean {
    if (isPositionalArgument(definition)) {
        return false;
    }
    return !provided.has(name) || definition.type === "multi-enum";
}

function hasEndOfOptions(tokens: Token[]): boolean {
    return tokens.some((token) => token.quote === undefined && token.value === "--");
}

export function getTypedArgumentCompletions<
    TDefinitions extends Record<string, ArgumentDefinition>,
>(
    command: RegisteredTypedCommand<TDefinitions>,
    argumentPrefix: string,
): AutocompleteItem[] | null {
    if (!isTypedCommandEnabled(command, undefined, process.cwd())) {
        return null;
    }

    const tokens = tokenizeLoose(argumentPrefix);
    const lastToken = tokens[tokens.length - 1];
    let query = "";
    if (lastToken !== undefined) {
        query = lastToken.value;
    }

    if (argumentPrefix.endsWith(" ")) {
        query = "";
    }

    if (hasEndOfOptions(tokens)) {
        return null;
    }

    let previousToken = tokens[tokens.length - 2];
    if (argumentPrefix.endsWith(" ")) {
        previousToken = tokens[tokens.length - 1];
    }
    const context: CommandLineContext = {
        command: command as RegisteredTypedCommand,
        argsBeforeCursor: argumentPrefix,
        currentPrefix: query,
    };
    if (previousToken !== undefined) {
        context.previousToken = previousToken;
    }

    const inlineValueItems = inlineFlagValueCompletion(context);
    if (inlineValueItems !== undefined) {
        return inlineValueItems;
    }
    const valueItems = valueCompletionForPreviousFlag(context);
    if (valueItems !== undefined) {
        return valueItems;
    }

    const provided = providedArgumentNames(command, tokens);
    const items = Object.entries(command.args)
        .filter(([name, definition]) => shouldSuggestFlag(name, definition, provided))
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
    cwd?: string,
    ctx?: ExtensionContext,
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
    if (!isTypedCommandEnabled(command, ctx, cwd)) {
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
            currentPrefix = lastToken.value;
        }
    }

    let previousToken: Token | undefined;
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
    cwd?: string,
    ctx?: ExtensionContext,
): AutocompleteSuggestions | undefined {
    const context = commandLineContext(lines, cursorLine, cursorCol, cwd, ctx);
    if (context === undefined) {
        return undefined;
    }

    const tokens = tokenizeLoose(context.argsBeforeCursor);
    if (hasEndOfOptions(tokens)) {
        return undefined;
    }

    const inlineValueItems = inlineFlagValueCompletion(context);
    if (inlineValueItems !== undefined) {
        return {
            items: inlineValueItems,
            prefix: context.currentPrefix,
        };
    }

    const valueItems = valueCompletionForPreviousFlag(context);
    if (valueItems !== undefined) {
        return {
            items: valueItems,
            prefix: context.currentPrefix,
        };
    }

    const provided = providedArgumentNames(context.command, tokens);
    const flagItems = Object.entries(context.command.args)
        .filter(([name, definition]) => shouldSuggestFlag(name, definition, provided))
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
