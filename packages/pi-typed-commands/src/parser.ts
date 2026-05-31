import { formatFlagName, normalizeFlagName, toKebabCase } from "./names.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    ParsedCommandArguments,
    ParseIssue,
    RegisteredTypedCommand,
} from "./types.js";

type TokenizeResult = {
    tokens: string[];
    unterminatedQuote: boolean;
};

type ArgumentLookup = {
    byFlag: Map<string, string>;
    definitions: ArgumentDefinitions;
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

function createArgumentLookup(definitions: ArgumentDefinitions): ArgumentLookup {
    const byFlag = new Map<string, string>();

    for (const [name, definition] of Object.entries(definitions)) {
        byFlag.set(normalizeFlagName(name), name);
        byFlag.set(toKebabCase(name), name);
        if (definition.aliases !== undefined) {
            for (const alias of definition.aliases) {
                byFlag.set(normalizeFlagName(alias), name);
            }
        }
    }

    return { byFlag, definitions };
}

function findArgumentName(lookup: ArgumentLookup, flag: string): string | undefined {
    return lookup.byFlag.get(normalizeFlagName(flag));
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

function booleanFromString(value: string): boolean | undefined {
    const normalized = value.toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "n", "off"].includes(normalized)) {
        return false;
    }
    return undefined;
}

function issue(
    kind: ParseIssue["kind"],
    message: string,
    name?: string,
    token?: string,
): ParseIssue {
    const result: ParseIssue = { kind, message };
    if (name !== undefined) {
        result.name = name;
    }
    if (token !== undefined) {
        result.token = token;
    }
    return result;
}

function coerceValue(
    definition: ArgumentDefinition,
    raw: string,
    name: string,
): { value?: ArgumentValue; issue?: ParseIssue } {
    if (definition.type === "string") {
        return { value: raw };
    }

    if (definition.type === "boolean") {
        const parsed = booleanFromString(raw);
        if (parsed === undefined) {
            return {
                issue: issue(
                    "invalid-value",
                    `${formatFlagName(name)} expects a boolean value`,
                    name,
                    raw,
                ),
            };
        }
        return { value: parsed };
    }

    if (definition.type === "number") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
            return {
                issue: issue(
                    "invalid-value",
                    `${formatFlagName(name)} expects a number`,
                    name,
                    raw,
                ),
            };
        }
        if (definition.integer === true && !Number.isInteger(parsed)) {
            return {
                issue: issue(
                    "invalid-value",
                    `${formatFlagName(name)} expects an integer`,
                    name,
                    raw,
                ),
            };
        }
        if (definition.min !== undefined && parsed < definition.min) {
            return {
                issue: issue(
                    "invalid-value",
                    `${formatFlagName(name)} must be at least ${definition.min}`,
                    name,
                    raw,
                ),
            };
        }
        if (definition.max !== undefined && parsed > definition.max) {
            return {
                issue: issue(
                    "invalid-value",
                    `${formatFlagName(name)} must be at most ${definition.max}`,
                    name,
                    raw,
                ),
            };
        }
        return { value: parsed };
    }

    if (!definition.values.includes(raw)) {
        return {
            issue: issue(
                "invalid-value",
                `${formatFlagName(name)} must be one of: ${definition.values.join(", ")}`,
                name,
                raw,
            ),
        };
    }

    return { value: raw };
}

function applyDefaults(result: ParsedCommandArguments, definitions: ArgumentDefinitions): void {
    for (const [name, definition] of Object.entries(definitions)) {
        if (result.values[name] !== undefined) {
            continue;
        }
        if (definition.default !== undefined) {
            result.values[name] = definition.default;
        }
    }
}

