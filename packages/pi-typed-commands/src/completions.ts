import Type, { type Static } from "typebox";
import Schema from "./typebox-schema.js";
import { casesHandled } from "./exhaustive.js";
import {
    lexTypedArgumentString,
    parseTypedCommandArgs,
    quoteSerializedValue,
    type Token,
} from "./parser.js";
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
    CoreRegisteredTypedCommand,
    TypedCommandLookup,
    TypedCompletionContext,
    TypedCompletionItem,
} from "./types.js";

export type CompletionPathLookup = {
    complete(query: string, cwd: string): Promise<readonly TypedCompletionItem[]>;
};

export type CompletionScheduler = {
    run<T>(
        work: (signal: AbortSignal) => Promise<T>,
        timeoutMs: number | undefined,
    ): Promise<T | undefined>;
};

export type CompletionTaskOwner = {
    /** Retain the task until settlement and install rejection observation before returning. */
    own(task: Promise<unknown>): void;
};

export type CompletionCapabilities = {
    readonly cwd: string;
    readonly paths: CompletionPathLookup;
    readonly commands: TypedCommandLookup;
    readonly scheduler: CompletionScheduler;
    readonly completionTasks: CompletionTaskOwner;
};

export type FormValueCompletionContext = {
    readonly values: Readonly<Record<string, import("./types.js").ArgumentValue>>;
    readonly provided: ReadonlySet<string>;
};

type CommandLineContext = {
    command: CoreRegisteredTypedCommand;
    argsBeforeCursor: string;
    currentPrefix: string;
    replacementPrefix: string;
    capabilities: CompletionCapabilities;
    previousToken?: Token;
};

type ValueCompletionItem = TypedCompletionItem & {
    replacementReady?: boolean;
};

const DEFAULT_COMPLETION_TIMEOUT_MS = 1000;

const UnknownCompletionItemsSchema = Type.Array(Type.Unknown());
const CompletionReplacementRangeSchema = Type.Object(
    {
        start: Type.Integer({ minimum: 0 }),
        end: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
const ProviderCompletionItemSchema = Type.Object(
    {
        value: Type.String(),
        label: Type.Optional(Type.Unknown()),
        description: Type.Optional(Type.Unknown()),
        replacement: Type.Optional(Type.Unknown()),
        replaceRange: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: true },
);

type ProviderCompletionItemBoundary = Static<typeof ProviderCompletionItemSchema>;
type ProviderCompletionItem = {
    value: string;
    label?: string;
    description?: string;
    replacement?: string;
    replaceRange?: { readonly start: number; readonly end: number };
};

function tokenizeLoose(input: string): readonly Token[] {
    return lexTypedArgumentString(input).tokens;
}

function providedArgumentNames<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
    tokens: readonly Token[],
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
        case "string-list":
        case "key-value":
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
        case "string-list":
        case "key-value":
            return true;
        default:
            return casesHandled(definition);
    }
}

function mapValueItemsForInsertion(items: ValueCompletionItem[]): TypedCompletionItem[] {
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

function flagItem(name: string, definition: ArgumentDefinition): TypedCompletionItem {
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

function hasCallableThen(value: unknown): boolean {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return false;
    }
    return "then" in value && typeof value.then === "function";
}

function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
    return value instanceof Promise;
}

function normalizedCompletionTimeoutMs(definition: ArgumentDefinition): number | undefined {
    const timeoutMs = definition.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    if (timeoutMs <= 0) {
        return undefined;
    }
    return timeoutMs;
}

function normalizeProviderCompletionItems(value: unknown): ProviderCompletionItem[] {
    if (!Schema.Check(UnknownCompletionItemsSchema, value)) {
        return [];
    }
    const items: ProviderCompletionItem[] = [];
    for (const item of value) {
        if (!Schema.Check(ProviderCompletionItemSchema, item)) {
            continue;
        }
        const boundaryItem: ProviderCompletionItemBoundary = item;
        const normalized: ProviderCompletionItem = { value: boundaryItem.value };
        if (typeof boundaryItem.label === "string") {
            normalized.label = boundaryItem.label;
        }
        if (typeof boundaryItem.description === "string") {
            normalized.description = boundaryItem.description;
        }
        if (typeof boundaryItem.replacement === "string") {
            normalized.replacement = boundaryItem.replacement;
        }
        if (
            Schema.Check(CompletionReplacementRangeSchema, boundaryItem.replaceRange) &&
            boundaryItem.replaceRange.start <= boundaryItem.replaceRange.end
        ) {
            normalized.replaceRange = Schema.Parse(
                CompletionReplacementRangeSchema,
                boundaryItem.replaceRange,
            );
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
        if (item.replaceRange !== undefined) {
            mapped.replaceRange = item.replaceRange;
        }
        return mapped;
    });
}

