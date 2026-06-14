import { formatFlagName, toKebabCase } from "./names.js";
import {
    argumentTypeHint,
    argumentValueHint,
    formatArgumentDefault,
    isPositionalArgument,
    orderedCommandArgumentEntries,
} from "./schema.js";
import type { ArgumentDefinition, RegisteredTypedCommand } from "./types.js";

/** Style category for one segment of a typed command usage line. */
export type CommandUsagePartKind = "label" | "command" | "positional" | "flag" | "detail" | "muted";

/** One renderable segment of a typed command usage line. */
export type CommandUsagePart = {
    kind: CommandUsagePartKind;
    text: string;
};

type UsageFormatOptions = {
    showTypes?: boolean;
};

function positionalHint(
    name: string,
    definition: ArgumentDefinition,
    options: UsageFormatOptions,
): string {
    const label = toKebabCase(name);
    if (definition.type === "enum") {
        return `${label}:${definition.values.join(" | ")}`;
    }
    if (definition.type === "multi-enum") {
        return `${label}:${definition.values.join(" | ")}`;
    }
    if (options.showTypes === true && definition.type !== "boolean") {
        return `${label}:${argumentTypeHint(definition)}`;
    }
    return label;
}

function flagValueHint(
    name: string,
    definition: ArgumentDefinition,
    options: UsageFormatOptions,
): string {
    if (options.showTypes === true) {
        if (definition.type === "enum") {
            return definition.values.join(" | ");
        }
        if (definition.type === "multi-enum") {
            return definition.values.join(" | ");
        }
        return argumentTypeHint(definition);
    }
    if (definition.default !== undefined) {
        return "";
    }
    return definition.placeholder ?? toKebabCase(name);
}

function formatPositionalUsage(
    name: string,
    definition: ArgumentDefinition,
    options: UsageFormatOptions,
): string {
    const text = `${positionalHint(name, definition, options)}${formatArgumentDefault(definition)}`;
    if (definition.required === true) {
        return text;
    }
    return `[${text}]`;
}

function formatArgumentUsage(
    name: string,
    definition: ArgumentDefinition,
    options: UsageFormatOptions = {},
): string {
    if (isPositionalArgument(definition)) {
        return formatPositionalUsage(name, definition, options);
    }

    const flag = formatFlagName(name);
    let text: string;

    if (definition.type === "boolean") {
        text = flag;
    } else {
        const hint = flagValueHint(name, definition, options);
        if (hint.length === 0) {
            text = `${flag}${formatArgumentDefault(definition)}`;
        } else {
            text = `${flag}=${hint}${formatArgumentDefault(definition)}`;
        }
    }

    if (definition.required === true) {
        return text;
    }

    return `[${text}]`;
}

/** Format a compact usage string such as `/deploy env [--ref=main]`. */
export function formatCommandUsage<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    options: UsageFormatOptions = {},
): string {
    const parts = orderedCommandArgumentEntries(command).map(([name, definition]) =>
        formatArgumentUsage(name, definition, options),
    );
    if (parts.length === 0) {
        return `/${command.name}`;
    }
    return `/${command.name} ${parts.join(" ")}`;
}

/** Format the one-line editor helper text shown below the Pi editor. */
export function formatHelperLine<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    options: UsageFormatOptions = {},
): string {
    return `usage: ${formatCommandUsage(command, options)}`;
}

/** Format the editor helper as styled text segments for TUI rendering. */
export function formatHelperLineParts<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
    options: UsageFormatOptions = {},
): CommandUsagePart[] {
    const parts: CommandUsagePart[] = [
        { kind: "muted", text: "usage: " },
        { kind: "command", text: `/${command.name}` },
    ];

    for (const [name, definition] of orderedCommandArgumentEntries(command)) {
        parts.push({ kind: "muted", text: " " });
        const text = formatArgumentUsage(name, definition, options);
        let kind: CommandUsagePartKind = "flag";
        if (isPositionalArgument(definition)) {
            kind = "positional";
        }
        parts.push({ kind, text });
    }

    return parts;
}

/** Format detailed multi-line help for a registered typed command. */
export function formatDetailedHelp<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
): string {
    const lines = [
        `/${command.name}`,
        "",
        command.description,
        "",
        "Usage:",
        `  ${formatCommandUsage(command)}`,
    ];

    const entries = orderedCommandArgumentEntries(command);
    if (entries.length > 0) {
        lines.push("", "Arguments:");
        for (const [name, definition] of entries) {
            let label = `  ${formatFlagName(name)}`;
            if (isPositionalArgument(definition)) {
                label = `  ${toKebabCase(name)}`;
            }
            label += `: ${argumentValueHint(definition, name)}`;
            if (definition.required === true) {
                label += ", required";
            }
            if (definition.default !== undefined) {
                label += `, default ${String(definition.default)}`;
            }
            lines.push(label);
            if (definition.description !== undefined) {
                lines.push(`    ${definition.description}`);
            }
        }
    }

    return lines.join("\n");
}

/** Format issue messages as a bullet list for Pi notifications. */
export function formatIssues(messages: string[]): string {
    return messages.map((message) => `• ${message}`).join("\n");
}
