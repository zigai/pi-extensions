import { flattenGroupedArgumentDefinitions } from "./arguments.js";
import {
    applyArgumentDefault,
    booleanFromString,
    coerceArgumentValue,
    createArgumentLookup,
    createParseIssue,
    findArgumentName,
    formatArgumentFlagName,
    isPositionalArgument,
    orderedArgumentEntries,
    positionalArgumentEntries,
    validateArgumentValue,
    type ArgumentLookup,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    InferArguments,
    ParsedCommandArguments,
    ParseIssue,
    TypedCommandRefinement,
    TypedParseResult,
} from "./types.js";

/** Token produced from a raw typed-argument string. */
export type Token = {
    /** Parsed token value with surrounding quotes removed and supported escapes resolved. */
    value: string;
    /** Exact source slice that produced the token. */
    raw: string;
    /** Inclusive UTF-16 offset in the input. */
    start: number;
    /** Exclusive UTF-16 offset in the input. */
    end: number;
    /** Quote character used anywhere in the token, when present. */
    quote?: "'" | '"';
    /** Whether at least one escape sequence was consumed. */
    escaped: boolean;
};

/** Token stream produced from a raw typed-argument string. */
export type TokenizeResult = {
    /** Parsed tokens with quotes removed and escapes resolved. */
    tokens: string[];
    /** Whether the input ended before a quoted string was closed. */
    unterminatedQuote: boolean;
};

/** Lossless tokenization result used by completions and diagnostics that need source spans. */
export type LexResult = {
    tokens: Token[];
    unterminatedQuote: boolean;
};

type ParsedFlagToken = {
    flag: string;
    inlineValue?: string;
    isNoFlag?: boolean;
};

type ParsableTypedCommand<TDefinitions extends ArgumentDefinitions> = {
    args: TDefinitions;
    compiled?: {
        readonly arguments: readonly {
            readonly key: string;
            serialize(value: ArgumentValue): readonly string[];
            readonly definition: ArgumentDefinition;
        }[];
    };
    refine?: TypedCommandRefinement<TDefinitions>;
};

function isHelpTokenValue(value: string): boolean {
    return value === "--help" || value === "-h";
}

function isHelpToken(token: Token): boolean {
    return token.quote === undefined && isHelpTokenValue(token.value);
}

function isOutsideEscapeTarget(char: string): boolean {
    return /\s/.test(char) || char === "\\" || char === '"' || char === "'" || char === ",";
}

/** Lex typed-command arguments while preserving raw token spans and quote metadata. */
export function lexTypedArgumentString(input: string): LexResult {
    const tokens: Token[] = [];
    let current = "";
    let quote: "'" | '"' | undefined;
    let tokenQuote: "'" | '"' | undefined;
    let escaping = false;
    let escaped = false;
    let tokenStarted = false;
    let tokenStart = 0;

    const beginToken = (index: number): void => {
        if (tokenStarted) {
            return;
        }
        tokenStarted = true;
        tokenStart = index;
        current = "";
        tokenQuote = undefined;
        escaped = false;
    };

    const pushToken = (end: number): void => {
        if (!tokenStarted) {
            return;
        }
        const token: Token = {
            value: current,
            raw: input.slice(tokenStart, end),
            start: tokenStart,
            end,
            escaped,
        };
        if (tokenQuote !== undefined) {
            token.quote = tokenQuote;
        }
        tokens.push(token);
        tokenStarted = false;
        current = "";
        tokenQuote = undefined;
        escaped = false;
    };

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (char === undefined) {
            break;
        }

        if (escaping) {
            beginToken(index - 1);
            current += char;
            escaping = false;
            escaped = true;
            continue;
        }

        if (quote !== undefined) {
            beginToken(index);
            if (char === "\\") {
                escaping = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
                continue;
            }
            current += char;
            continue;
        }

        if (/\s/.test(char)) {
            pushToken(index);
            continue;
        }

        if (char === '"' || char === "'") {
            beginToken(index);
            quote = char;
            tokenQuote ??= char;
            continue;
        }

        if (char === "\\") {
            const next = input[index + 1];
            beginToken(index);
            if (next !== undefined && isOutsideEscapeTarget(next)) {
                current += next;
                index += 1;
                escaped = true;
                continue;
            }
            current += char;
            continue;
        }

        beginToken(index);
        current += char;
    }

    if (escaping) {
        beginToken(Math.max(0, input.length - 1));
        current += "\\";
    }
    pushToken(input.length);

    return {
        tokens,
        unterminatedQuote: quote !== undefined,
    };
}