function completionContext(
    context: CommandLineContext,
    signal?: AbortSignal,
): TypedCompletionContext {
    const parsed = parseTypedCommandArgs(context.command, context.argsBeforeCursor);
    if (signal === undefined) {
        return {
            values: parsed.values,
            provided: parsed.provided,
            cwd: context.capabilities.cwd,
        };
    }
    return {
        values: parsed.values,
        provided: parsed.provided,
        cwd: context.capabilities.cwd,
        signal,
    };
}

function syncProviderArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
): ValueCompletionItem[] {
    if (definition.complete === undefined) {
        return [];
    }

    try {
        const completed: unknown = definition.complete(query, completionContext(context));
        if (hasCallableThen(completed)) {
            context.capabilities.completionTasks.own(Promise.resolve(completed));
            return [];
        }
        return mapProviderCompletionItems(completed);
    } catch {
        return [];
    }
}

async function asyncProviderArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
): Promise<ValueCompletionItem[]> {
    const completeAsync = definition.completeAsync;
    if (completeAsync === undefined) {
        return syncProviderArgumentValueItems(definition, query, context);
    }
    const completed = await context.capabilities.scheduler.run(
        (signal) => completeAsync(query, completionContext(context, signal)),
        normalizedCompletionTimeoutMs(definition),
    );
    return mapProviderCompletionItems(completed);
}

function staticArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
): ValueCompletionItem[] {
    return completionValuesForArgument(definition)
        .filter((value) => value.startsWith(query))
        .map((value) => {
            const item: TypedCompletionItem = { value, label: value };
            if (definition.description !== undefined) {
                item.description = definition.description;
            }
            return item;
        });
}

function commandCompletionItems(
    query: string,
    commands: TypedCommandLookup,
): TypedCompletionItem[] {
    return commands
        .list()
        .map((command) => `/${command.invocationName ?? command.name}`)
        .filter((value) => value.startsWith(query))
        .map((value) => ({ value, label: value, description: "typed command" }));
}

async function pathCompletionItems(
    query: string,
    capabilities: CompletionCapabilities,
): Promise<TypedCompletionItem[]> {
    try {
        return [...(await capabilities.paths.complete(query, capabilities.cwd))];
    } catch {
        return [];
    }
}

/** Resolve one form field's value suggestions through the same providers used by the editor. */
export async function getTypedFormValueCompletions(
    definition: ArgumentDefinition,
    query: string,
    form: FormValueCompletionContext,
    capabilities: CompletionCapabilities,
): Promise<readonly TypedCompletionItem[]> {
    const providerContext: TypedCompletionContext = {
        values: form.values,
        provided: form.provided,
        cwd: capabilities.cwd,
    };
    if (definition.completeAsync !== undefined) {
        const completed = await capabilities.scheduler.run(
            (signal) =>
                definition.completeAsync?.(query, { ...providerContext, signal }) ??
                Promise.resolve([]),
            normalizedCompletionTimeoutMs(definition),
        );
        return normalizeProviderCompletionItems(completed);
    }
    if (definition.complete !== undefined) {
        try {
            const completed: unknown = definition.complete(query, providerContext);
            if (hasCallableThen(completed)) {
                capabilities.completionTasks.own(Promise.resolve(completed));
                return [];
            }
            return normalizeProviderCompletionItems(completed);
        } catch {
            return [];
        }
    }
    if (
        definition.ui?.widget === "path" ||
        definition.ui?.widget === "file" ||
        definition.ui?.widget === "directory"
    ) {
        return pathCompletionItems(query, capabilities);
    }
    if (definition.ui?.widget === "command") {
        return commandCompletionItems(query, capabilities.commands);
    }
    return staticArgumentValueItems(definition, query);
}

function syncArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
): ValueCompletionItem[] {
    if (definition.complete !== undefined) {
        return syncProviderArgumentValueItems(definition, query, context);
    }
    if (definition.ui?.widget === "command") {
        return commandCompletionItems(query, context.capabilities.commands);
    }
    return staticArgumentValueItems(definition, query);
}

async function asyncArgumentValueItems(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
): Promise<ValueCompletionItem[]> {
    if (definition.completeAsync !== undefined) {
        return asyncProviderArgumentValueItems(definition, query, context);
    }
    if (definition.ui?.widget === "path") {
        return pathCompletionItems(query, context.capabilities);
    }
    return syncArgumentValueItems(definition, query, context);
}

