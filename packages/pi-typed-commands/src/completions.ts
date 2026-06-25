import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { casesHandled } from "./exhaustive.js";
import {
    lexTypedArgumentString,
    parseTypedCommandArgs,
    quoteSerializedValue,
    type Token,
} from "./parser.js";
import { getTypedCommand, getTypedCommands } from "./registry.js";
import {
    completionValuesForArgument,
    createArgumentLookup,
    findArgumentName,
    formatArgumentFlagName,
    isPositionalArgument,
    positionalArgumentEntries,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    MaybePromise,
    RegisteredTypedCommand,
    TypedCompletionContext,
} from "./types.js";

type CommandLineContext = {
    command: RegisteredTypedCommand;
    argsBeforeCursor: string;
    currentPrefix: string;
    replacementPrefix: string;
    cwd?: string;
    ctx?: ExtensionContext;
    previousToken?: Token;
};

type ValueCompletionItem = AutocompleteItem & {
    replacementReady?: boolean;
};

const DEFAULT_COMPLETION_TIMEOUT_MS = 1000;

function tokenizeLoose(input: string): Token[] {
    return lexTypedArgumentString(input).tokens;
}

function providedArgumentNames<TDefinitions extends ArgumentDefinitions>(
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

function completionInsertionValue(value: string): string {
    return quoteSerializedValue(value, value.startsWith("-"));
}

function flagConsumesValue(definition: ArgumentDefinition): boolean {
    switch (definition.type) {
        case "string":
        case "number":
        case "enum":
        case "multi-enum":
            return true;
        case "boolean":
            return false;
        default:
            return casesHandled(definition);
    }
}

function supportsRepeatedCompletion(definition: ArgumentDefinition): boolean {
    switch (definition.type) {
        case "string":
        case "number":
        case "boolean":
        case "enum":
            return false;
        case "multi-enum":
            return true;
        default:
            return casesHandled(definition);
    }
}

function mapValueItemsForInsertion(items: ValueCompletionItem[]): AutocompleteItem[] {
    return items.map((item) => {
        if (item.replacementReady === true) {
            return item;
        }
        return {
            ...item,
            value: completionInsertionValue(item.value),
        };
    });
}

function flagItem(name: string, definition: ArgumentDefinition): AutocompleteItem {
    let value = `${formatArgumentFlagName(name, definition)} `;
    if (!flagConsumesValue(definition)) {
        value = formatArgumentFlagName(name, definition);
    }

    const description = definition.description ?? definition.type;

    return {
        value,
        label: formatArgumentFlagName(name, definition),
        description,
    };
}

function isPromiseLike<T>(value: MaybePromise<T> | undefined): value is Promise<T> {
    return value !== undefined && typeof (value as { then?: unknown }).then === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedCompletionTimeoutMs(definition: ArgumentDefinition): number | undefined {
    const timeoutMs = definition.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    if (timeoutMs <= 0) {
        return undefined;
    }
    return timeoutMs;
}

type ProviderCompletionItem = {
    value: string;
    label?: string;
    description?: string;
    replacement?: string;
};

function normalizeProviderCompletionItems(value: unknown): ProviderCompletionItem[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const items: ProviderCompletionItem[] = [];
    for (const item of value) {
        if (!isRecord(item) || typeof item.value !== "string") {
            continue;
        }
        const normalized: ProviderCompletionItem = { value: item.value };
        if (typeof item.label === "string") {
            normalized.label = item.label;
        }
        if (typeof item.description === "string") {
            normalized.description = item.description;
        }
        if (typeof item.replacement === "string") {
            normalized.replacement = item.replacement;
        }
        items.push(normalized);
    }
    return items;
}

function mapProviderCompletionItems(value: unknown): ValueCompletionItem[] {
    return normalizeProviderCompletionItems(value).map((item) => {
        const mapped: ValueCompletionItem = {
            value: item.replacement ?? item.value,
            label: item.label ?? item.value,
            replacementReady: item.replacement !== undefined,
        };
        if (item.description !== undefined) {
            mapped.description = item.description;
        }
        return mapped;
    });
}

function withCompletionTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    controller: AbortController,
): Promise<T | undefined> {
    if (timeoutMs === undefined) {
        return promise.then(
            (value) => value,
            () => undefined,
        );
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            controller.abort();
            resolve(undefined);
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
        );
    });
}