/** Tokenize typed-command arguments using the same quote and escape rules as the parser. */
export function tokenizeTypedArgumentString(input: string): TokenizeResult {
    const result = lexTypedArgumentString(input);
    return {
        tokens: result.tokens.map((token) => token.value),
        unterminatedQuote: result.unterminatedQuote,
    };
}

function isFlagToken(token: Token): boolean {
    if (token.quote !== undefined && !token.raw.startsWith("-")) {
        return false;
    }
    if (token.value === "-") {
        return false;
    }
    if (token.value === "--") {
        return false;
    }
    return token.value.startsWith("-");
}

function parseLongFlag(token: string): { flag: string; inlineValue?: string; isNoFlag: boolean } {
    let flag = token.slice(2);
    let inlineValue: string | undefined;
    const equalsIndex = flag.indexOf("=");
    if (equalsIndex >= 0) {
        inlineValue = flag.slice(equalsIndex + 1);
        flag = flag.slice(0, equalsIndex);
    }

    let isNoFlag = false;
    if (flag.startsWith("no-")) {
        isNoFlag = true;
        flag = flag.slice(3);
    }

    const result: { flag: string; inlineValue?: string; isNoFlag: boolean } = { flag, isNoFlag };
    if (inlineValue !== undefined) {
        result.inlineValue = inlineValue;
    }
    return result;
}

function parseShortFlag(token: string): { flag: string; inlineValue?: string } {
    const body = token.slice(1);
    const equalsIndex = body.indexOf("=");
    if (equalsIndex < 0) {
        return { flag: body };
    }

    return {
        flag: body.slice(0, equalsIndex),
        inlineValue: body.slice(equalsIndex + 1),
    };
}

function isNumericToken(token: Token): boolean {
    if (token.value.trim().length === 0) {
        return false;
    }
    return Number.isFinite(Number(token.value));
}

function tokenCanBeValueForDefinition(token: Token, definition: ArgumentDefinition): boolean {
    if (!isFlagToken(token)) {
        return true;
    }
    return definition.type === "number" && isNumericToken(token);
}

function cloneDefaultValue(value: ArgumentValue): ArgumentValue {
    if (Array.isArray(value)) {
        return [...value];
    }
    return value;
}

class ArgumentParser<TDefinitions extends ArgumentDefinitions> {
    private readonly command: ParsableTypedCommand<TDefinitions>;
    private readonly rawArgs: string;
    private readonly result: ParsedCommandArguments = {
        values: {},
        provided: new Set<string>(),
        sources: new Map<string, "explicit" | "default">(),
        issues: [],
        mode: "run",
    };
    private lookup: ArgumentLookup | undefined;
    private tokens: Token[] = [];
    private readonly valueOccurrences = new Map<string, number>();
    private index = 0;
    private positionalIndex = 0;
    private optionsEnded = false;

    constructor(command: ParsableTypedCommand<TDefinitions>, rawArgs: string) {
        this.command = command;
        this.rawArgs = rawArgs;
    }

    parse(): ParsedCommandArguments {
        this.prepareTokens();
        if (this.result.mode === "help") {
            this.applyDefaults();
            return this.result;
        }

        this.lookup = createArgumentLookup(this.command.args);
        this.consumeTokens();
        this.applyDefaults();
        this.addValidationIssues();
        this.addRefinementIssues();
        return this.result;
    }

    private prepareTokens(): void {
        const tokenized = lexTypedArgumentString(this.rawArgs);
        if (tokenized.unterminatedQuote) {
            this.result.issues.push(
                createParseIssue("unterminated-quote", "Unterminated quote in arguments"),
            );
        }

        this.tokens = [];
        let optionsEnded = false;
        for (const token of tokenized.tokens) {
            if (!optionsEnded && token.quote === undefined && token.value === "--") {
                optionsEnded = true;
                this.tokens.push(token);
                continue;
            }
            if (!optionsEnded && isHelpToken(token)) {
                this.result.mode = "help";
                continue;
            }
            this.tokens.push(token);
        }
    }