function argumentValueItemsForMode(
    definition: ArgumentDefinition,
    query: string,
    context: CommandLineContext,
    mode: "async" | "sync",
): ValueCompletionItem[] | Promise<ValueCompletionItem[]> {
    if (mode === "async") {
        return asyncArgumentValueItems(definition, query, context);
    }
    return syncArgumentValueItems(definition, query, context);
}

function inlineFlagValueCompletion(
    context: CommandLineContext,
    mode: "async" | "sync",
): TypedCompletionItem[] | Promise<TypedCompletionItem[] | undefined> | undefined {
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

    const mapItems = (items: TypedCompletionItem[]): TypedCompletionItem[] | undefined => {
        const mapped = items.map((item) => ({
            ...item,
            value: `${flagToken}=${valuePrefix}${completionInsertionValue(item.value)}`,
        }));
        if (mapped.length === 0) {
            return undefined;
        }
        return mapped;
    };
    const items = argumentValueItemsForMode(definition, query, context, mode);
    if (isPromiseLike(items)) {
        return items.then(mapItems);
    }
    return mapItems(items);
}

function valueCompletionForPreviousFlag(
    context: CommandLineContext,
    mode: "async" | "sync",
): TypedCompletionItem[] | Promise<TypedCompletionItem[] | undefined> | undefined {
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

    const mapItems = (items: TypedCompletionItem[]): TypedCompletionItem[] | undefined => {
        if (items.length === 0) {
            return undefined;
        }
        return mapValueItemsForInsertion(items);
    };
    const items = argumentValueItemsForMode(definition, context.currentPrefix, context, mode);
    if (isPromiseLike(items)) {
        return items.then(mapItems);
    }
    return mapItems(items);
}

function hasEndOfOptions(tokens: readonly Token[]): boolean {
    return tokens.some((token) => token.quote === undefined && token.value === "--");
}

function flagDefinitionForToken(
    command: CoreRegisteredTypedCommand,
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
    tokens: readonly Token[],
    mode: "async" | "sync",
): TypedCompletionItem[] | Promise<TypedCompletionItem[] | undefined> | undefined {
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
    const mapItems = (items: TypedCompletionItem[]): TypedCompletionItem[] | undefined => {
        if (items.length === 0) {
            return undefined;
        }
        return mapValueItemsForInsertion(items);
    };
    const items = argumentValueItemsForMode(definition, query, context, mode);
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

export type CompletionDecision = {
    readonly items: readonly TypedCompletionItem[];
    readonly prefix: string;
};

type CompletionBranch = (
    context: CommandLineContext,
    tokens: readonly Token[],
    mode: "async" | "sync",
) => TypedCompletionItem[] | Promise<TypedCompletionItem[] | undefined> | undefined;

const VALUE_COMPLETION_BRANCHES: readonly CompletionBranch[] = [
    (context, _tokens, mode) => inlineFlagValueCompletion(context, mode),
    (context, _tokens, mode) => valueCompletionForPreviousFlag(context, mode),
    (context, tokens, mode) => nextPositionalValueCompletion(context, tokens, mode),
];

function flagCompletionDecision(
    context: CommandLineContext,
    tokens: readonly Token[],
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
                (item.label ?? item.value).startsWith(context.currentPrefix),
        );

    if (items.length === 0) {
        return undefined;
    }
    return { items, prefix: context.replacementPrefix };
}

async function resolveCompletionDecisionAsync(
    context: CommandLineContext,
    tokens: readonly Token[],
): Promise<CompletionDecision | undefined> {
    for (const branch of VALUE_COMPLETION_BRANCHES) {
        const items = await branch(context, tokens, "async");
        if (items !== undefined) {
            return { items, prefix: context.replacementPrefix };
        }
    }
    return flagCompletionDecision(context, tokens);
}

function resolveCompletionDecisionSync(
    context: CommandLineContext,
    tokens: readonly Token[],
): CompletionDecision | undefined {
    for (const branch of VALUE_COMPLETION_BRANCHES) {
        const items = branch(context, tokens, "sync");
        if (items !== undefined && !isPromiseLike(items)) {
            return { items, prefix: context.replacementPrefix };
        }
    }
    return flagCompletionDecision(context, tokens);
}

function subcommandItems(
    command: CoreRegisteredTypedCommand,
    query: string,
): TypedCompletionItem[] {
    const items: TypedCompletionItem[] = [];
    for (const [name, subcommand] of Object.entries(command.subcommands ?? {})) {
        for (const spelling of [name, ...(subcommand.aliases ?? [])]) {
            if (spelling.startsWith(query)) {
                items.push({
                    value: `${spelling} `,
                    label: spelling,
                    description: subcommand.description,
                });
            }
        }
    }
    return items;
}

