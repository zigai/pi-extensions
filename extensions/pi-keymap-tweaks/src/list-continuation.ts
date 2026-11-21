import { installKeyedLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Editor } from "@earendil-works/pi-tui";

const LIST_CONTINUATION_MARKER = Symbol.for("zigai.pi-keymap-tweaks.list-continuation");
const ORDERED_ITEM = /^(\s*)(\d{1,9})([.)])(\s+)/;
const BULLET_ITEM = /^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)?/;

export type EditorLines = {
    readonly lines: readonly string[];
    readonly cursorLine: number;
    readonly cursorCol: number;
};

type ListMarker = {
    readonly prefix: string;
    readonly next: string;

    readonly ordered?: {
        readonly indent: string;
        readonly delimiter: string;
        readonly number: number;
    };
};

function parseListMarker(line: string): ListMarker | undefined {
    const ordered = ORDERED_ITEM.exec(line);
    if (ordered !== null) {
        const [prefix, indent = "", digits = "", delimiter = "", spacing = ""] = ordered;
        const number = Number.parseInt(digits, 10) + 1;
        return {
            prefix,
            next: `${indent}${number}${delimiter}${spacing}`,
            ordered: { indent, delimiter, number },
        };
    }

    const bullet = BULLET_ITEM.exec(line);
    if (bullet === null) return undefined;

    const [prefix, indent = "", symbol = "", spacing = "", task = ""] = bullet;
    let next = `${indent}${symbol}${spacing}`;
    if (task !== "") next += "[ ] ";

    return { prefix, next };
}

function renumberFollowingItems(
    lines: string[],
    start: number,
    ordered: NonNullable<ListMarker["ordered"]>,
): void {
    let expected = ordered.number + 1;

    for (let index = start; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const match = ORDERED_ITEM.exec(line);
        if (match === null) {
            const nested = line.length > ordered.indent.length && line.startsWith(ordered.indent);
            if (nested && /^\s/.test(line.slice(ordered.indent.length))) continue;

            return;
        }

        const [prefix, indent = "", digits = "", delimiter = "", spacing = ""] = match;
        if (indent.length > ordered.indent.length) continue;
        if (indent !== ordered.indent || delimiter !== ordered.delimiter) return;
        if (Number.parseInt(digits, 10) >= expected) return;

        lines[index] = `${indent}${expected}${delimiter}${spacing}${line.slice(prefix.length)}`;
        expected += 1;
    }
}

/**
 * Returns the editor lines after a newline that continues the list item under the cursor,
 * or undefined when the newline should be inserted unchanged.
 */
export function continueList(state: EditorLines): EditorLines | undefined {
    const line = state.lines.at(state.cursorLine);
    if (line === undefined) return undefined;

    const marker = parseListMarker(line);
    if (marker === undefined || state.cursorCol < marker.prefix.length) return undefined;

    const lines = [...state.lines];
    const before = line.slice(0, state.cursorCol);
    const after = line.slice(state.cursorCol);

    if (line.slice(marker.prefix.length).trim().length === 0) {
        lines[state.cursorLine] = "";
        return { lines, cursorLine: state.cursorLine, cursorCol: 0 };
    }

    lines[state.cursorLine] = before;
    lines.splice(state.cursorLine + 1, 0, `${marker.next}${after.trimStart()}`);

    if (marker.ordered !== undefined) {
        renumberFollowingItems(lines, state.cursorLine + 2, marker.ordered);
    }

    return { lines, cursorLine: state.cursorLine + 1, cursorCol: marker.next.length };
}

type NewLineEditor = {
    state: { lines: string[]; cursorLine: number; cursorCol: number };
    lastAction: unknown;
    onChange?: (text: string) => void;
    cancelAutocomplete(): void;
    exitHistoryBrowsing(): void;
    getText(): string;
    pushUndoSnapshot(): void;
    setCursorCol(column: number): void;
};

type NewLineEditorView = {
    readonly state?: unknown;
    readonly onChange?: unknown;
    readonly cancelAutocomplete?: unknown;
    readonly exitHistoryBrowsing?: unknown;
    readonly getText?: unknown;
    readonly pushUndoSnapshot?: unknown;
    readonly setCursorCol?: unknown;
};

type EditorStateView = {
    readonly lines?: unknown;
    readonly cursorLine?: unknown;
    readonly cursorCol?: unknown;
};

function isNewLineEditor(value: unknown): value is NewLineEditor {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The object guard permits reading only optional editor members checked below.
    const editor = value as NewLineEditorView;
    if (typeof editor.state !== "object" || editor.state === null) return false;

    // SAFETY: The state guard permits reading only the optional state fields checked below.
    const state = editor.state as EditorStateView;

    return (
        Array.isArray(state.lines) &&
        state.lines.every((line): line is string => typeof line === "string") &&
        typeof state.cursorLine === "number" &&
        typeof state.cursorCol === "number" &&
        (editor.onChange === undefined || typeof editor.onChange === "function") &&
        typeof editor.cancelAutocomplete === "function" &&
        typeof editor.exitHistoryBrowsing === "function" &&
        typeof editor.getText === "function" &&
        typeof editor.pushUndoSnapshot === "function" &&
        typeof editor.setCursorCol === "function"
    );
}

function addListNewLine(editor: NewLineEditor): boolean {
    const next = continueList(editor.state);
    if (next === undefined) return false;

    editor.cancelAutocomplete();
    editor.exitHistoryBrowsing();
    editor.lastAction = null;
    editor.pushUndoSnapshot();

    editor.state.lines = [...next.lines];
    editor.state.cursorLine = next.cursorLine;
    editor.setCursorCol(next.cursorCol);
    editor.onChange?.(editor.getText());

    return true;
}

export type ListContinuationHandle = {
    update(enabled: boolean): void;
    dispose(): void;
};

type AddNewLineHost = { addNewLine(this: AddNewLineHost): void };

function hasAddNewLine(value: unknown): value is AddNewLineHost {
    return (
        typeof value === "object" &&
        value !== null &&
        "addNewLine" in value &&
        typeof value.addNewLine === "function"
    );
}

export function installListContinuation(enabled: boolean): ListContinuationHandle {
    const prototype: unknown = Editor.prototype;
    if (!hasAddNewLine(prototype)) return { update(): void {}, dispose(): void {} };

    return installKeyedLinkedMethodPatch(
        prototype,
        "addNewLine",
        LIST_CONTINUATION_MARKER,
        enabled,
        (predecessor, isEnabled) =>
            function (this: AddNewLineHost): void {
                if (isEnabled() && isNewLineEditor(this) && addListNewLine(this)) return;

                predecessor.call(this);
            },
    );
}
