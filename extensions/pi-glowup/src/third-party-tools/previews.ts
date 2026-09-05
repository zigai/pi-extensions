import type { ThirdPartyToolRenderContext, ThirdPartyToolResult } from "./types.ts";
import { takeGraphemePrefix, truncateGraphemeText } from "../text-boundaries.ts";
import { stringParser } from "../json-scalar.ts";
import { isRecord } from "./tool-values.ts";
import {
    jsonObjectParser,
    jsonValueParser,
    type JsonObject,
    type JsonValue,
} from "../json-value.ts";

const MAX_PREVIEW_CHARACTERS = 700;
const MAX_PREVIEW_ARRAY_ITEMS = 20;
const MAX_PREVIEW_OBJECT_PROPERTIES = 30;
const MAX_PARTIAL_PREVIEW_PROPERTIES = 8;
const MAX_PREVIEW_DEPTH = 5;
const SENSITIVE_KEY_PATTERN =
    /(?:pass(?:word|phrase)?|secret|token|api[_-]?key|auth(?:orization)?|cookie|credential|private[_-]?key|access[_-]?key)/iu;
const INTERNAL_DETAIL_PATH_KEY_PATTERN =
    /(?:artifact|transcript|workspace|report|patch|output|attachment|session)(?:[_-]?(?:file|dir(?:ectory)?))?[_-]?paths?$/iu;

type PreviewValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | readonly PreviewValue[]
    | { readonly [key: string]: PreviewValue };

function itemCount(count: number): string {
    return `${count} ${count === 1 ? "item" : "items"}`;
}

function safeRead(
    record: JsonObject | ReadonlyArray<JsonValue>,
    key: string,
): JsonValue | undefined {
    // SAFETY: JsonObject / ReadonlyArray dictionary property access.
    const dict = record as Record<string, JsonValue>;
    return dict[key];
}

export const previewValueDecoder = {
    parseString(value: JsonValue | undefined): string | undefined {
        if (value === undefined || value === null || !isString(value)) return undefined;
        return value;
    },
    parseNumber(value: JsonValue | undefined): number | undefined {
        if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
        // SAFETY: Number.isFinite proves value is a finite number primitive.
        return value as number;
    },
    parseBoolean(value: JsonValue | undefined): boolean | undefined {
        if (value !== true && value !== false) return undefined;
        return value;
    },
};

function isString(value: JsonValue | undefined): value is string {
    return stringParser.parse(value) !== undefined;
}

function boundedPreviewValue(
    value: JsonValue | undefined,
    seen: WeakSet<object>,
    depth: number,
    key?: string,
): PreviewValue {
    if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key)) {
        return "[redacted]";
    }

    const str = previewValueDecoder.parseString(value);
    if (str !== undefined) {
        return truncateGraphemeText(str, MAX_PREVIEW_CHARACTERS);
    }

    const num = previewValueDecoder.parseNumber(value);
    if (num !== undefined) {
        return num;
    }

    const bool = previewValueDecoder.parseBoolean(value);
    if (bool !== undefined) {
        return bool;
    }

    if (value === undefined || value === null) {
        return value;
    }

    // SAFETY: Array instance is an object.
    const objectTarget = Array.isArray(value) ? (value as object) : jsonObjectParser.parse(value);
    if (objectTarget !== undefined) {
        if (seen.has(objectTarget)) {
            return "[Circular]";
        }
        if (depth >= MAX_PREVIEW_DEPTH) {
            return "[Object]";
        }
        seen.add(objectTarget);
    }

    if (Array.isArray(value)) {
        const output: PreviewValue[] = [];
        const limit = Math.min(value.length, MAX_PREVIEW_ARRAY_ITEMS);
        for (let index = 0; index < limit; index += 1) {
            output.push(boundedPreviewValue(safeRead(value, String(index)), seen, depth + 1));
        }
        if (value.length > limit) {
            output.push(`… +${itemCount(value.length - limit)}`);
        }
        return output;
    }

    const record = jsonObjectParser.parse(value);
    if (record === undefined) {
        return "[Unsupported value]";
    }

    const output: Record<string, PreviewValue> = {};
    let copied = 0;
    let omitted = 0;
    for (const keyName of Object.keys(record)) {
        if (copied >= MAX_PREVIEW_OBJECT_PROPERTIES) {
            omitted += 1;
            continue;
        }
        output[keyName] = boundedPreviewValue(safeRead(record, keyName), seen, depth + 1, keyName);
        copied += 1;
    }
    if (omitted > 0) {
        output["…"] = `+${omitted} properties`;
    }
    return output;
}

function stringifyPreview(value: JsonValue | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const str = previewValueDecoder.parseString(value);
    if (str !== undefined) {
        return str;
    }
    const num = previewValueDecoder.parseNumber(value);
    if (num !== undefined) {
        return String(num);
    }
    const bool = previewValueDecoder.parseBoolean(value);
    if (bool !== undefined) {
        return String(bool);
    }
    if (value === null) {
        return String(value);
    }

    try {
        return JSON.stringify(boundedPreviewValue(value, new WeakSet<object>(), 0), null, 2);
    } catch {
        return undefined;
    }
}