function completionContext(
    context: CommandLineContext,
    signal?: AbortSignal,
): TypedCompletionContext {
    const parsed = parseTypedCommandArgs(context.command, context.argsBeforeCursor);
    const result: TypedCompletionContext = {
        values: parsed.values,
        provided: parsed.provided,
    };
    if (context.cwd !== undefined) {
        result.cwd = context.cwd;
    }
    if (context.ctx !== undefined) {
        result.ctx = context.ctx;
    }
    if (signal !== undefined) {
        result.signal = signal;
    }
    return result;
}

function providerArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
): MaybePromise<ValueCompletionItem[]> {
    if (definition.complete === undefined) {
        return [];
    }

    const controller = new AbortController();
    let completed: MaybePromise<readonly unknown[]>;
    try {
        completed = definition.complete(
            query,
            completionContext(context, controller.signal),
        ) as MaybePromise<readonly unknown[]>;
    } catch {
        controller.abort();
        return [];
    }

    if (isPromiseLike(completed)) {
        return withCompletionTimeout(
            completed,
            normalizedCompletionTimeoutMs(definition),
            controller,
        ).then((items) => mapProviderCompletionItems(items));
    }
    return mapProviderCompletionItems(completed);
}

function staticArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
): ValueCompletionItem[] {
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

function commandCompletionItems(query: string): AutocompleteItem[] {
    return getTypedCommands()
        .map((command) => `/${command.invocationName ?? command.name}`)
        .filter((value) => value.startsWith(query))
        .map((value) => ({ value, label: value, description: "typed command" }));
}

async function pathCompletionItems(query: string, cwd?: string): Promise<AutocompleteItem[]> {
    const root = cwd ?? process.cwd();
    let raw = query;
    if (raw.length === 0) {
        raw = ".";
    }
    let directoryPart = dirname(raw);
    let filePrefix = basename(raw);
    if (raw.endsWith("/")) {
        directoryPart = raw;
        filePrefix = "";
    }
    let lookupDirectory = join(root, directoryPart);
    if (isAbsolute(directoryPart)) {
        lookupDirectory = directoryPart;
    }
    let valuePrefix = "";
    if (raw.endsWith("/")) {
        valuePrefix = raw;
    } else if (directoryPart !== ".") {
        valuePrefix = `${directoryPart}/`;
    }

    try {
        const entries = await readdir(lookupDirectory, { withFileTypes: true });
        return entries
            .filter((entry) => entry.name.startsWith(filePrefix))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => {
                let value = `${valuePrefix}${entry.name}`;
                if (entry.isDirectory()) {
                    value += "/";
                }
                let label = entry.name;
                let description = "file";
                if (entry.isDirectory()) {
                    label = `${entry.name}/`;
                    description = "directory";
                }
                return {
                    value,
                    label,
                    description,
                };
            });
    } catch {
        return [];
    }
}

function argumentValueItems(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
): MaybePromise<ValueCompletionItem[]> {
    if (definition.complete !== undefined) {
        return providerArgumentValueItems(definition, query, context);
    }
    if (definition.ui?.widget === "path") {
        return pathCompletionItems(query, context.cwd);
    }
    if (definition.ui?.widget === "command") {
        return commandCompletionItems(query);
    }
    return staticArgumentValueItems(definition, query);
}

function syncItems<T>(items: MaybePromise<T> | undefined): T | undefined {
    if (items === undefined || isPromiseLike(items)) {
        return undefined;
    }
    return items;
}

function inlineFlagValueCompletion(
    context: CommandLineContext,
): MaybePromise<AutocompleteItem[] | undefined> {
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
    if (definition === undefined || !flagConsumesValue(definition)) {
        return undefined;
    }
    if (!supportsRepeatedCompletion(definition) && commaIndex >= 0) {
        return undefined;
    }

    const mapItems = (items: AutocompleteItem[]): AutocompleteItem[] | undefined => {
        const mapped = items.map((item) => ({
            ...item,
            value: `${flagToken}=${valuePrefix}${completionInsertionValue(item.value)}`,
        }));
        if (mapped.length === 0) {
            return undefined;
        }
        return mapped;
    };
    const items = argumentValueItems(definition, query, context);
    if (isPromiseLike(items)) {
        return items.then(mapItems);
    }
    return mapItems(items);
}