function addMissingRequiredIssues(
    result: ParsedCommandArguments,
    definitions: ArgumentDefinitions,
): void {
    for (const [name, definition] of Object.entries(definitions)) {
        if (definition.required !== true) {
            continue;
        }
        if (result.values[name] !== undefined) {
            continue;
        }
        result.issues.push(issue("missing-required", `${formatFlagName(name)} is required`, name));
    }
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

function setBooleanValue(
    result: ParsedCommandArguments,
    definition: ArgumentDefinition,
    name: string,
    value: boolean,
    isNoFlag: boolean,
): boolean {
    if (definition.type !== "boolean") {
        if (isNoFlag) {
            result.issues.push(
                issue("invalid-value", `${formatFlagName(name)} is not a boolean flag`, name),
            );
            return false;
        }
        return false;
    }

    result.values[name] = value;
    result.provided.add(name);
    return true;
}

function consumeFlagValue(
    result: ParsedCommandArguments,
    definition: ArgumentDefinition,
    name: string,
    rawValue: string,
): void {
    const coerced = coerceValue(definition, rawValue, name);
    if (coerced.issue !== undefined) {
        result.issues.push(coerced.issue);
        return;
    }
    result.values[name] = coerced.value;
    result.provided.add(name);
}

function parseFlagToken(
    tokens: string[],
    index: number,
    lookup: ArgumentLookup,
    result: ParsedCommandArguments,
): number {
    const token = tokens[index];
    if (token === undefined) {
        return index + 1;
    }

    let parsed: { flag: string; inlineValue?: string; isNoFlag?: boolean };
    if (token.startsWith("--")) {
        parsed = parseLongFlag(token);
    } else {
        parsed = parseShortFlag(token);
    }

    const name = findArgumentName(lookup, parsed.flag);
    if (name === undefined) {
        result.issues.push(
            issue("unknown-argument", `Unknown argument ${token}`, undefined, token),
        );
        return index + 1;
    }

    const definition = lookup.definitions[name];
    if (definition === undefined) {
        result.issues.push(issue("unknown-argument", `Unknown argument ${token}`, name, token));
        return index + 1;
    }

    if (parsed.isNoFlag === true) {
        setBooleanValue(result, definition, name, false, true);
        return index + 1;
    }

    if (parsed.inlineValue !== undefined) {
        consumeFlagValue(result, definition, name, parsed.inlineValue);
        return index + 1;
    }

    if (definition.type === "boolean") {
        const nextToken = tokens[index + 1];
        if (nextToken !== undefined && !isFlagToken(nextToken)) {
            const parsedBoolean = booleanFromString(nextToken);
            if (parsedBoolean !== undefined) {
                consumeFlagValue(result, definition, name, nextToken);
                return index + 2;
            }
        }
        setBooleanValue(result, definition, name, true, false);
        return index + 1;
    }

    const valueToken = tokens[index + 1];
    if (valueToken === undefined || isFlagToken(valueToken)) {
        result.issues.push(
            issue("missing-value", `${formatFlagName(name)} needs a value`, name, token),
        );
        return index + 1;
    }

    consumeFlagValue(result, definition, name, valueToken);
    return index + 2;
}

export function parseTypedCommandArgs<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    rawArgs: string,
): ParsedCommandArguments {
    const trimmed = rawArgs.trim();
    const result: ParsedCommandArguments = {
        values: {},
        provided: new Set<string>(),
        issues: [],
        mode: "run",
    };

    if (trimmed === command.manualWizardToken) {
        result.mode = "wizard";
        applyDefaults(result, command.args);
        return result;
    }

    if (trimmed === command.helpToken || trimmed === "--help" || trimmed === "-h") {
        result.mode = "help";
        applyDefaults(result, command.args);
        return result;
    }

    const tokenized = tokenize(rawArgs);
    if (tokenized.unterminatedQuote) {
        result.issues.push(issue("unterminated-quote", "Unterminated quote in arguments"));
    }

    const tokens: string[] = [];
    for (const token of tokenized.tokens) {
        if (token === command.helpToken || token === "--help" || token === "-h") {
            result.mode = "help";
            continue;
        }
        if (token === command.manualWizardToken) {
            if (result.mode !== "help") {
                result.mode = "wizard";
            }
            continue;
        }
        tokens.push(token);
    }

    if (result.mode === "help") {
        applyDefaults(result, command.args);
        return result;
    }

    const lookup = createArgumentLookup(command.args);
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index];
        if (token === undefined) {
            break;
        }

        if (isFlagToken(token)) {
            index = parseFlagToken(tokens, index, lookup, result);
            continue;
        }

        result.issues.push(
            issue(
                "unexpected-positional",
                `Unexpected positional argument ${token}`,
                undefined,
                token,
            ),
        );
        index += 1;
    }

    applyDefaults(result, command.args);
    addMissingRequiredIssues(result, command.args);
    return result;
}

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