    private consumeTokens(): void {
        while (this.index < this.tokens.length) {
            const token = this.tokens[this.index];
            if (token === undefined) {
                break;
            }

            if (!this.optionsEnded && token.quote === undefined && token.value === "--") {
                this.optionsEnded = true;
                this.index += 1;
                continue;
            }

            if (!this.optionsEnded && isFlagToken(token)) {
                const positional = positionalArgumentEntries(this.command.args)[
                    this.positionalIndex
                ];
                if (
                    positional?.[1].rest === true ||
                    (positional?.[1].type === "number" && isNumericToken(token))
                ) {
                    this.consumePositionalValue(token);
                    this.index += 1;
                    continue;
                }
                this.consumeFlagToken(token);
                continue;
            }

            this.consumePositionalValue(token);
            this.index += 1;
        }
    }

    private consumeFlagToken(token: Token): void {
        const lookup = this.requireLookup();
        let parsed: ParsedFlagToken;
        if (token.value.startsWith("--")) {
            parsed = parseLongFlag(token.value);
        } else {
            parsed = parseShortFlag(token.value);
        }
        const name = findArgumentName(lookup, parsed.flag);
        if (name === undefined) {
            this.result.issues.push(
                createParseIssue(
                    "unknown-argument",
                    `Unknown argument ${token.value}`,
                    undefined,
                    token.value,
                ),
            );
            this.index += 1;
            return;
        }

        const definition = lookup.definitions[name];
        if (definition === undefined) {
            this.result.issues.push(
                createParseIssue(
                    "unknown-argument",
                    `Unknown argument ${token.value}`,
                    name,
                    token.value,
                ),
            );
            this.index += 1;
            return;
        }

        this.markProvided(name);

        if (parsed.isNoFlag === true) {
            if (parsed.inlineValue !== undefined) {
                this.result.issues.push(
                    createParseIssue(
                        "invalid-value",
                        `${token.value} does not accept a value`,
                        name,
                        token.value,
                    ),
                );
                this.index += 1;
                return;
            }
            this.setBooleanValue(definition, name, false, true);
            this.index += 1;
            return;
        }

        if (parsed.inlineValue !== undefined) {
            this.consumeFlagValue(definition, name, parsed.inlineValue, token.value);
            this.index += 1;
            return;
        }

        if (definition.type === "boolean") {
            this.consumeBooleanFlagValue(definition, name);
            return;
        }

        const valueToken = this.tokens[this.index + 1];
        if (valueToken === undefined || !tokenCanBeValueForDefinition(valueToken, definition)) {
            this.result.issues.push(
                createParseIssue(
                    "missing-value",
                    `${formatArgumentFlagName(name, definition)} needs a value`,
                    name,
                    token.value,
                ),
            );
            this.index += 1;
            return;
        }

        this.consumeFlagValue(definition, name, valueToken.value, valueToken.raw);
        this.index += 2;
    }

    private consumeBooleanFlagValue(definition: ArgumentDefinition, name: string): void {
        const nextToken = this.tokens[this.index + 1];
        if (nextToken !== undefined && !isFlagToken(nextToken)) {
            const parsedBoolean = booleanFromString(nextToken.value);
            if (parsedBoolean !== undefined) {
                this.consumeFlagValue(definition, name, nextToken.value, nextToken.raw);
                this.index += 2;
                return;
            }
        }
        this.setBooleanValue(definition, name, true, false);
        this.index += 1;
    }

    private markProvided(name: string): void {
        this.result.provided.add(name);
        this.result.sources?.set(name, "explicit");
    }

    private occurrencePolicy(
        definition: ArgumentDefinition,
    ): "error" | "first" | "last" | "append" {
        if (definition.occurrence !== undefined) {
            return definition.occurrence;
        }
        if (definition.type === "multi-enum") {
            return "append";
        }
        return "error";
    }

    private duplicateValueIssue(name: string, definition: ArgumentDefinition): void {
        this.result.issues.push(
            createParseIssue(
                "duplicate-argument",
                `${formatArgumentFlagName(name, definition)} was provided more than once`,
                name,
            ),
        );
    }

