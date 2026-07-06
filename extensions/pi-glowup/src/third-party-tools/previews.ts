import type { ThirdPartyToolRenderContext, ThirdPartyToolResult } from "./types.ts";
import { getString, isRecord } from "./tool-values.ts";

type TextContent = {
    readonly type?: unknown;
    readonly text?: unknown;
};

const MAX_PREVIEW_CHARACTERS = 700;
const MAX_PREVIEW_ARRAY_ITEMS = 20;
const MAX_PREVIEW_OBJECT_PROPERTIES = 30;
const MAX_PARTIAL_PREVIEW_PROPERTIES = 8;

export function truncateText(text: string, maxCharacters: number): string {
    if (text.length <= maxCharacters) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function stringifyPreview(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return String(value);
    }
    if (typeof value === "bigint") {
        return `${value.toString()}n`;
    }
    if (typeof value === "symbol") {
        return value.description === undefined || value.description.length === 0
            ? "Symbol"
            : `Symbol(${value.description})`;
    }
    if (typeof value === "function") {
        return value.name.length > 0 ? `[Function ${value.name}]` : "[Function]";
    }

    const seen = new WeakSet<object>();
    try {
        const json = JSON.stringify(
            value,
            (_key, nestedValue: unknown) => {
                return boundedPreviewValue(nestedValue, seen);
            },
            2,
        );
        return json;
    } catch (cause: unknown) {
        if (cause instanceof Error) {
            return cause.message;
        }
        if (typeof cause === "string") {
            return cause;
        }
        return undefined;
    }
}

function boundedPreviewValue(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") {
        return truncateText(value, MAX_PREVIEW_CHARACTERS);
    }
    if (typeof value === "bigint") {
        return `${value.toString()}n`;
    }
    if (typeof value === "function") {
        return value.name.length > 0 ? `[Function ${value.name}]` : "[Function]";
    }
    if (typeof value === "symbol") {
        return value.description === undefined || value.description.length === 0
            ? "Symbol"
            : `Symbol(${value.description})`;
    }
    if (typeof value !== "object" || value === null) {
        return value;
    }
    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);

    if (Array.isArray(value) && value.length > MAX_PREVIEW_ARRAY_ITEMS) {
        return [
            ...value.slice(0, MAX_PREVIEW_ARRAY_ITEMS),
            `… +${value.length - MAX_PREVIEW_ARRAY_ITEMS} items`,
        ];
    }
    if (!Array.isArray(value)) {
        return boundedPreviewObject(value);
    }
    return value;
}

function boundedPreviewObject(value: object): object {
    const output: Record<string, unknown> = {};
    let copied = 0;
    let omitted = 0;

    for (const key in value) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
            continue;
        }
        if (copied < MAX_PREVIEW_OBJECT_PROPERTIES) {
            output[key] = Reflect.get(value, key);
            copied += 1;
        } else {
            omitted += 1;
        }
    }

    if (omitted === 0) {
        return value;
    }

    output["…"] = `+${omitted} properties`;
    return output;
}

function trimAndTruncateText(text: string, maxCharacters: number): string | undefined {
    let start = 0;
    let end = text.length;
    while (start < end && text.charAt(start).trim().length === 0) {
        start += 1;
    }
    while (end > start && text.charAt(end - 1).trim().length === 0) {
        end -= 1;
    }
    if (start === end) {
        return undefined;
    }
    if (end - start <= maxCharacters) {
        return text.slice(start, end);
    }
    return `${text.slice(start, start + Math.max(0, maxCharacters - 1))}…`;
}

function previewValue(value: unknown): string | undefined {
    if (typeof value === "string") {
        return trimAndTruncateText(value, MAX_PREVIEW_CHARACTERS);
    }

    const preview = stringifyPreview(value)?.trim();
    if (preview === undefined || preview.length === 0 || preview === "{}" || preview === "[]") {
        return undefined;
    }
    return truncateText(preview, MAX_PREVIEW_CHARACTERS);
}

export function previewArgs(args: unknown, fallback?: string): string | undefined {
    return fallback ?? previewValue(args);
}

