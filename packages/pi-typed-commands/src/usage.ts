import { toKebabCase } from "./names.js";
import { casesHandled } from "./exhaustive.js";
import {
    argumentFlagNames,
    argumentTypeHint,
    argumentValueHint,
    formatArgumentDefault,
    formatArgumentFlagName,
    isPositionalArgument,
    orderedCommandArgumentEntries,
} from "./schema.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    CoreRegisteredTypedCommand,
} from "./types.js";

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

/** Metadata switches for detailed help output. */
export type DetailedHelpMetadataOptions = {
    types?: boolean;
    defaults?: boolean;
    required?: boolean;
    aliases?: boolean;
    descriptions?: boolean;
    enumValues?: boolean;
};

/** Options for generated detailed help output. */
export type DetailedHelpFormatOptions = {
    metadata?: DetailedHelpMetadataOptions;
    order?: "definition" | "required-first";
};

type ResolvedDetailedHelpMetadataOptions = Required<DetailedHelpMetadataOptions>;

const DEFAULT_DETAILED_HELP_METADATA: ResolvedDetailedHelpMetadataOptions = {
    types: true,
    defaults: true,
    required: true,
    aliases: false,
    descriptions: true,
    enumValues: true,
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

    const flag = formatArgumentFlagName(name, definition);
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
export function formatCommandUsage<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
    options: UsageFormatOptions = {},
): string {
    const parts = orderedCommandArgumentEntries(command).map(([name, definition]) =>
        formatArgumentUsage(name, definition, options),
    );
    const commandName = command.invocationName ?? command.name;
    if (command.subcommands !== undefined) {
        let subcommandToken = "<subcommand>";
        if (command.hasRootHandler === true) {
            subcommandToken = "[<subcommand>]";
        }
        let sharedArguments = "";
        if (parts.length > 0) {
            sharedArguments = ` ${parts.join(" ")}`;
        }
        return `/${commandName} ${subcommandToken}${sharedArguments}`;
    }
    if (parts.length === 0) {
        return `/${commandName}`;
    }
    return `/${commandName} ${parts.join(" ")}`;
}

/** Format the one-line editor helper text shown below the Pi editor. */
export function formatHelperLine<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
    options: UsageFormatOptions = {},
): string {
    return `usage: ${formatCommandUsage(command, options)}`;
}

