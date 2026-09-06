import { numberParser, stringParser } from "../../json-scalar.ts";
import { isJsonArray, jsonValueParser } from "../../json-value.ts";
import Type from "typebox";
import { Value } from "typebox/value";
import {
    type FindActionArgs,
    type GrepActionArgs,
    type LsActionArgs,
    type ReadActionArgs,
} from "../../rendering/tool-header.ts";
import { isRecord, stringField } from "../../unknown-values.ts";
import { type TextResult } from "./context.ts";
import { type EditCallArgs, type EditTextPair } from "./edit-summary.ts";
import { type WriteCallArgs } from "./write-preview.ts";

export function textOutput(result: TextResult): string | undefined {
    const content = jsonValueParser.parse(result.content);
    if (!isJsonArray(content)) return undefined;
    for (const item of content) {
        if (!isRecord(item) || item.type !== "text") continue;
        const text = stringParser.parse(item.text);
        if (text !== undefined) return text;
    }
    return undefined;
}

function stringFieldFrom(args: unknown, keys: readonly string[]): string | undefined {
    const value = jsonValueParser.parse(args);
    for (const key of keys) {
        const field = stringField(value, key);
        if (field !== undefined) {
            return field;
        }
    }
    return undefined;
}

export function pathField(args: unknown): string | undefined {
    return stringFieldFrom(jsonValueParser.parse(args), ["path", "file_path"]);
}

export function commandField(args: unknown): string | undefined {
    return stringFieldFrom(jsonValueParser.parse(args), ["command", "cmd"]);
}

function numberField(args: unknown, key: string): number | undefined {
    const parsed = jsonValueParser.parse(args);
    if (!isRecord(parsed)) {
        return undefined;
    }
    return numberParser.parse(parsed[key]);
}

export function normalizedWriteArgs(args: unknown): WriteCallArgs {
    const parsed = jsonValueParser.parse(args);
    const path = pathField(parsed);
    const content = stringFieldFrom(parsed, ["content", "contents"]);
    let normalized: WriteCallArgs = {};
    if (path !== undefined) normalized = { ...normalized, path };
    if (content !== undefined) normalized = { ...normalized, content };
    return normalized;
}

function editTextPair(value: unknown): EditTextPair | null {
    const parsed = jsonValueParser.parse(value);
    if (!isRecord(parsed)) return null;
    const oldText = stringFieldFrom(parsed, ["oldText", "old_string"]);
    const newText = stringFieldFrom(parsed, ["newText", "new_string"]);
    return oldText === undefined || newText === undefined ? null : { oldText, newText };
}

function replacementEditFromArgs(args: unknown): ReadonlyArray<EditTextPair> | undefined {
    const parsed = jsonValueParser.parse(args);
    const oldText = stringFieldFrom(parsed, ["oldText", "old_string"]);
    const newText = stringFieldFrom(parsed, ["newText", "new_string"]);
    if (oldText === undefined || newText === undefined) {
        return undefined;
    }
    return [{ oldText, newText }];
}

export function normalizedEditArgs(args: unknown): EditCallArgs {
    const parsed = jsonValueParser.parse(args);
    const path = pathField(parsed);
    const existingEdits =
        isRecord(parsed) && Array.isArray(parsed.edits) ? parsed.edits : undefined;
    const edits = existingEdits?.map(editTextPair) ?? replacementEditFromArgs(parsed);
    let normalized: EditCallArgs = {};
    if (path !== undefined) normalized = { ...normalized, path };
    if (edits !== undefined) normalized = { ...normalized, edits };
    return normalized;
}

export function readActionArgs(args: unknown): ReadActionArgs {
    const parsed = jsonValueParser.parse(args);
    const path = pathField(parsed);
    const offset = numberField(parsed, "offset");
    const limit = numberField(parsed, "limit");
    let action: ReadActionArgs = {};
    if (path !== undefined) action = { ...action, path };
    if (offset !== undefined) action = { ...action, offset };
    if (limit !== undefined) action = { ...action, limit };
    return action;
}

export function findActionArgs(args: unknown): FindActionArgs {
    const parsed = jsonValueParser.parse(args);
    const pattern = stringFieldFrom(parsed, ["pattern", "glob"]);
    const path = pathField(parsed);
    const limit = numberField(parsed, "limit");
    let action: FindActionArgs = {};
    if (pattern !== undefined) action = { ...action, pattern };
    if (path !== undefined) action = { ...action, path };
    if (limit !== undefined) action = { ...action, limit };
    return action;
}

export function grepActionArgs(args: unknown): GrepActionArgs {
    const parsed = jsonValueParser.parse(args);
    const pattern = stringFieldFrom(parsed, ["pattern", "query"]);
    const path = pathField(parsed);
    const glob = stringFieldFrom(parsed, ["glob", "include", "glob_filter"]);
    const limit = numberField(parsed, "limit");
    let action: GrepActionArgs = {};
    if (pattern !== undefined) action = { ...action, pattern };
    if (path !== undefined) action = { ...action, path };
    if (glob !== undefined) action = { ...action, glob };
    if (limit !== undefined) action = { ...action, limit };
    return action;
}

export function lsActionArgs(args: unknown): LsActionArgs {
    const parsed = jsonValueParser.parse(args);
    const path = pathField(parsed);
    const limit = numberField(parsed, "limit");
    let action: LsActionArgs = {};
    if (path !== undefined) action = { ...action, path };
    if (limit !== undefined) action = { ...action, limit };
    return action;
}

export function webSearchQuery(args: unknown): string | undefined {
    return stringFieldFrom(jsonValueParser.parse(args), ["query", "search_term"]);
}

const imageContentSchema = Type.Object(
    { type: Type.Literal("image") },
    { additionalProperties: true },
);

export function hasImageContent(result: TextResult): boolean {
    return (
        Array.isArray(result.content) &&
        result.content.some((item) => Value.Check(imageContentSchema, item))
    );
}
