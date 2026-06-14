import { formatFlagName } from "./names.js";
import {
    applyArgumentDefaults,
    booleanFromString,
    coerceArgumentValue,
    createArgumentLookup,
    createParseIssue,
    findArgumentName,
    positionalArgumentEntries,
    validateArgumentValue,
    type ArgumentLookup,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ParsedCommandArguments,
    ParseIssue,
    RegisteredTypedCommand,
} from "./types.js";

export type TokenizeResult = {
    tokens: string[];
    unterminatedQuote: boolean;
};

type ParsedFlagToken = {
    flag: string;
    inlineValue?: string;
    isNoFlag?: boolean;
};

function isHelpToken(token: string): boolean {
    return token === "--help" || token === "-h";
}

export function tokenizeTypedArgumentString(input: string): TokenizeResult {
    const tokens: string[] = [];
    let current = "";
    let quote: string | undefined;
    let escaping = false;

    for (const char of input) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === "\\") {
            escaping = true;
            continue;
        }

        if (quote !== undefined) {
            if (char === quote) {
                quote = undefined;
                continue;
            }
            current += char;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }

        current += char;
    }

    if (escaping) {
        current += "\\";
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return {
        tokens,
        unterminatedQuote: quote !== undefined,
    };
}

function isFlagToken(token: string): boolean {
    if (token === "-") {
        return false;
    }
    if (token === "--") {
        return false;
    }
    return token.startsWith("-");
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

function isNumericToken(token: string): boolean {
    if (token.trim().length === 0) {
        return false;
    }
    return Number.isFinite(Number(token));
}

function tokenCanBeValueForDefinition(token: string, definition: ArgumentDefinition): boolean {
    if (!isFlagToken(token)) {
        return true;
    }
    return definition.type === "number" && isNumericToken(token);
}

class ArgumentParser<TDefinitions extends ArgumentDefinitions> {
    private readonly command: RegisteredTypedCommand<TDefinitions>;
    private readonly rawArgs: string;
    private readonly result: ParsedCommandArguments = {
        values: {},
        provided: new Set<string>(),
        issues: [],
        mode: "run",
    };
    private lookup: ArgumentLookup | undefined;
    private tokens: string[] = [];
    private index = 0;
    private positionalIndex = 0;
    private optionsEnded = false;

    constructor(command: RegisteredTypedCommand<TDefinitions>, rawArgs: string) {
        this.command = command;
        this.rawArgs = rawArgs;
    }

    parse(): ParsedCommandArguments {
        const trimmed = this.rawArgs.trim();
        if (isHelpToken(trimmed)) {
            this.result.mode = "help";
            this.applyDefaults();
            return this.result;
        }

        this.prepareTokens();
        if (this.result.mode === "help") {
            this.applyDefaults();
            return this.result;
        }

        this.lookup = createArgumentLookup(this.command.args);
        this.consumeTokens();
        this.applyDefaults();
        this.addValidationIssues();
        return this.result;
    }

    private prepareTokens(): void {
        const tokenized = tokenizeTypedArgumentString(this.rawArgs);
        if (tokenized.unterminatedQuote) {
            this.result.issues.push(
                createParseIssue("unterminated-quote", "Unterminated quote in arguments"),
            );
        }

        this.tokens = [];
        let optionsEnded = false;
        for (const token of tokenized.tokens) {
            if (!optionsEnded && token === "--") {
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

            if (!this.optionsEnded && token === "--") {
                this.optionsEnded = true;
                this.index += 1;
                continue;
            }

            if (!this.optionsEnded && isFlagToken(token)) {
                const positional = positionalArgumentEntries(this.command.args)[
                    this.positionalIndex
                ];
                if (positional?.[1].type === "number" && isNumericToken(token)) {
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

    private consumeFlagToken(token: string): void {
        const lookup = this.requireLookup();
        let parsed: ParsedFlagToken;
        if (token.startsWith("--")) {
            parsed = parseLongFlag(token);
        } else {
            parsed = parseShortFlag(token);
        }
        const name = findArgumentName(lookup, parsed.flag);
        if (name === undefined) {
            this.result.issues.push(
                createParseIssue("unknown-argument", `Unknown argument ${token}`, undefined, token),
            );
            this.index += 1;
            return;
        }

        const definition = lookup.definitions[name];
        if (definition === undefined) {
            this.result.issues.push(
                createParseIssue("unknown-argument", `Unknown argument ${token}`, name, token),
            );
            this.index += 1;
            return;
        }

        if (parsed.isNoFlag === true) {
            this.setBooleanValue(definition, name, false, true);
            this.index += 1;
            return;
        }

        if (parsed.inlineValue !== undefined) {
            this.consumeFlagValue(definition, name, parsed.inlineValue);
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
                    `${formatFlagName(name)} needs a value`,
                    name,
                    token,
                ),
            );
            this.index += 1;
            return;
        }

        this.consumeFlagValue(definition, name, valueToken);
        this.index += 2;
    }

    private consumeBooleanFlagValue(definition: ArgumentDefinition, name: string): void {
        const nextToken = this.tokens[this.index + 1];
        if (nextToken !== undefined && !isFlagToken(nextToken)) {
            const parsedBoolean = booleanFromString(nextToken);
            if (parsedBoolean !== undefined) {
                this.consumeFlagValue(definition, name, nextToken);
                this.index += 2;
                return;
            }
        }
        this.setBooleanValue(definition, name, true, false);
        this.index += 1;
    }

    private setBooleanValue(
        definition: ArgumentDefinition,
        name: string,
        value: boolean,
        isNoFlag: boolean,
    ): boolean {
        if (definition.type !== "boolean") {
            if (isNoFlag) {
                this.result.issues.push(
                    createParseIssue(
                        "invalid-value",
                        `${formatFlagName(name)} is not a boolean flag`,
                        name,
                    ),
                );
                return false;
            }
            return false;
        }

        this.result.values[name] = value;
        this.result.provided.add(name);
        return true;
    }

    private consumeFlagValue(definition: ArgumentDefinition, name: string, rawValue: string): void {
        const coerced = coerceArgumentValue(definition, rawValue, name);
        if (!coerced.ok) {
            this.result.issues.push(coerced.issue);
            return;
        }
        if (definition.type === "multi-enum" && Array.isArray(coerced.value)) {
            let current: string[] = [];
            if (Array.isArray(this.result.values[name])) {
                current = this.result.values[name];
            }
            this.result.values[name] = [...current, ...coerced.value];
            this.result.provided.add(name);
            return;
        }

        this.result.values[name] = coerced.value;
        this.result.provided.add(name);
    }

    private consumePositionalValue(token: string): void {
        const entry = positionalArgumentEntries(this.command.args)[this.positionalIndex];
        if (entry === undefined) {
            this.result.issues.push(
                createParseIssue(
                    "unexpected-positional",
                    `Unexpected positional argument ${token}`,
                    undefined,
                    token,
                ),
            );
            return;
        }

        const [name, definition] = entry;
        this.consumeFlagValue(definition, name, token);
        this.positionalIndex += 1;
    }

    private applyDefaults(): void {
        this.result.values = applyArgumentDefaults(this.command.args, this.result.values);
    }

    private addValidationIssues(): void {
        for (const [name, definition] of Object.entries(this.command.args)) {
            const value = this.result.values[name];
            const validation = validateArgumentValue(name, definition, value);
            if (validation.ok) {
                continue;
            }
            let kind: ParseIssue["kind"] = "invalid-value";
            if (definition.required === true && value === undefined) {
                kind = "missing-required";
            }
            this.result.issues.push(createParseIssue(kind, validation.message, name));
        }
    }

    private requireLookup(): ArgumentLookup {
        if (this.lookup === undefined) {
            throw new Error("Argument lookup has not been initialized");
        }
        return this.lookup;
    }
}

/**
 * Parse a raw Pi slash-command argument string for a registered typed command.
 *
 * The result contains parsed values, applied defaults, provided argument names, issues, and the
 * requested mode (`run` or `help`). This function does not open UI or call handlers.
 */
export function parseTypedCommandArgs<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    rawArgs: string,
): ParsedCommandArguments {
    return new ArgumentParser(command, rawArgs).parse();
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
