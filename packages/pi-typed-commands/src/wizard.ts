import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatFlagName } from "./names.js";
import type {
    ArgumentDefinition,
    ArgumentValue,
    ParsedCommandArguments,
    RegisteredTypedCommand,
    WizardMode,
} from "./types.js";
import { formatIssues } from "./usage.js";

const UNSET_OPTION = "— unset —";

type WizardState = Record<string, ArgumentValue>;

function issueNames(parsed: ParsedCommandArguments): Set<string> {
    const names = new Set<string>();
    for (const item of parsed.issues) {
        if (item.name !== undefined) {
            names.add(item.name);
        }
    }
    return names;
}

function shouldPromptArgument(
    name: string,
    definition: ArgumentDefinition,
    mode: WizardMode,
    parsed: ParsedCommandArguments,
): boolean {
    if (mode === "all") {
        return true;
    }

    if (issueNames(parsed).has(name)) {
        return true;
    }

    if (definition.required === true && parsed.values[name] === undefined) {
        return true;
    }

    return false;
}

function currentValueText(value: ArgumentValue): string {
    if (value === undefined) {
        return "unset";
    }
    return String(value);
}

function applyDefault(definition: ArgumentDefinition): ArgumentValue {
    if (definition.default !== undefined) {
        return definition.default;
    }
    return undefined;
}

function validateNumber(definition: ArgumentDefinition, raw: string): number | undefined {
    if (definition.type !== "number") {
        return undefined;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
        return undefined;
    }
    if (definition.integer === true && !Number.isInteger(value)) {
        return undefined;
    }
    if (definition.min !== undefined && value < definition.min) {
        return undefined;
    }
    if (definition.max !== undefined && value > definition.max) {
        return undefined;
    }
    return value;
}

async function promptEnum(
    name: string,
    definition: ArgumentDefinition,
    state: WizardState,
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    if (definition.type !== "enum") {
        return true;
    }

    const options = [...definition.values];
    if (definition.required !== true) {
        options.unshift(UNSET_OPTION);
    }

    const selected = await ctx.ui.select(`Set ${formatFlagName(name)}`, options);
    if (selected === undefined) {
        return false;
    }

    if (selected === UNSET_OPTION) {
        state[name] = applyDefault(definition);
        return true;
    }

    state[name] = selected;
    return true;
}

async function promptBoolean(
    name: string,
    definition: ArgumentDefinition,
    state: WizardState,
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    if (definition.type !== "boolean") {
        return true;
    }

    const options = ["true", "false"];
    if (definition.required !== true) {
        options.push(UNSET_OPTION);
    }

    const selected = await ctx.ui.select(`Set ${formatFlagName(name)}`, options);
    if (selected === undefined) {
        return false;
    }

    if (selected === UNSET_OPTION) {
        state[name] = applyDefault(definition);
        return true;
    }

    state[name] = selected === "true";
    return true;
}

async function promptStringLike(
    name: string,
    definition: ArgumentDefinition,
    state: WizardState,
    ctx: ExtensionCommandContext,
): Promise<boolean> {
    if (definition.type !== "string" && definition.type !== "number") {
        return true;
    }

    const current = state[name];
    const placeholder = definition.placeholder ?? currentValueText(current);

    const title = `Set ${formatFlagName(name)} (current: ${currentValueText(current)})`;
    const input = await ctx.ui.input(title, placeholder);
    if (input === undefined) {
        return false;
    }

    if (input.trim().length === 0) {
        if (current !== undefined) {
            return true;
        }
        const defaultValue = applyDefault(definition);
        if (defaultValue !== undefined) {
            state[name] = defaultValue;
            return true;
        }
        if (definition.required === true) {
            ctx.ui.notify(`${formatFlagName(name)} is required`, "error");
            return promptStringLike(name, definition, state, ctx);
        }
        state[name] = undefined;
        return true;
    }

    if (definition.type === "string") {
        state[name] = input;
        return true;
    }

    const numberValue = validateNumber(definition, input);
    if (numberValue === undefined) {
        ctx.ui.notify(`${formatFlagName(name)} expects a valid number`, "error");
        return promptStringLike(name, definition, state, ctx);
    }

    state[name] = numberValue;
    return true;
}

function finalIssues<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    state: WizardState,
): string[] {
    const messages: string[] = [];
    for (const [name, definition] of Object.entries(command.args)) {
        if (definition.required !== true) {
            continue;
        }
        if (state[name] !== undefined) {
            continue;
        }
        messages.push(`${formatFlagName(name)} is required`);
    }
    return messages;
}

export async function openArgumentWizard<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    parsed: ParsedCommandArguments,
    mode: WizardMode,
    ctx: ExtensionCommandContext,
): Promise<Record<string, ArgumentValue> | undefined> {
    const state: WizardState = { ...parsed.values };

    if (parsed.issues.length > 0) {
        ctx.ui.notify(formatIssues(parsed.issues.map((item) => item.message)), "warning");
    }

    for (const [name, definition] of Object.entries(command.args)) {
        if (!shouldPromptArgument(name, definition, mode, parsed)) {
            continue;
        }

        let completed = await promptEnum(name, definition, state, ctx);
        if (!completed) {
            return undefined;
        }
        completed = await promptBoolean(name, definition, state, ctx);
        if (!completed) {
            return undefined;
        }
        completed = await promptStringLike(name, definition, state, ctx);
        if (!completed) {
            return undefined;
        }
    }

    const messages = finalIssues(command, state);
    if (messages.length > 0) {
        ctx.ui.notify(formatIssues(messages), "error");
        return undefined;
    }

    return state;
}