function previewPartialArgs(args: unknown, fallback?: string): string | undefined {
    if (fallback !== undefined) {
        return fallback;
    }
    if (typeof args === "string") {
        return compactWhitespaceText(
            args.slice(0, MAX_PREVIEW_CHARACTERS * 2),
            MAX_PREVIEW_CHARACTERS,
        );
    }
    if (
        typeof args === "number" ||
        typeof args === "boolean" ||
        typeof args === "bigint" ||
        args === null
    ) {
        return String(args);
    }
    if (Array.isArray(args)) {
        return args.length === 0 ? undefined : `${args.length} items`;
    }
    if (!isRecord(args)) {
        return undefined;
    }

    const parts: string[] = [];
    let omitted = false;
    for (const key in args) {
        if (!Object.prototype.propertyIsEnumerable.call(args, key)) {
            continue;
        }
        if (parts.length >= MAX_PARTIAL_PREVIEW_PROPERTIES) {
            omitted = true;
            break;
        }
        const value = args[key];
        if (typeof value === "string") {
            const preview = compactWhitespaceText(value.slice(0, 96 * 2), 96);
            parts.push(preview === undefined ? key : `${key}: ${preview}`);
        } else if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint" ||
            value === null
        ) {
            parts.push(`${key}: ${String(value)}`);
        } else if (Array.isArray(value)) {
            parts.push(`${key}: ${value.length} items`);
        } else if (isRecord(value)) {
            parts.push(`${key}: object`);
        } else if (value !== undefined) {
            parts.push(key);
        }
    }
    if (parts.length === 0) {
        return undefined;
    }
    const suffix = omitted ? " • more fields" : "";
    return truncateText(`${parts.join(" • ")}${suffix}`, MAX_PREVIEW_CHARACTERS);
}

export function previewArgsForContext(
    args: unknown,
    context: ThirdPartyToolRenderContext,
    fallback?: string,
): string | undefined {
    return context.isPartial || !context.argsComplete
        ? previewPartialArgs(args, fallback)
        : previewArgs(args, fallback);
}

export function textOutput(result: ThirdPartyToolResult): string | undefined {
    const content = result.content;
    if (!Array.isArray(content)) {
        return undefined;
    }

    let firstText: string | undefined;
    let texts: string[] | undefined;
    for (const item of content) {
        if (!isRecord(item)) {
            continue;
        }
        const contentItem: TextContent = item;
        if (contentItem.type !== "text" || typeof contentItem.text !== "string") {
            continue;
        }
        if (firstText === undefined) {
            firstText = contentItem.text;
            continue;
        }
        texts ??= [firstText];
        texts.push(contentItem.text);
    }

    return texts === undefined ? firstText : texts.join("\n");
}

export function compactWhitespaceText(text: string, maxCharacters: number): string | undefined {
    let output = "";
    let pendingWhitespace = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] ?? "";
        if (char.trim().length === 0) {
            pendingWhitespace = output.length > 0;
            continue;
        }
        if (pendingWhitespace) {
            if (output.length >= maxCharacters - 1) {
                return `${output.slice(0, Math.max(0, maxCharacters - 1))}…`;
            }
            output += " ";
            pendingWhitespace = false;
        }
        if (output.length >= maxCharacters) {
            return `${output.slice(0, Math.max(0, maxCharacters - 1))}…`;
        }
        output += char;
    }

    return output.length > 0 ? output : undefined;
}

export function compactQuotedText(
    text: string | undefined,
    maxCharacters = 96,
): string | undefined {
    if (text === undefined || text.length === 0) {
        return undefined;
    }
    const compact = compactWhitespaceText(text, maxCharacters);
    return compact === undefined ? undefined : `"${compact}"`;
}

export function countedSummary(
    label: string,
    values: ReadonlyArray<unknown> | undefined,
): string | undefined {
    if (values === undefined || values.length === 0) {
        return undefined;
    }
    const prefix = label.length > 0 ? `${label} ` : "";
    const first = values[0];
    if (isRecord(first)) {
        const query =
            getString(first, "q") ?? getString(first, "ref_id") ?? getString(first, "url");
        const quoted = compactQuotedText(query);
        if (quoted !== undefined) {
            return values.length === 1
                ? `${prefix}${quoted}`
                : `${prefix}${quoted} +${values.length - 1}`;
        }
    }
    return `${prefix}${values.length}`;
}

function hasNonWhitespaceText(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        if (text.charAt(index).trim().length > 0) {
            return true;
        }
    }
    return false;
}

export function visitNormalizedOutputLines(text: string, visit: (line: string) => void): boolean {
    let lineStart = 0;
    let sawLine = false;

    for (let index = 0; index <= text.length; index += 1) {
        if (index < text.length) {
            const charCode = text.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                continue;
            }
        }

        const line = text.slice(lineStart, index);
        if (hasNonWhitespaceText(line)) {
            sawLine = true;
            visit(line);
        }

        if (
            index < text.length &&
            text.charCodeAt(index) === 13 &&
            text.charCodeAt(index + 1) === 10
        ) {
            index += 1;
        }
        lineStart = index + 1;
    }

    return sawLine;
}