/** Format the editor helper as styled text segments for TUI rendering. */
export function formatHelperLineParts<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
    options: UsageFormatOptions = {},
): CommandUsagePart[] {
    const parts: CommandUsagePart[] = [
        { kind: "muted", text: "usage: " },
        { kind: "command", text: `/${command.invocationName ?? command.name}` },
    ];

    if (command.subcommands !== undefined) {
        let subcommandToken = "<subcommand>";
        if (command.hasRootHandler === true) {
            subcommandToken = "[<subcommand>]";
        }
        parts.push({ kind: "muted", text: " " }, { kind: "positional", text: subcommandToken });
    }

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

function detailedAliasLabels(name: string, definition: ArgumentDefinition): string[] {
    if (isPositionalArgument(definition)) {
        return [];
    }
    return argumentFlagNames(name, definition)
        .slice(1)
        .map((alias) => `--${alias}`);
}

function detailedArgumentValueHint(
    name: string,
    definition: ArgumentDefinition,
    metadata: ResolvedDetailedHelpMetadataOptions,
): string | undefined {
    if (!metadata.types) {
        return undefined;
    }
    if (
        !metadata.enumValues &&
        (definition.type === "enum" || definition.type === "multi-enum") &&
        definition.placeholder === undefined
    ) {
        return argumentTypeHint(definition);
    }
    return argumentValueHint(definition, name);
}

function detailedConstraints(definition: ArgumentDefinition): string[] {
    switch (definition.type) {
        case "string": {
            const constraints: string[] = [];
            if (definition.format !== undefined) constraints.push(`format ${definition.format}`);
            if (definition.minLength !== undefined)
                constraints.push(`minimum length ${definition.minLength}`);
            if (definition.maxLength !== undefined)
                constraints.push(`maximum length ${definition.maxLength}`);
            return constraints;
        }
        case "number": {
            const constraints: string[] = [];
            if (definition.min !== undefined) constraints.push(`minimum ${definition.min}`);
            if (definition.max !== undefined) constraints.push(`maximum ${definition.max}`);
            if (definition.step !== undefined) constraints.push(`step ${definition.step}`);
            if (definition.unit !== undefined) constraints.push(`unit ${definition.unit}`);
            return constraints;
        }
        case "multi-enum":
        case "string-list":
        case "key-value": {
            const constraints: string[] = [];
            if (definition.minItems !== undefined)
                constraints.push(`minimum ${definition.minItems} items`);
            if (definition.maxItems !== undefined)
                constraints.push(`maximum ${definition.maxItems} items`);
            return constraints;
        }
        case "boolean":
        case "enum":
            return [];
        default:
            return casesHandled(definition);
    }
}

function detailedDefault(definition: ArgumentDefinition): string {
    if (definition.type === "string" && definition.sensitive === true) {
        return "<redacted>";
    }
    const value = definition.default;
    if (Array.isArray(value)) {
        return value.join(",");
    }
    if (typeof value === "object" && value !== null) {
        return Object.entries(value)
            .map(([key, entryValue]) => `${key}=${entryValue}`)
            .join(",");
    }
    if (typeof value === "number" && Object.is(value, -0)) {
        return "-0";
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return "";
}

/** Format detailed multi-line help for a registered typed command. */
export function formatDetailedHelp<TDefinitions extends ArgumentDefinitions>(
    command: CoreRegisteredTypedCommand<TDefinitions>,
    options?: DetailedHelpFormatOptions,
): string {
    const metadata: ResolvedDetailedHelpMetadataOptions = {
        ...DEFAULT_DETAILED_HELP_METADATA,
        ...options?.metadata,
    };
    const lines = [
        `/${command.invocationName ?? command.name}`,
        "",
        command.description,
        "",
        "Usage:",
        `  ${formatCommandUsage(command)}`,
    ];

    if (command.subcommands !== undefined) {
        lines.push("", "Subcommands:");
        for (const [name, subcommand] of Object.entries(command.subcommands)) {
            let label = `  ${name}`;
            if ((subcommand.aliases?.length ?? 0) > 0) {
                label += `, aliases ${subcommand.aliases?.join(", ") ?? ""}`;
            }
            lines.push(label);
            if (metadata.descriptions) {
                lines.push(`    ${subcommand.description}`);
            }
            lines.push(`    ${formatCommandUsage(subcommand)}`);
        }
    }

    let entries = orderedCommandArgumentEntries(command);
    if (options?.order === "required-first") {
        entries = [...entries].sort((left, right) => {
            let leftRequired = 1;
            if (left[1].required === true) {
                leftRequired = 0;
            }
            let rightRequired = 1;
            if (right[1].required === true) {
                rightRequired = 0;
            }
            return leftRequired - rightRequired;
        });
    }
    if (entries.length > 0) {
        lines.push("", "Arguments:");
        for (const [name, definition] of entries) {
            let label = `  ${formatArgumentFlagName(name, definition)}`;
            if (isPositionalArgument(definition)) {
                label = `  ${toKebabCase(name)}`;
            }
            const valueHint = detailedArgumentValueHint(name, definition, metadata);
            if (valueHint !== undefined) {
                label += `: ${valueHint}`;
            }
            if (metadata.required && definition.required === true) {
                label += ", required";
            }
            if (metadata.defaults && definition.default !== undefined) {
                label += `, default ${detailedDefault(definition)}`;
            }
            if (metadata.aliases) {
                const aliases = detailedAliasLabels(name, definition);
                if (aliases.length > 0) {
                    label += `, aliases ${aliases.join(", ")}`;
                }
            }
            lines.push(label);
            if (metadata.descriptions && definition.description !== undefined) {
                lines.push(`    ${definition.description}`);
            }
            const constraints = detailedConstraints(definition);
            if (constraints.length > 0) {
                lines.push(`    ${constraints.join(", ")}`);
            }
            if ((definition.examples?.length ?? 0) > 0) {
                lines.push(`    examples: ${definition.examples?.join(", ") ?? ""}`);
            }
        }
    }

    return lines.join("\n");
}

/** Format issue messages as a bullet list for Pi notifications. */
export function formatIssues(messages: string[]): string {
    return messages.map((message) => `• ${message}`).join("\n");
}