    private setArgumentValue(
        definition: ArgumentDefinition,
        name: string,
        value: ArgumentValue,
    ): void {
        const occurrences = this.valueOccurrences.get(name) ?? 0;
        const policy = this.occurrencePolicy(definition);
        this.valueOccurrences.set(name, occurrences + 1);

        if (occurrences > 0) {
            if (policy === "error") {
                this.duplicateValueIssue(name, definition);
                return;
            }
            if (policy === "first") {
                return;
            }
        }

        if (definition.type === "multi-enum" && Array.isArray(value) && policy === "append") {
            let current: string[] = [];
            if (Array.isArray(this.result.values[name])) {
                current = this.result.values[name];
            }
            const next = [...current];
            for (const item of value) {
                if (!next.includes(item)) {
                    next.push(item);
                }
            }
            this.result.values[name] = next;
            return;
        }

        this.result.values[name] = value;
    }

    private setBooleanValue(
        definition: ArgumentDefinition,
        name: string,
        value: boolean,
        isNoFlag: boolean,
    ): boolean {
        this.markProvided(name);
        if (definition.type !== "boolean") {
            if (isNoFlag) {
                this.result.issues.push(
                    createParseIssue(
                        "invalid-value",
                        `${formatArgumentFlagName(name, definition)} is not a boolean flag`,
                        name,
                    ),
                );
                return false;
            }
            return false;
        }

        this.setArgumentValue(definition, name, value);
        return true;
    }

    private consumeFlagValue(
        definition: ArgumentDefinition,
        name: string,
        rawValue: string,
        rawToken: string,
    ): void {
        this.markProvided(name);
        const coerced = coerceArgumentValue(definition, rawValue, name);
        if (!coerced.ok) {
            this.result.issues.push(coerced.issue);
            return;
        }
        this.setArgumentValue(definition, name, coerced.value);
        if (rawToken.length === 0) {
            this.result.sources?.set(name, "explicit");
        }
    }

    private consumePositionalValue(token: Token): void {
        const entry = positionalArgumentEntries(this.command.args)[this.positionalIndex];
        if (entry === undefined) {
            this.result.issues.push(
                createParseIssue(
                    "unexpected-positional",
                    `Unexpected positional argument ${token.value}`,
                    undefined,
                    token.value,
                ),
            );
            return;
        }

        const [name, definition] = entry;
        if (definition.rest === true && definition.type === "string") {
            this.markProvided(name);
            const current = this.result.values[name];
            if (typeof current === "string" && current.length > 0) {
                this.result.values[name] = `${current} ${token.value}`;
            } else {
                this.result.values[name] = token.value;
            }
            return;
        }

        this.consumeFlagValue(definition, name, token.value, token.raw);
        if (definition.rest !== true) {
            this.positionalIndex += 1;
        }
    }

    private applyDefaults(): void {
        const definitions = flattenGroupedArgumentDefinitions(this.command.args);
        for (const [name, definition] of Object.entries(definitions)) {
            if (this.result.values[name] !== undefined || this.result.provided.has(name)) {
                continue;
            }
            const defaultValue = applyArgumentDefault(definition);
            if (defaultValue !== undefined) {
                this.result.values[name] = cloneDefaultValue(defaultValue);
                if (!this.result.provided.has(name)) {
                    this.result.sources?.set(name, "default");
                }
            }
        }
    }

    private addValidationIssues(): void {
        const definitions = flattenGroupedArgumentDefinitions(this.command.args);
        for (const [name, definition] of Object.entries(definitions)) {
            const value = this.result.values[name];
            const validation = validateArgumentValue(name, definition, value);
            if (validation.ok) {
                continue;
            }
            if (
                definition.required === true &&
                value === undefined &&
                this.result.provided.has(name)
            ) {
                continue;
            }
            let kind: ParseIssue["kind"] = "invalid-value";
            if (definition.required === true && value === undefined) {
                kind = "missing-required";
            }
            this.result.issues.push(createParseIssue(kind, validation.message, name));
        }
    }

    private addRefinementIssues(): void {
        const refine = this.command.refine;
        if (refine === undefined || this.result.issues.length > 0) {
            return;
        }
        const issues = refine(this.result.values as Partial<InferArguments<TDefinitions>>, {
            provided: this.result.provided as ReadonlySet<keyof TDefinitions & string>,
        });
        for (const issue of issues) {
            const name = issue.path?.[0];
            this.result.issues.push(createParseIssue("invalid-value", issue.message, name));
        }
    }

