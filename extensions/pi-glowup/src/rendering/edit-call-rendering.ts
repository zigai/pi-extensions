import type { Component } from "@earendil-works/pi-tui";
import { takeGraphemeSuffix, truncateGraphemeText } from "../text-boundaries.ts";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
    formatPathTarget,
    makeComponent,
    renderGlowupCall,
    renderGlowupOutput,
    type GlowupRenderTheme,
} from "./core.ts";
import { isActiveToolCall, toolStatusLabel, type ToolLabelMode } from "./status-labels.ts";

type UnknownRecord = {
    readonly [key: string]: unknown;
};

type EditTextPair = {
    readonly oldText: string;
    readonly newText: string;
};

type TextLineWindow = {
    readonly lines: readonly string[];
    readonly omittedBefore: boolean;
    readonly omittedAfter: boolean;
};

const MAX_PARTIAL_EDIT_SCAN_CHARS = 16 * 1024;
const MAX_PARTIAL_EDIT_LINE_CHARS = 2_000;
const PARTIAL_EDIT_NEW_LINES = 6;
const MAX_EDIT_PREIMAGE_BYTES = 4 * 1024 * 1024;
const MAX_EDIT_LINE_NUMBER_CALLS = 100;

type EditLineNumberState = {
    key: string;
    resolved: boolean;
    startLine: number | undefined;
    pending: Promise<void> | undefined;
};

const editLineNumbers = new Map<string, EditLineNumberState>();

/** Drops session-scoped edit lookup state so old async work cannot repaint a replacement session. */
export function clearStreamingEditRenderingState(): void {
    editLineNumbers.clear();
}

export type EditCallRenderContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly labelMode?: ToolLabelMode;
    readonly lineNumberStart?: number;
};

export type EditCallSummary = {
    readonly statusText: string;
    readonly path: string | undefined;
    readonly suffix: string;
    readonly hasInvalidEdits: boolean;
};

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: UnknownRecord, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function editPairKey(pathValue: string, oldText: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < oldText.length; index += 1) {
        hash ^= oldText.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return `${pathValue}\u0000${oldText.length}\u0000${Math.trunc(hash)}`;
}

function safeEditPath(cwd: string, filePath: string): string | undefined {
    const resolvedCwd = path.resolve(cwd);
    const resolvedPath = path.resolve(resolvedCwd, filePath);
    const relativePath = path.relative(resolvedCwd, resolvedPath);
    return relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
        ? undefined
        : resolvedPath;
}

async function findEditStartLine(
    cwd: string,
    filePath: string,
    oldText: string,
): Promise<number | undefined> {
    const resolvedPath = safeEditPath(cwd, filePath);
    if (resolvedPath === undefined) return undefined;
    try {
        const stats = await stat(resolvedPath);
        if (!stats.isFile() || stats.size > MAX_EDIT_PREIMAGE_BYTES) return undefined;
        const source = (await readFile(resolvedPath, "utf8"))
            .replace(/\r\n/gu, "\n")
            .replace(/\r/gu, "\n");
        const needle = oldText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        if (needle.length === 0) return undefined;
        const match = source.indexOf(needle);
        if (match < 0 || source.indexOf(needle, match + 1) >= 0) return undefined;
        let startLine = 1;
        for (let index = 0; index < match; index += 1) {
            if (source.charCodeAt(index) === 10) startLine += 1;
        }
        return startLine;
    } catch {
        return undefined;
    }
}

/** Starts a bounded async line-number lookup and returns a resolved position when available. */
export function resolveStreamingEditLineNumber(
    toolCallId: string,
    cwd: string,
    args: unknown,
    invalidate: () => void,
): number | undefined {
    const record = isRecord(args) ? args : undefined;
    const filePath = record === undefined ? undefined : getString(record, "path");
    const pair = latestEditTextPair(args);
    if (filePath === undefined || pair === undefined) return undefined;

    const key = editPairKey(filePath, pair.oldText);
    let state = editLineNumbers.get(toolCallId);
    if (state === undefined) {
        state = { key, resolved: false, startLine: undefined, pending: undefined };
        editLineNumbers.set(toolCallId, state);
        while (editLineNumbers.size > MAX_EDIT_LINE_NUMBER_CALLS) {
            const oldest = editLineNumbers.keys().next().value;
            if (typeof oldest !== "string") break;
            editLineNumbers.delete(oldest);
        }
    } else if (state.key !== key) {
        state.key = key;
        state.resolved = false;
        state.startLine = undefined;
    }
    if (state.resolved || state.pending !== undefined) {
        return state.startLine;
    }

    const targetState = state;
    const targetKey = key;
    let request: Promise<void>;
    request = findEditStartLine(cwd, filePath, pair.oldText)
        .then((startLine) => {
            if (editLineNumbers.get(toolCallId) !== targetState || targetState.key !== targetKey) {
                return;
            }
            targetState.resolved = true;
            targetState.startLine = startLine;
        })
        .finally(() => {
            if (editLineNumbers.get(toolCallId) === targetState && targetState.key === targetKey) {
                if (targetState.pending === request) targetState.pending = undefined;
                invalidate();
            }
        });
    targetState.pending = request;
    return undefined;
}