export function compactWhitespaceText(text: string, maxCharacters: number): string | undefined {
    const compact = text.replace(/\s+/gu, " ").trim();
    if (compact.length === 0) {
        return undefined;
    }
    return truncateGraphemeText(compact, maxCharacters);
}

function previewValue(value: JsonValue | undefined): string | undefined {
    const str = previewValueDecoder.parseString(value);
    if (str !== undefined) {
        return compactWhitespaceText(
            takeGraphemePrefix(str, MAX_PREVIEW_CHARACTERS * 2),
            MAX_PREVIEW_CHARACTERS,
        );
    }
    const preview = stringifyPreview(value)?.trim();
    if (preview === undefined || preview.length === 0 || preview === "{}" || preview === "[]") {
        return undefined;
    }
    return truncateGraphemeText(preview, MAX_PREVIEW_CHARACTERS);
}

function compactValue(value: JsonValue | undefined, key: string): string | undefined {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
        return `${key}: [redacted]`;
    }
    const str = previewValueDecoder.parseString(value);
    if (str !== undefined) {
        const preview = compactWhitespaceText(takeGraphemePrefix(str, 192), 96);
        return preview === undefined ? key : `${key}: ${preview}`;
    }
    const num = previewValueDecoder.parseNumber(value);
    if (num !== undefined) {
        return `${key}: ${num}`;
    }
    const bool = previewValueDecoder.parseBoolean(value);
    if (bool !== undefined) {
        return `${key}: ${bool}`;
    }
    if (value === null) {
        return `${key}: null`;
    }
    if (Array.isArray(value)) {
        return `${key}: ${itemCount(value.length)}`;
    }
    if (isRecord(value)) {
        return `${key}: object`;
    }
    return value === undefined ? undefined : key;
}

function compactObjectPreview(value: JsonObject): string | undefined {
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
    return truncateGraphemeText(
        `${parts.join(" • ")}${omitted ? " • more fields" : ""}`,
        MAX_PREVIEW_CHARACTERS,
    );
}

function previewPartialArgs(args: JsonValue | undefined, fallback?: string): string | undefined {
    if (fallback !== undefined) {
        return fallback;
    }
    const str = previewValueDecoder.parseString(args);
    if (str !== undefined) {
        return compactWhitespaceText(
            takeGraphemePrefix(str, MAX_PREVIEW_CHARACTERS * 2),
            MAX_PREVIEW_CHARACTERS,
        );
    }
    const num = previewValueDecoder.parseNumber(args);
    if (num !== undefined) {
        return String(num);
    }
    const bool = previewValueDecoder.parseBoolean(args);
    if (bool !== undefined) {
        return String(bool);
    }
    if (args === null) {
        return String(args);
    }
    if (Array.isArray(args)) {
        return args.length === 0 ? undefined : itemCount(args.length);
    }
    const record = jsonObjectParser.parse(args);
    return record === undefined ? undefined : compactObjectPreview(record);
}

/** Returns a bounded structured argument preview for expanded views. */
export function previewArgs(args: unknown, fallback?: string): string | undefined {
    const jsonVal = jsonValueParser.parse(args);
    return fallback ?? previewValue(jsonVal);
}

/** Returns a compact argument preview appropriate for the current execution phase. */
export function previewArgsForContext(
    args: unknown,
    context: ThirdPartyToolRenderContext,
    fallback?: string,
): string | undefined {
    const jsonVal = jsonValueParser.parse(args);
    if (context.isPartial || !context.argsComplete) {
        return previewPartialArgs(jsonVal, fallback);
    }
    return previewArgs(jsonVal, fallback);
}

/** Extracts all text content blocks from a tool result. */
export function textOutput(result: ThirdPartyToolResult): string | undefined {
    const content = result.content;
    if (!Array.isArray(content)) {
        return undefined;
    }

    const texts: string[] = [];
    for (const item of content) {
        if (!isRecord(item)) continue;
        const itemRecord = jsonObjectParser.parse(item);
        if (itemRecord === undefined) continue;
        const typeStr = previewValueDecoder.parseString(itemRecord.type);
        const textStr = previewValueDecoder.parseString(itemRecord.text);
        if (typeStr !== "text" || textStr === undefined) {
            continue;
        }
        texts.push(textStr);
    }
    return texts.length === 0 ? undefined : texts.join("\n");
}

function compactDetailsPreview(value: JsonObject): string | undefined {
    const parts: string[] = [];
    for (const key of Object.keys(value)) {
        if (INTERNAL_DETAIL_PATH_KEY_PATTERN.test(key)) continue;
        if (parts.length >= MAX_PARTIAL_PREVIEW_PROPERTIES) {
            parts.push("more fields");
            break;
        }
        const part = compactValue(safeRead(value, key), key);
        if (part !== undefined) parts.push(part);
    }
    return parts.length === 0
        ? undefined
        : truncateGraphemeText(parts.join(" • "), MAX_PREVIEW_CHARACTERS);
}

/** Extracts structured details preview for tool result. */
export function detailsOutput(result: ThirdPartyToolResult): string | undefined {
    const details = result.details;
    if (details === undefined || details === null) {
        return undefined;
    }
    const record = jsonObjectParser.parse(details);
    if (record === undefined) {
        return undefined;
    }
    return compactDetailsPreview(record);
}
