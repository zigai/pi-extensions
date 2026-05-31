import { formatFlagName } from "./names.js";
import type { ArgumentDefinition, RegisteredTypedCommand } from "./types.js";

function valueHint(definition: ArgumentDefinition): string {
    if (definition.type === "string") {
        if (definition.placeholder !== undefined) {
            return definition.placeholder;
        }
        return "string";
    }

    if (definition.type === "number") {
        if (definition.integer === true) {
            return "integer";
        }
        return "number";
    }

    if (definition.type === "boolean") {
        return "boolean";
    }

    return definition.values.join("|");
}

function formatDefault(definition: ArgumentDefinition): string {
    if (definition.default === undefined) {
        return "";
    }
    return `=${String(definition.default)}`;
}

function formatArgumentUsage(name: string, definition: ArgumentDefinition): string {
    const flag = formatFlagName(name);
    let text: string;

    if (definition.type === "boolean") {
        text = flag;
    } else {
        text = `${flag} <${valueHint(definition)}${formatDefault(definition)}>`;
    }

    if (definition.required === true) {
        return text;
    }

    return `[${text}]`;
}

export function formatCommandUsage<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
): string {
    const parts = Object.entries(command.args).map(([name, definition]) =>
        formatArgumentUsage(name, definition),
    );
    if (parts.length === 0) {
        return `/${command.name}`;
    }
    return `/${command.name} ${parts.join(" ")}`;
}

export function formatHelperLine<TDefinitions extends Record<string, ArgumentDefinition>>(
    command: RegisteredTypedCommand<TDefinitions>,
): string {
    const usage = formatCommandUsage(command);
    return `${usage}  ·  ${command.manualWizardToken} opens form`;
}

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

    const entries = Object.entries(command.args);
    if (entries.length > 0) {
        lines.push("", "Arguments:");
        for (const [name, definition] of entries) {
            let label = `  ${formatFlagName(name)}`;
            if (definition.aliases !== undefined && definition.aliases.length > 0) {
                label += ` (${definition.aliases.join(", ")})`;
            }
            label += `: ${valueHint(definition)}`;
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

    lines.push("", `Use /${command.name} ${command.manualWizardToken} to open the argument form.`);
    return lines.join("\n");
}

export function formatIssues(messages: string[]): string {
    return messages.map((message) => `• ${message}`).join("\n");
}