function editTextPair(value: unknown): EditTextPair | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    if (typeof value.oldText === "string" && typeof value.newText === "string") {
        return { oldText: value.oldText, newText: value.newText };
    }
    if (typeof value.old_string === "string" && typeof value.new_string === "string") {
        return { oldText: value.old_string, newText: value.new_string };
    }
    return undefined;
}

function hasEditTextPair(value: unknown): boolean {
    return editTextPair(value) !== undefined;
}

function latestEditTextPair(args: unknown): EditTextPair | undefined {
    if (!isRecord(args)) {
        return undefined;
    }

    if (Array.isArray(args.edits)) {
        for (let index = args.edits.length - 1; index >= 0; index -= 1) {
            const pair = editTextPair(args.edits[index]);
            if (pair !== undefined) {
                return pair;
            }
        }
    }

    return editTextPair(args);
}

function physicalLines(text: string): string[] {
    const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
    if (lines.length > 1 && lines.at(-1) === "") {
        lines.pop();
    }
    return lines.length === 0 ? [""] : lines;
}

function tailLineWindow(text: string, maxLines: number): TextLineWindow {
    const suffix = takeGraphemeSuffix(text, MAX_PARTIAL_EDIT_SCAN_CHARS);
    const lines = physicalLines(suffix);
    return {
        lines: lines.slice(-maxLines),
        omittedBefore: suffix.length < text.length || lines.length > maxLines,
        omittedAfter: false,
    };
}

function boundedEditLine(line: string): string {
    if (line.length <= MAX_PARTIAL_EDIT_LINE_CHARS) {
        return truncateGraphemeText(line, MAX_PARTIAL_EDIT_LINE_CHARS);
    }
    return `…${takeGraphemeSuffix(line, MAX_PARTIAL_EDIT_LINE_CHARS - 1)}`;
}

function streamingReplacementDraft(pair: EditTextPair): string {
    const newText = tailLineWindow(pair.newText, PARTIAL_EDIT_NEW_LINES);
    return [
        ...(newText.omittedBefore ? ["… earlier replacement lines omitted"] : []),
        ...newText.lines.map(boundedEditLine),
    ].join("\n");
}

function formatEditCount(validEdits: number): string {
    if (validEdits <= 1) {
        return "";
    }
    return ` (${validEdits} edits)`;
}

function formatInvalidEditCount(validEdits: number, invalidEdits: number): string {
    const validText = `${validEdits} valid`;
    const invalidText = `${invalidEdits} invalid`;
    return ` (${validText}, ${invalidText})`;
}

export function summarizeEditCall(args: unknown, context: EditCallRenderContext): EditCallSummary {
    const record = isRecord(args) ? args : undefined;
    const path = record ? getString(record, "path") : undefined;
    const edits = record && Array.isArray(record.edits) ? record.edits : undefined;
    const validEdits = edits?.filter(hasEditTextPair).length ?? 0;
    const invalidEdits = edits === undefined ? 0 : edits.length - validEdits;

    const editLabel = toolStatusLabel(context.labelMode ?? "static", context, {
        static: "Edit",
        active: "Editing",
        completed: "Edited",
    });

    if (invalidEdits > 0 && !isActiveToolCall(context)) {
        return {
            statusText: editLabel,
            path,
            suffix: formatInvalidEditCount(validEdits, invalidEdits),
            hasInvalidEdits: true,
        };
    }

    if (context.isError) {
        return {
            statusText: editLabel,
            path,
            suffix: formatEditCount(validEdits),
            hasInvalidEdits: false,
        };
    }

    if (context.isPartial) {
        return {
            statusText: editLabel,
            path,
            suffix: formatEditCount(validEdits),
            hasInvalidEdits: false,
        };
    }

    return {
        statusText: editLabel,
        path,
        suffix: formatEditCount(validEdits),
        hasInvalidEdits: false,
    };
}

/** Renders the latest bounded replacement diff while edit arguments are still arriving. */
export function renderStreamingEditCallPreview(
    args: unknown,
    theme: GlowupRenderTheme,
    context: EditCallRenderContext & { readonly expanded: boolean },
): Component | undefined {
    const pair = latestEditTextPair(args);
    if (pair === undefined || context.lineNumberStart === undefined) {
        return undefined;
    }

    const record = isRecord(args) ? args : undefined;
    const path = record ? getString(record, "path") : undefined;
    const header = renderGlowupCall(theme, {
        state: context.isError ? "error" : isActiveToolCall(context) ? "running" : "success",
        statusText: toolStatusLabel(context.labelMode ?? "static", context, {
            static: "Edit",
            active: "Editing",
            completed: "Edited",
        }),
        body: formatPathTarget(theme, path),
    });
    const draft = renderGlowupOutput(theme, streamingReplacementDraft(pair), {
        expanded: context.expanded,
        mode: "head",
        maxPreviewLines: PARTIAL_EDIT_NEW_LINES + 1,
        prefixFirst: theme.fg("dim", "  │ "),
        prefixRest: theme.fg("dim", "  │ "),
        dimContent: false,
        ...(path === undefined ? {} : { syntax: { path } }),
    });
    return makeComponent((width) => [...header.render(width), ...draft.render(width)]);
}