function subcommandCompletionDecision(context: CommandLineContext): CompletionDecision | undefined {
    if (context.command.subcommands === undefined) {
        return undefined;
    }
    const tokens = lexTypedArgumentString(context.argsBeforeCursor).tokens;
    const first = tokens[0];
    if (first === undefined) {
        return { items: subcommandItems(context.command, ""), prefix: "" };
    }
    if (first.value.startsWith("-")) {
        return undefined;
    }
    const selected = Object.entries(context.command.subcommands).find(
        ([name, subcommand]) =>
            name === first.value || subcommand.aliases?.includes(first.value) === true,
    );
    if (selected !== undefined) {
        return undefined;
    }
    if (tokens.length === 1 && !context.argsBeforeCursor.endsWith(" ")) {
        return {
            items: subcommandItems(context.command, first.value),
            prefix: first.raw,
        };
    }
    return { items: [], prefix: context.replacementPrefix };
}

function selectedSubcommandContext(context: CommandLineContext): CommandLineContext {
    const subcommands = context.command.subcommands;
    if (subcommands === undefined) {
        return context;
    }
    const first = lexTypedArgumentString(context.argsBeforeCursor).tokens[0];
    if (first === undefined) {
        return context;
    }
    const selected = Object.entries(subcommands).find(
        ([name, subcommand]) =>
            name === first.value || subcommand.aliases?.includes(first.value) === true,
    );
    if (selected === undefined) {
        return context;
    }
    const argsBeforeCursor = context.argsBeforeCursor.slice(first.end).trimStart();
    const tokens = lexTypedArgumentString(argsBeforeCursor).tokens;
    const last = tokens[tokens.length - 1];
    const trailingSpace = argsBeforeCursor.endsWith(" ");
    let currentPrefix = last?.value ?? "";
    let replacementPrefix = last?.raw ?? "";
    let previousToken = tokens[tokens.length - 2];
    if (trailingSpace) {
        currentPrefix = "";
        replacementPrefix = "";
        previousToken = last;
    }
    const selectedContext: CommandLineContext = {
        command: selected[1],
        argsBeforeCursor,
        currentPrefix,
        replacementPrefix,
        capabilities: context.capabilities,
    };
    if (previousToken !== undefined) {
        selectedContext.previousToken = previousToken;
    }
    return selectedContext;
}

/**
 * Compute completions for Pi's command-level completion hook.
 *
 * Returns `null` when typed completions have no suggestion so Pi can continue its normal behavior.
 */
export function getTypedArgumentCompletions<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
    argumentPrefix: string,
    capabilities: CompletionCapabilities,
): Promise<readonly TypedCompletionItem[] | null> {
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
        capabilities,
    };
    if (previousToken !== undefined) {
        context.previousToken = previousToken;
    }

    const subcommandDecision = subcommandCompletionDecision(context);
    if (subcommandDecision !== undefined) {
        return Promise.resolve(subcommandDecision.items);
    }
    const selectedContext = selectedSubcommandContext(context);
    return resolveCompletionDecisionAsync(
        selectedContext,
        tokenizeLoose(selectedContext.argsBeforeCursor),
    ).then((decision) => decision?.items ?? null);
}

function commandLineContext(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    capabilities: CompletionCapabilities,
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

    const command = capabilities.commands.get(commandName);
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
        capabilities,
    };
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
    capabilities: CompletionCapabilities,
): CompletionDecision | undefined {
    const context = commandLineContext(lines, cursorLine, cursorCol, capabilities);
    if (context === undefined) {
        return undefined;
    }

    const subcommandDecision = subcommandCompletionDecision(context);
    if (subcommandDecision !== undefined) {
        return subcommandDecision;
    }
    const selectedContext = selectedSubcommandContext(context);
    const tokens = tokenizeLoose(selectedContext.argsBeforeCursor);
    const decision = resolveCompletionDecisionSync(selectedContext, tokens);
    if (decision === undefined) {
        return undefined;
    }
    return decision;
}

/** Resolve editor completion decisions, including async providers and path lookup. */
export async function getTypedAutocompleteSuggestionsAsync(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    capabilities: CompletionCapabilities,
): Promise<CompletionDecision | undefined> {
    const context = commandLineContext(lines, cursorLine, cursorCol, capabilities);
    if (context === undefined) {
        return undefined;
    }
    const subcommandDecision = subcommandCompletionDecision(context);
    if (subcommandDecision !== undefined) {
        return subcommandDecision;
    }
    const selectedContext = selectedSubcommandContext(context);
    return resolveCompletionDecisionAsync(
        selectedContext,
        tokenizeLoose(selectedContext.argsBeforeCursor),
    );
}
