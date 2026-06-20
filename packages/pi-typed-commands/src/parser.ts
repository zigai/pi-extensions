import { quoteSerializedValue } from "./behavior.js";
import { compileTypedCommandGrammar } from "./compiler.js";
import { normalizeFlagName } from "./names.js";
import {
    applyArgumentDefault,
    booleanFromString,
    createParseIssue,
    isPositionalArgument,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    CompiledCommand,
    InferArguments,
    ParsedCommandArguments,
    ParseIssue,
    RawArgumentOccurrence,
    TypedCommandRefinement,
    TypedParseResult,
} from "./types.js";

export { quoteSerializedValue };

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
    compiled?: CompiledCommand<TDefinitions>;
    refine?: TypedCommandRefinement<TDefinitions>;
};

type TypedCommandGrammar<TDefinitions extends ArgumentDefinitions> = CompiledCommand<TDefinitions>;

const grammarCache = new WeakMap<object, CompiledCommand>();

function commandGrammar<TDefinitions extends ArgumentDefinitions>(
    command: ParsableTypedCommand<TDefinitions>,
): TypedCommandGrammar<TDefinitions> {
    if (command.compiled !== undefined) {
        return command.compiled;
    }

    const cached = grammarCache.get(command);
    if (cached !== undefined) {
        return cached as TypedCommandGrammar<TDefinitions>;
    }

    const grammar = compileTypedCommandGrammar({
        name: "typed-command",
        description: "",
        args: command.args,
    });
    grammarCache.set(command, grammar);
    return grammar;
}

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

export function getTypedCommandRefinementIssues<TDefinitions extends ArgumentDefinitions>(
    command: { refine?: TypedCommandRefinement<TDefinitions> },
    values: Record<string, ArgumentValue>,
    provided: ReadonlySet<string>,
): ParseIssue[] {
    const refine = command.refine;
    if (refine === undefined) {
        return [];
    }
    const issues = refine(values as Partial<InferArguments<TDefinitions>>, {
        provided: provided as ReadonlySet<keyof TDefinitions & string>,
    });
    return issues.map((issue) => {
        const name = issue.path?.[0];
        return createParseIssue("invalid-value", issue.message, name);
    });
}

class ArgumentParser<TDefinitions extends ArgumentDefinitions> {
    private readonly command: ParsableTypedCommand<TDefinitions>;
    private readonly grammar: TypedCommandGrammar<TDefinitions>;
    private readonly rawArgs: string;
    private readonly result: ParsedCommandArguments = {
        values: {},
        provided: new Set<string>(),
        sources: new Map<string, "explicit" | "default">(),
        issues: [],
        mode: "run",
    };
    private readonly occurrencesByName = new Map<string, RawArgumentOccurrence[]>();
    private tokens: Token[] = [];
    private index = 0;
    private positionalIndex = 0;
    private optionsEnded = false;

    constructor(command: ParsableTypedCommand<TDefinitions>, rawArgs: string) {
        this.command = command;
        this.grammar = commandGrammar(command);
        this.rawArgs = rawArgs;
    }

