import { formatFlagName } from "./names.js";
import {
    applyArgumentDefaults,
    booleanFromString,
    coerceArgumentValue,
    createArgumentLookup,
    createParseIssue,
    findArgumentName,
    positionalArgumentEntries,
    type ArgumentLookup,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ParsedCommandArguments,
    ParseIssue,
    RegisteredTypedCommand,
} from "./types.js";

type TokenizeResult = {
    tokens: string[];
    unterminatedQuote: boolean;
};

type ParsedFlagToken = {
    flag: string;
    inlineValue?: string;
    isNoFlag?: boolean;
};

function tokenize(input: string): TokenizeResult {
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

    constructor(command: RegisteredTypedCommand<TDefinitions>, rawArgs: string) {
        this.command = command;
        this.rawArgs = rawArgs;
    }

    parse(): ParsedCommandArguments {
        const trimmed = this.rawArgs.trim();
        if (trimmed === this.command.manualFormToken) {
            this.result.mode = "form";
            this.applyDefaults();
            return this.result;
        }

        if (trimmed === this.command.helpToken || trimmed === "--help" || trimmed === "-h") {
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
        this.addMissingRequiredIssues();
        return this.result;
    }

    private prepareTokens(): void {
        const tokenized = tokenize(this.rawArgs);
        if (tokenized.unterminatedQuote) {
            this.result.issues.push(
                createParseIssue("unterminated-quote", "Unterminated quote in arguments"),
            );
        }

        this.tokens = [];
        for (const token of tokenized.tokens) {
            if (token === this.command.helpToken || token === "--help" || token === "-h") {
                this.result.mode = "help";
                continue;
            }
            if (token === this.command.manualFormToken) {
                if (this.result.mode !== "help") {
                    this.result.mode = "form";
                }
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

            if (isFlagToken(token)) {
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
        if (valueToken === undefined || isFlagToken(valueToken)) {
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

    private addMissingRequiredIssues(): void {
        for (const [name, definition] of Object.entries(this.command.args)) {
            if (definition.required !== true) {
                continue;
            }
            if (this.result.values[name] !== undefined) {
                continue;
            }
            this.result.issues.push(
                createParseIssue("missing-required", `${formatFlagName(name)} is required`, name),
            );
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
 * requested mode (`run`, `form`, or `help`). This function does not open UI or call handlers.
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
