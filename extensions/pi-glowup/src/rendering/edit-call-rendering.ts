import type { Component } from "@earendil-works/pi-tui";
import {
    formatPathTarget,
    makeComponent,
    renderCodexCall,
    renderCodexDiff,
    MUTATION_DIFF_PREVIEW_ROWS,
    type CodexRenderTheme,
    type DiffSection,
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
const PARTIAL_EDIT_OLD_LINES = 3;
const PARTIAL_EDIT_NEW_LINES = 3;

export type EditCallRenderContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly labelMode?: ToolLabelMode;
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

function headLineWindow(text: string, maxLines: number): TextLineWindow {
    const bounded = text.slice(0, MAX_PARTIAL_EDIT_SCAN_CHARS);
    const lines = physicalLines(bounded);
    return {
        lines: lines.slice(0, maxLines),
        omittedBefore: false,
        omittedAfter: text.length > bounded.length || lines.length > maxLines,
    };
}

function tailLineWindow(text: string, maxLines: number): TextLineWindow {
    const start = Math.max(0, text.length - MAX_PARTIAL_EDIT_SCAN_CHARS);
    const lines = physicalLines(text.slice(start));
    return {
        lines: lines.slice(-maxLines),
        omittedBefore: start > 0 || lines.length > maxLines,
        omittedAfter: false,
    };
}

function boundedEditLine(line: string, edge: "head" | "tail"): string {
    if (line.length <= MAX_PARTIAL_EDIT_LINE_CHARS) {
        return line;
    }
    if (edge === "head") {
        return `${line.slice(0, MAX_PARTIAL_EDIT_LINE_CHARS - 1)}…`;
    }
    return `…${line.slice(-(MAX_PARTIAL_EDIT_LINE_CHARS - 1))}`;
}

function streamingEditDiffSection(path: string | undefined, pair: EditTextPair): DiffSection {
    const oldText = headLineWindow(pair.oldText, PARTIAL_EDIT_OLD_LINES);
    const newText = tailLineWindow(pair.newText, PARTIAL_EDIT_NEW_LINES);
    const removedLines = oldText.lines.map(
        (line, index) => `-${index + 1} ${boundedEditLine(line, "head")}`,
    );
    const addedLines = newText.lines.map(
        (line, index) => `+${index + 1} ${boundedEditLine(line, "tail")}`,
    );
    return {
        ...(path === undefined ? {} : { path }),
        lines: [
            ...removedLines,
            ...(oldText.omittedAfter ? ["  … removed text truncated"] : []),
            ...(newText.omittedBefore ? ["  … earlier replacement lines omitted"] : []),
            ...addedLines,
        ],
        added: addedLines.length,
        removed: removedLines.length,
    };
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
    theme: CodexRenderTheme,
    context: EditCallRenderContext & { readonly expanded: boolean },
): Component | undefined {
    const pair = latestEditTextPair(args);
    if (pair === undefined) {
        return undefined;
    }

    const record = isRecord(args) ? args : undefined;
    const path = record ? getString(record, "path") : undefined;
    const header = renderCodexCall(theme, {
        state: context.isError ? "error" : isActiveToolCall(context) ? "running" : "success",
        statusText: toolStatusLabel(context.labelMode ?? "static", context, {
            static: "Edit",
            active: "Editing",
            completed: "Edited",
        }),
        body: formatPathTarget(theme, path),
    });
    const section = streamingEditDiffSection(path, pair);
    const diff = renderCodexDiff(theme, [section], context.expanded, {
        collapsedLineBudget: MUTATION_DIFF_PREVIEW_ROWS,
        maxWrappedRows: 1,
    });
    return makeComponent((width) => [...header.render(width), ...diff.render(width)]);
}