    parse(): ParsedCommandArguments {
        this.prepareTokens();
        if (this.result.mode === "help") {
            this.applyDefaults();
            return this.result;
        }

        this.consumeTokens();
        this.decodeOccurrences();
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

    private currentPositionalArgument():
        | { name: string; definition: ArgumentDefinition }
        | undefined {
        const name = this.grammar.positionalOrder[this.positionalIndex];
        if (name === undefined) {
            return undefined;
        }
        const argument = this.grammar.argumentByName.get(name);
        if (argument === undefined) {
            return undefined;
        }
        return { name, definition: argument.definition };
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
                const positional = this.currentPositionalArgument();
                if (
                    positional?.definition.rest === true ||
                    (positional?.definition.type === "number" && isNumericToken(token))
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

    private findArgumentName(flag: string): string | undefined {
        return this.grammar.flagToName.get(normalizeFlagName(flag));
    }

    private argumentDefinition(name: string): ArgumentDefinition | undefined {
        return this.grammar.argumentByName.get(name)?.definition;
    }

    private addOccurrence(name: string, occurrence: RawArgumentOccurrence): void {
        this.markProvided(name);
        const current = this.occurrencesByName.get(name) ?? [];
        current.push(occurrence);
        this.occurrencesByName.set(name, current);
    }

    private addRestStringOccurrence(name: string, token: Token): void {
        this.markProvided(name);
        const current = this.occurrencesByName.get(name) ?? [];
        const existing = current[0];
        if (existing !== undefined) {
            existing.raw = `${existing.raw ?? ""} ${token.value}`;
            existing.token = `${existing.token ?? ""} ${token.raw}`;
            return;
        }
        current.push({ source: "positional", raw: token.value, token: token.raw });
        this.occurrencesByName.set(name, current);
    }

    private consumeFlagToken(token: Token): void {
        let parsed: ParsedFlagToken;
        if (token.value.startsWith("--")) {
            parsed = parseLongFlag(token.value);
        } else {
            parsed = parseShortFlag(token.value);
        }
        const name = this.findArgumentName(parsed.flag);
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

        const definition = this.argumentDefinition(name);
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

        if (parsed.isNoFlag === true) {
            const occurrence: RawArgumentOccurrence = {
                source: "flag",
                negated: true,
                token: token.value,
            };
            if (parsed.inlineValue !== undefined) {
                occurrence.raw = parsed.inlineValue;
            }
            this.addOccurrence(name, occurrence);
            this.index += 1;
            return;
        }

        if (parsed.inlineValue !== undefined) {
            this.addOccurrence(name, {
                source: "flag",
                raw: parsed.inlineValue,
                token: token.value,
            });
            this.index += 1;
            return;
        }

        if (definition.type === "boolean") {
            this.consumeBooleanFlagValue(name);
            return;
        }

        const valueToken = this.tokens[this.index + 1];
        if (valueToken === undefined || !tokenCanBeValueForDefinition(valueToken, definition)) {
            this.addOccurrence(name, { source: "flag", token: token.value });
            this.index += 1;
            return;
        }

        this.addOccurrence(name, {
            source: "flag",
            raw: valueToken.value,
            token: valueToken.raw,
        });
        this.index += 2;
    }

    private consumeBooleanFlagValue(name: string): void {
        const nextToken = this.tokens[this.index + 1];
        if (nextToken !== undefined && !isFlagToken(nextToken)) {
            const parsedBoolean = booleanFromString(nextToken.value);
            if (parsedBoolean !== undefined) {
                this.addOccurrence(name, {
                    source: "flag",
                    raw: nextToken.value,
                    token: nextToken.raw,
                });
                this.index += 2;
                return;
            }
        }
        this.addOccurrence(name, { source: "flag" });
        this.index += 1;
    }

    private markProvided(name: string): void {
        this.result.provided.add(name);
        this.result.sources?.set(name, "explicit");
    }

    private consumePositionalValue(token: Token): void {
        const entry = this.currentPositionalArgument();
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

        const { name, definition } = entry;
        if (definition.rest === true && definition.type === "string") {
            this.addRestStringOccurrence(name, token);
            return;
        }

        this.addOccurrence(name, {
            source: "positional",
            raw: token.value,
            token: token.raw,
        });
        if (definition.rest !== true) {
            this.positionalIndex += 1;
        }
    }

    private decodeOccurrences(): void {
        for (const [name, occurrences] of this.occurrencesByName) {
            const argument = this.grammar.argumentByName.get(name);
            if (argument === undefined) {
                continue;
            }
            const decoded = argument.decode(occurrences);
            if (decoded.value !== undefined) {
                this.result.values[name] = decoded.value;
            }
            if (!decoded.ok) {
                this.result.issues.push(...decoded.issues);
            }
        }
    }

    private applyDefaults(): void {
        for (const argument of this.grammar.arguments) {
            const name = argument.key;
            if (this.result.values[name] !== undefined || this.result.provided.has(name)) {
                continue;
            }
            const defaultValue = applyArgumentDefault(argument.definition);
            if (defaultValue !== undefined) {
                this.result.values[name] = cloneDefaultValue(defaultValue);
                if (!this.result.provided.has(name)) {
                    this.result.sources?.set(name, "default");
                }
            }
        }
    }

    private addValidationIssues(): void {
        for (const argument of this.grammar.arguments) {
            const value = this.result.values[argument.key];
            const validationIssues = argument.validate(value);
            for (const issue of validationIssues) {
                if (
                    issue.kind === "missing-required" &&
                    value === undefined &&
                    this.result.provided.has(argument.key)
                ) {
                    continue;
                }
                this.result.issues.push(issue);
            }
        }
    }

    private addRefinementIssues(): void {
        if (this.result.issues.length > 0) {
            return;
        }
        this.result.issues.push(
            ...getTypedCommandRefinementIssues(
                this.command,
                this.result.values,
                this.result.provided,
            ),
        );
    }
}

/** Serialize typed argument values into a raw string that `parseTypedCommandArgs` can read. */
export function serializeTypedCommandArgs<TDefinitions extends ArgumentDefinitions>(
    command: Pick<ParsableTypedCommand<TDefinitions>, "args" | "compiled">,
    values: Partial<InferArguments<TDefinitions>> | Record<string, ArgumentValue>,
): string {
    const grammar = commandGrammar(command);
    const parts: string[] = [];
    for (const argument of grammar.arguments) {
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
