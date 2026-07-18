import type { ThirdPartyToolRenderContext, ThirdPartyToolResult } from "./types.ts";
import {
    appendGraphemeEllipsis,
    graphemes,
    takeGraphemePrefix,
    truncateGraphemeText,
} from "../text-boundaries.ts";
import { getString } from "./tool-values.ts";

const MAX_PREVIEW_CHARACTERS = 700;
const MAX_PREVIEW_ARRAY_ITEMS = 20;
const MAX_PREVIEW_OBJECT_PROPERTIES = 30;
const MAX_PARTIAL_PREVIEW_PROPERTIES = 8;
const MAX_PREVIEW_DEPTH = 5;
const SENSITIVE_KEY_PATTERN =
    /(?:pass(?:word|phrase)?|secret|token|api[_-]?key|auth(?:orization)?|cookie|credential|private[_-]?key|access[_-]?key)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemCount(count: number): string {
    return `${count} ${count === 1 ? "item" : "items"}`;
}

export function truncateText(text: string, maxCharacters: number): string {
    return truncateGraphemeText(text, maxCharacters);
}

function safeRead(record: object, key: string): unknown {
    try {
        return Reflect.get(record, key);
    } catch {
        return undefined;
    }
}

function boundedPreviewValue(
    value: unknown,
    seen: WeakSet<object>,
    depth: number,
    key?: string,
): unknown {
    if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
        return "[redacted]";
    }
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
    if (depth >= MAX_PREVIEW_DEPTH) {
        return "[Object]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
        const output: unknown[] = [];
        const limit = Math.min(value.length, MAX_PREVIEW_ARRAY_ITEMS);
        for (let index = 0; index < limit; index += 1) {
            output.push(boundedPreviewValue(safeRead(value, String(index)), seen, depth + 1));
        }
        if (value.length > limit) {
            output.push(`… +${itemCount(value.length - limit)}`);
        }
        return output;
    }

    const output: Record<string, unknown> = {};
    let copied = 0;
    let omitted = 0;
    for (const keyName of Object.keys(value)) {
        if (copied >= MAX_PREVIEW_OBJECT_PROPERTIES) {
            omitted += 1;
            continue;
        }
        output[keyName] = boundedPreviewValue(safeRead(value, keyName), seen, depth + 1, keyName);
        copied += 1;
    }
    if (omitted > 0) {
        output["…"] = `+${omitted} properties`;
    }
    return output;
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

    try {
        return JSON.stringify(boundedPreviewValue(value, new WeakSet<object>(), 0), null, 2);
    } catch {
        return undefined;
    }
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
    return truncateText(text.slice(start, end), maxCharacters);
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

function compactValue(value: unknown, key: string): string | undefined {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
        return `${key}: [redacted]`;
    }
    if (typeof value === "string") {
        const preview = compactWhitespaceText(takeGraphemePrefix(value, 192), 96);
        return preview === undefined ? key : `${key}: ${preview}`;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return `${key}: ${String(value)}`;
    }
    if (typeof value === "bigint") {
        return `${key}: ${value.toString()}n`;
    }
    if (Array.isArray(value)) {
        return `${key}: ${itemCount(value.length)}`;
    }
    if (isRecord(value)) {
        return `${key}: object`;
    }
    return value === undefined ? undefined : key;
}

function compactObjectPreview(value: Record<string, unknown>): string | undefined {
    const parts: string[] = [];
    let omitted = false;
    for (const key of Object.keys(value)) {
        if (parts.length >= MAX_PARTIAL_PREVIEW_PROPERTIES) {
            omitted = true;
            break;
        }
        const part = compactValue(safeRead(value, key), key);
        if (part !== undefined) {
            parts.push(part);
        }
    }
    if (parts.length === 0) {
        return undefined;
    }
    return truncateText(
        `${parts.join(" • ")}${omitted ? " • more fields" : ""}`,
        MAX_PREVIEW_CHARACTERS,
    );
}

function previewPartialArgs(args: unknown, fallback?: string): string | undefined {
    if (fallback !== undefined) {
        return fallback;
    }
    if (typeof args === "string") {
        return compactWhitespaceText(
            takeGraphemePrefix(args, MAX_PREVIEW_CHARACTERS * 2),
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
        return args.length === 0 ? undefined : itemCount(args.length);
    }
    return isRecord(args) ? compactObjectPreview(args) : undefined;
}

/** Returns a bounded structured argument preview for expanded views. */
export function previewArgs(args: unknown, fallback?: string): string | undefined {
    return fallback ?? previewValue(args);
}

/** Returns a compact argument preview appropriate for the current execution phase. */
export function previewArgsForContext(
    args: unknown,
    context: ThirdPartyToolRenderContext,
    fallback?: string,
): string | undefined {
    if (context.isPartial || !context.argsComplete) {
        return previewPartialArgs(args, fallback);
    }
    return previewArgs(args, fallback);
}

/** Extracts all text content blocks from a tool result. */
export function textOutput(result: ThirdPartyToolResult): string | undefined {
    const content = result.content;
    if (!Array.isArray(content)) {
        return undefined;
    }

    const texts: string[] = [];
    for (const item of content) {
        if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
            continue;
        }
        texts.push(item.text);
    }
    return texts.length === 0 ? undefined : texts.join("\n");
}

/** Extracts a small, redacted summary when a result has no text content. */
export function detailsOutput(result: ThirdPartyToolResult): string | undefined {
    if (!isRecord(result.details)) {
        return undefined;
    }
    return compactObjectPreview(result.details);
}

export function compactWhitespaceText(text: string, maxCharacters: number): string | undefined {
    let output = "";
    let pendingWhitespace = false;

    for (const char of graphemes(text)) {
        if (char.trim().length === 0) {
            pendingWhitespace = output.length > 0;
            continue;
        }
        if (pendingWhitespace) {
            if (output.length >= maxCharacters - 1) {
                return appendGraphemeEllipsis(output, maxCharacters);
            }
            output += " ";
            pendingWhitespace = false;
        }
        if (output.length + char.length > maxCharacters) {
            return appendGraphemeEllipsis(output, maxCharacters);
        }
        output += char;
    }

    return output.length > 0 ? output : undefined;
}

export function compactQuotedText(
    value: string | undefined,
    maxCharacters = 96,
): string | undefined {
    if (value === undefined || value.length === 0) {
        return undefined;
    }
    const compact = compactWhitespaceText(value, maxCharacters);
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

/** Visits non-empty output lines after normalizing CRLF and CR line endings. */
export function visitNormalizedOutputLines(text: string, visit: (line: string) => void): boolean {
    let sawLine = false;
    for (const line of text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")) {
        if (line.trim().length === 0) {
            continue;
        }
        sawLine = true;
        visit(line);
    }
    return sawLine;
}