function valueCompletionForPreviousFlag(
    context: CommandLineContext,
): MaybePromise<AutocompleteItem[] | undefined> {
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

    if (!flagConsumesValue(definition)) {
        return undefined;
    }

    const mapItems = (items: AutocompleteItem[]): AutocompleteItem[] | undefined => {
        if (items.length === 0) {
            return undefined;
        }
        return mapValueItemsForInsertion(items);
    };
    const items = argumentValueItems(definition, context.currentPrefix, context);
    if (isPromiseLike(items)) {
        return items.then(mapItems);
    }
    return mapItems(items);
}

function hasEndOfOptions(tokens: Token[]): boolean {
    return tokens.some((token) => token.quote === undefined && token.value === "--");
}

function flagDefinitionForToken(
    command: RegisteredTypedCommand,
    token: Token | undefined,
): ArgumentDefinition | undefined {
    if (token === undefined || token.quote !== undefined || !token.value.startsWith("-")) {
        return undefined;
    }
    let flagToken = token.value;
    if (flagToken.includes("=")) {
        flagToken = flagToken.slice(0, flagToken.indexOf("="));
    }
    const lookup = createArgumentLookup(command.args);
    const name = findArgumentName(lookup, flagToken);
    if (name === undefined) {
        return undefined;
    }
    return command.args[name];
}

function currentTokenIsFlagValue(context: CommandLineContext): boolean {
    const previousDefinition = flagDefinitionForToken(context.command, context.previousToken);
    return (
        previousDefinition !== undefined &&
        flagConsumesValue(previousDefinition) &&
        context.previousToken?.value.includes("=") !== true
    );
}

function nextPositionalValueCompletion(
    context: CommandLineContext,
    tokens: Token[],
): MaybePromise<AutocompleteItem[] | undefined> {
    if (currentTokenIsFlagValue(context)) {
        return undefined;
    }
    const optionsEnded = hasEndOfOptions(tokens);
    if (!optionsEnded && context.currentPrefix.startsWith("-")) {
        return undefined;
    }

    const positionalEntries = positionalArgumentEntries(context.command.args);
    if (positionalEntries.length === 0) {
        return undefined;
    }

    let completedTokenCount = tokens.length - 1;
    if (context.argsBeforeCursor.endsWith(" ")) {
        completedTokenCount = tokens.length;
    }
    let positionalIndex = 0;
    let skipNextValue = false;
    let afterEndOfOptions = false;

    for (let index = 0; index < completedTokenCount; index += 1) {
        const token = tokens[index];
        if (token === undefined) {
            continue;
        }
        if (skipNextValue) {
            skipNextValue = false;
            continue;
        }
        if (!afterEndOfOptions && token.quote === undefined && token.value === "--") {
            afterEndOfOptions = true;
            continue;
        }
        let flagDefinition: ArgumentDefinition | undefined;
        if (!afterEndOfOptions) {
            flagDefinition = flagDefinitionForToken(context.command, token);
        }
        if (flagDefinition !== undefined) {
            if (flagConsumesValue(flagDefinition) && !token.value.includes("=")) {
                skipNextValue = true;
            }
            continue;
        }

        const currentEntry = positionalEntries[positionalIndex];
        if (currentEntry?.[1].rest !== true) {
            positionalIndex += 1;
        }
    }

    const entry = positionalEntries[positionalIndex];
    if (entry === undefined) {
        return undefined;
    }

    const [, definition] = entry;
    let query = context.currentPrefix;
    if (context.argsBeforeCursor.endsWith(" ")) {
        query = "";
    }
    const mapItems = (items: AutocompleteItem[]): AutocompleteItem[] | undefined => {
        if (items.length === 0) {
            return undefined;
        }
        return mapValueItemsForInsertion(items);
    };
    const items = argumentValueItems(definition, query, context);
    if (isPromiseLike(items)) {
        return items.then(mapItems);
    }
    return mapItems(items);
}

function shouldSuggestFlag(
    name: string,
    definition: ArgumentDefinition,
    provided: Set<string>,
): boolean {
    if (isPositionalArgument(definition)) {
        return false;
    }
    return !provided.has(name) || supportsRepeatedCompletion(definition);
}