    private requireLookup(): ArgumentLookup {
        if (this.lookup === undefined) {
            throw new Error("Argument lookup has not been initialized");
        }
        return this.lookup;
    }
}

/** Quote one serialized CLI value when it would otherwise be split or parsed as syntax. */
export function quoteSerializedValue(value: string, force = false): string {
    if (
        !force &&
        value.length > 0 &&
        !/\s|["'\\]/.test(value) &&
        value !== "--" &&
        !isHelpTokenValue(value)
    ) {
        return value;
    }
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function serializeOneValue(
    definition: ArgumentDefinition,
    name: string,
    value: ArgumentValue,
    positional: boolean,
): string[] {
    if (value === undefined) {
        return [];
    }

    if (positional) {
        return [quoteSerializedValue(String(value), String(value).startsWith("-"))];
    }

    const flag = formatArgumentFlagName(name, definition);
    if (definition.type === "boolean") {
        if (value === true) {
            return [flag];
        }
        if (value === false) {
            return [`--no-${flag.slice(2)}`];
        }
        return [];
    }

    if (definition.type === "multi-enum" && Array.isArray(value)) {
        if (value.length === 0) {
            return [];
        }
        return [`${flag}=${quoteSerializedValue(value.join(","))}`];
    }

    return [`${flag}=${quoteSerializedValue(String(value))}`];
}

/** Serialize typed argument values into a raw string that `parseTypedCommandArgs` can read. */
export function serializeTypedCommandArgs<TDefinitions extends ArgumentDefinitions>(
    command: Pick<ParsableTypedCommand<TDefinitions>, "args" | "compiled">,
    values: Partial<InferArguments<TDefinitions>> | Record<string, ArgumentValue>,
): string {
    const parts: string[] = [];
    if (command.compiled !== undefined) {
        for (const argument of command.compiled.arguments) {
            const value = (values as Record<string, ArgumentValue>)[argument.key];
            if (isPositionalArgument(argument.definition)) {
                if (value !== undefined) {
                    parts.push(quoteSerializedValue(String(value), String(value).startsWith("-")));
                }
            } else {
                parts.push(...argument.serialize(value));
            }
        }
        return parts.join(" ");
    }

    for (const [name, definition] of orderedArgumentEntries(command.args)) {
        const value = (values as Record<string, ArgumentValue>)[name];
        parts.push(...serializeOneValue(definition, name, value, isPositionalArgument(definition)));
    }
    return parts.join(" ");
}

/**
 * Parse raw slash-command arguments without opening UI or invoking handlers.
 *
 * The returned legacy shape preserves partial values, defaults, provided argument names, syntax and
 * validation issues, and whether the user requested generated help.
 */
export function parseTypedCommandArgs<TDefinitions extends ArgumentDefinitions>(
    command: ParsableTypedCommand<TDefinitions>,
    rawArgs: string,
): ParsedCommandArguments {
    return new ArgumentParser(command, rawArgs).parse();
}

/** Convert a legacy parser result into the discriminated result returned by defined commands. */
export function toTypedParseResult<TDefinitions extends ArgumentDefinitions>(
    parsed: ParsedCommandArguments,
): TypedParseResult<TDefinitions> {
    if (parsed.mode === "help") {
        return { status: "help" };
    }
    if (parsed.issues.length > 0) {
        return {
            status: "error",
            issues: parsed.issues,
            partial: parsed.values as Partial<InferArguments<TDefinitions>>,
            provided: parsed.provided as ReadonlySet<keyof TDefinitions & string>,
        };
    }
    return {
        status: "success",
        value: parsed.values as InferArguments<TDefinitions>,
        provided: parsed.provided as ReadonlySet<keyof TDefinitions & string>,
        sources: (parsed.sources ?? new Map()) as ReadonlyMap<
            keyof TDefinitions & string,
            "explicit" | "default"
        >,
    };
}

/** Return whether a parsed command result contains at least one issue of the given kinds. */
export function hasIssuesOfKind(
    parsed: ParsedCommandArguments,
    kinds: ParseIssue["kind"][],
): boolean {
    for (const issueItem of parsed.issues) {
        if (kinds.includes(issueItem.kind)) {
            return true;
        }
    }
    return false;
}