type CompletionDecision = {
    items: AutocompleteItem[];
    prefix: string;
};

type CompletionBranch = (
    context: CommandLineContext,
    tokens: Token[],
) => MaybePromise<AutocompleteItem[] | undefined>;

const VALUE_COMPLETION_BRANCHES: readonly CompletionBranch[] = [
    (context) => inlineFlagValueCompletion(context),
    (context) => valueCompletionForPreviousFlag(context),
    (context, tokens) => nextPositionalValueCompletion(context, tokens),
];

function flagCompletionDecision(
    context: CommandLineContext,
    tokens: Token[],
): CompletionDecision | undefined {
    if (hasEndOfOptions(tokens)) {
        return undefined;
    }

    const provided = providedArgumentNames(context.command, tokens);
    const items = Object.entries(context.command.args)
        .filter(([name, definition]) => shouldSuggestFlag(name, definition, provided))
        .map(([name, definition]) => flagItem(name, definition))
        .filter(
            (item) =>
                item.value.startsWith(context.currentPrefix) ||
                item.label.startsWith(context.currentPrefix),
        );

    if (items.length === 0) {
        return undefined;
    }
    return { items, prefix: context.replacementPrefix };
}

async function resolveCompletionDecisionAsync(
    context: CommandLineContext,
    tokens: Token[],
): Promise<CompletionDecision | undefined> {
    for (const branch of VALUE_COMPLETION_BRANCHES) {
        const items = await branch(context, tokens);
        if (items !== undefined) {
            return { items, prefix: context.replacementPrefix };
        }
    }
    return flagCompletionDecision(context, tokens);
}

function resolveCompletionDecisionSync(
    context: CommandLineContext,
    tokens: Token[],
): CompletionDecision | undefined {
    for (const branch of VALUE_COMPLETION_BRANCHES) {
        const items = syncItems(branch(context, tokens));
        if (items !== undefined) {
            return { items, prefix: context.replacementPrefix };
        }
    }
    return flagCompletionDecision(context, tokens);
}

/**
 * Compute completions for Pi's command-level completion hook.
 *
 * Returns `null` when typed completions have no suggestion so Pi can continue its normal behavior.
 */
export function getTypedArgumentCompletions<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    argumentPrefix: string,
): MaybePromise<AutocompleteItem[] | null> {
    const tokens = tokenizeLoose(argumentPrefix);
    const lastToken = tokens[tokens.length - 1];
    let query = "";
    let replacementPrefix = "";
    if (lastToken !== undefined) {
        query = lastToken.value;
        replacementPrefix = lastToken.raw;
    }

    if (argumentPrefix.endsWith(" ")) {
        query = "";
        replacementPrefix = "";
    }

    let previousToken = tokens[tokens.length - 2];
    if (argumentPrefix.endsWith(" ")) {
        previousToken = tokens[tokens.length - 1];
    }
    const context: CommandLineContext = {
        command,
        argsBeforeCursor: argumentPrefix,
        currentPrefix: query,
        replacementPrefix,
        cwd: process.cwd(),
    };
    if (previousToken !== undefined) {
        context.previousToken = previousToken;
    }

    return resolveCompletionDecisionAsync(context, tokens).then(
        (decision) => decision?.items ?? null,
    );
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

    let argsBeforeCursor = "";
    if (match[2] !== undefined) {
        argsBeforeCursor = match[2];
    }

    const tokens = tokenizeLoose(argsBeforeCursor);
    let currentPrefix = "";
    let replacementPrefix = "";
    if (!argsBeforeCursor.endsWith(" ")) {
        const lastToken = tokens[tokens.length - 1];
        if (lastToken !== undefined) {
            currentPrefix = lastToken.value;
            replacementPrefix = lastToken.raw;
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
        replacementPrefix,
    };
    if (cwd !== undefined) {
        context.cwd = cwd;
    }
    if (ctx !== undefined) {
        context.ctx = ctx;
    }
    if (previousToken !== undefined) {
        context.previousToken = previousToken;
    }
    return context;
}

/**
 * Compute editor autocomplete suggestions for the slash command under the cursor.
 *
 * Returns `undefined` when the current editor state is not handled by typed-command UX.
 */
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
    const decision = resolveCompletionDecisionSync(context, tokens);
    if (decision === undefined) {
        return undefined;
    }
    return decision;
}
