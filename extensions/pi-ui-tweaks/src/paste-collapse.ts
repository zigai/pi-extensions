import {
    CustomEditor,
    type ExtensionContext,
    type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import {
    installLinkedMethodPatch,
    registerEditorEnhancer,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";
import { matchesRuntimeKey } from "./runtime-key-matching.ts";
import {
    DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD,
    DEFAULT_PASTE_COLLAPSE_ENABLED,
    DEFAULT_PASTE_COLLAPSE_EXPAND_KEY,
    DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD,
    DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY,
} from "./settings.ts";

const PASTE_COLLAPSE_PATCH_MARKER = Symbol.for("zigai.pi-ui-tweaks.paste-collapse-patch");
const PASTE_COLLAPSE_ENHANCER_MARKER = Symbol.for("zigai.pi-ui-tweaks.paste-collapse-enhancer");
const PASTE_COLLAPSE_ENHANCER_KEY = Symbol.for("zigai.pi-ui-tweaks.paste-collapse");
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

const PASTE_MARKER_FOR_ID = (pasteId: number): RegExp =>
    new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`);

const ESCAPE_CHARACTER = String.fromCharCode(27);
const CSI_U_CTRL_SEQUENCE_REGEX = new RegExp(`${ESCAPE_CHARACTER}\\[(\\d+);5u`, "g");

type PasteMarker = {
    readonly pasteId: number;
    readonly content: string;
    readonly line: number;
    readonly start: number;
    readonly end: number;
};

export type PasteCollapseEditorContext = Pick<ExtensionContext, "hasUI"> & {
    ui: Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;
};

export type PasteCollapseSettings = {
    readonly pasteCollapseCharThreshold: number;
    readonly pasteCollapseEnabled: boolean;
    readonly pasteCollapseExpandKey: string | null;
    readonly pasteCollapseLineThreshold: number;
    readonly pasteCollapseUseToolExpandKey: boolean;
};

export type PasteCollapseHandle = {
    update(config: PasteCollapseSettings): void;
    dispose(): void;
};

let currentPasteCollapseSettings: PasteCollapseSettings = {
    pasteCollapseCharThreshold: DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD,
    pasteCollapseEnabled: DEFAULT_PASTE_COLLAPSE_ENABLED,
    pasteCollapseExpandKey: DEFAULT_PASTE_COLLAPSE_EXPAND_KEY,
    pasteCollapseLineThreshold: DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD,
    pasteCollapseUseToolExpandKey: DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY,
};

type EditorState = {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
};

type PasteEditorInternals = {
    state: EditorState;
    pastes: Map<number, string>;
    pasteCounter: number;
    lastAction: unknown;
    cancelAutocomplete(): void;
    exitHistoryBrowsing(): void;
    getText(): string;
    insertTextAtCursorInternal(text: string): void;
    normalizeText(text: string): string;
    pushUndoSnapshot(): void;
    setCursorCol(column: number): void;
    onChange?: (text: string) => void;
};

/** Minimal editor surface needed to expand collapsed paste markers. */
export type PasteCollapseEditor = {
    getCursor(): { line: number; col: number };
    getText(): string;
    handleInput(data: string): void;
    onExtensionShortcut?: (data: string) => boolean;
    requestRenderNow?: () => void;
};

type EditorLike = CustomEditor & PasteCollapseEditor;

type PasteCollapsePatchMarkerView = {
    readonly [PASTE_COLLAPSE_PATCH_MARKER]?: unknown;
};

type PasteCollapseMarkerHandleView = {
    readonly handle?: unknown;
};

type PasteHandleUpdateView = {
    readonly update?: unknown;
};

type PasteEditorRootView = {
    readonly state?: unknown;
    readonly pastes?: unknown;
    readonly cancelAutocomplete?: unknown;
    readonly exitHistoryBrowsing?: unknown;
    readonly getText?: unknown;
    readonly insertTextAtCursorInternal?: unknown;
    readonly normalizeText?: unknown;
    readonly pushUndoSnapshot?: unknown;
    readonly setCursorCol?: unknown;
};

type PasteEditorStateView = {
    readonly lines?: unknown;
    readonly cursorLine?: unknown;
    readonly cursorCol?: unknown;
};

type EditorMethodView = {
    readonly getCursor?: unknown;
    readonly getText?: unknown;
    readonly handleInput?: unknown;
};

type InstalledPastePatch = {
    readonly handle: PasteCollapseHandle;
};

function isPasteEditorInternals(editor: unknown): editor is PasteEditorInternals {
    if (typeof editor !== "object" || editor === null) return false;

    // SAFETY: The object guard permits reading only the optional private editor members.
    const value = editor as PasteEditorRootView;
    const state = value.state;
    if (typeof state !== "object" || state === null) return false;

    // SAFETY: The state guard permits reading only the three optional state fields.
    const stateValue = state as PasteEditorStateView;
    const lines = stateValue.lines;
    if (!Array.isArray(lines) || !lines.every((line): line is string => typeof line === "string")) {
        return false;
    }

    if (
        typeof stateValue.cursorLine !== "number" ||
        typeof stateValue.cursorCol !== "number" ||
        !(value.pastes instanceof Map)
    ) {
        return false;
    }

    const requiredMethods = [
        "cancelAutocomplete",
        "exitHistoryBrowsing",
        "getText",
        "insertTextAtCursorInternal",
        "normalizeText",
        "pushUndoSnapshot",
        "setCursorCol",
    ] as const;
    for (const method of requiredMethods) {
        if (typeof value[method] !== "function") return false;
    }

    return true;
}

function isInstalledPastePatch(value: unknown): value is InstalledPastePatch {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The record guard permits reading only the optional unknown handle.
    const handle = (value as PasteCollapseMarkerHandleView).handle;
    if (typeof handle !== "object" || handle === null) return false;

    // SAFETY: The handle guard permits reading only its two optional unknown methods.
    const view = handle as PasteHandleUpdateView & { readonly dispose?: unknown };
    return typeof view.update === "function" && typeof view.dispose === "function";
}

function hasPasteHandler(value: InstallHost): value is InstallHost & { handlePaste: HandlePaste } {
    return "handlePaste" in value && typeof value.handlePaste === "function";
}

function isInstallHost(value: unknown): value is InstallHost {
    return typeof value === "object" && value !== null;
}

function decodeTerminalControlSequences(pastedText: string): string {
    return pastedText.replace(CSI_U_CTRL_SEQUENCE_REGEX, (match, code) => {
        const codepoint = Number(code);
        if (codepoint >= 97 && codepoint <= 122) {
            return String.fromCharCode(codepoint - 96);
        }

        if (codepoint >= 65 && codepoint <= 90) {
            return String.fromCharCode(codepoint - 64);
        }

        return match;
    });
}

function normalizePastedText(editor: PasteEditorInternals, pastedText: string): string {
    const decodedText = decodeTerminalControlSequences(pastedText);
    const cleanText = editor.normalizeText(decodedText);
    let filteredText = cleanText
        .split("")
        .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
        .join("");

    if (/^[/~.]/.test(filteredText)) {
        const currentLine = editor.state.lines[editor.state.cursorLine] ?? "";
        let charBeforeCursor = "";
        if (editor.state.cursorCol > 0) {
            charBeforeCursor = currentLine[editor.state.cursorCol - 1] ?? "";
        }

        if (charBeforeCursor.length > 0 && /\w/.test(charBeforeCursor)) {
            filteredText = ` ${filteredText}`;
        }
    }

    return filteredText;
}

function shouldCollapsePaste(filteredText: string): boolean {
    const state = currentPasteCollapseSettings;
    if (!state.pasteCollapseEnabled) {
        return false;
    }

    const lineCount = filteredText.split("\n").length;
    return (
        lineCount > state.pasteCollapseLineThreshold ||
        filteredText.length > state.pasteCollapseCharThreshold
    );
}

function pasteMarkerForContent(pasteId: number, filteredText: string): string {
    const lineCount = filteredText.split("\n").length;
    if (lineCount > currentPasteCollapseSettings.pasteCollapseLineThreshold) {
        return `[paste #${pasteId} +${lineCount} lines]`;
    }

    return `[paste #${pasteId} ${filteredText.length} chars]`;
}

function handlePasteWithUiTweaks(editor: PasteEditorInternals, pastedText: string): void {
    editor.cancelAutocomplete();
    editor.exitHistoryBrowsing();
    editor.lastAction = null;
    editor.pushUndoSnapshot();

    const filteredText = normalizePastedText(editor, pastedText);
    if (shouldCollapsePaste(filteredText)) {
        editor.pasteCounter += 1;

        const pasteId = editor.pasteCounter;
        editor.pastes.set(pasteId, filteredText);
        editor.insertTextAtCursorInternal(pasteMarkerForContent(pasteId, filteredText));
        return;
    }

    editor.insertTextAtCursorInternal(filteredText);
}

function findPasteMarkerAtCursor(editor: PasteEditorInternals): PasteMarker | undefined {
    const line = editor.state.lines[editor.state.cursorLine] ?? "";
    const cursorCol = editor.state.cursorCol;

    for (const match of line.matchAll(PASTE_MARKER_REGEX)) {
        const pasteIdText = match.at(1);
        const start = match.index;

        if (pasteIdText === undefined) {
            continue;
        }

        const pasteId = Number.parseInt(pasteIdText, 10);
        const markerText = match[0];
        const end = start + markerText.length;
        if (cursorCol < start || cursorCol > end) {
            continue;
        }

        const content = editor.pastes.get(pasteId);
        if (content === undefined) {
            continue;
        }

        return {
            pasteId,
            content,
            line: editor.state.cursorLine,
            start,
            end,
        };
    }

    return undefined;
}

function hasPasteMarker(editor: PasteEditorInternals, pasteId: number): boolean {
    const markerRegex = PASTE_MARKER_FOR_ID(pasteId);

    return editor.state.lines.some((line) => markerRegex.test(line));
}

function replaceMarkerWithContent(editor: PasteEditorInternals, marker: PasteMarker): void {
    const line = editor.state.lines[marker.line] ?? "";
    const before = line.slice(0, marker.start);
    const after = line.slice(marker.end);
    const replacementLines = marker.content.split("\n");
    const firstReplacementLine = replacementLines[0] ?? "";

    if (replacementLines.length === 1) {
        editor.state.lines[marker.line] = `${before}${firstReplacementLine}${after}`;
    } else {
        const middleReplacementLines = replacementLines.slice(1, -1);
        const lastReplacementLine = replacementLines[replacementLines.length - 1] ?? "";
        editor.state.lines.splice(
            marker.line,
            1,
            `${before}${firstReplacementLine}`,
            ...middleReplacementLines,
            `${lastReplacementLine}${after}`,
        );
    }

    editor.state.cursorLine = marker.line;
    editor.setCursorCol(marker.start);

    if (!hasPasteMarker(editor, marker.pasteId)) {
        editor.pastes.delete(marker.pasteId);
    }

    editor.onChange?.(editor.getText());
}

/**
 * Expands the collapsed paste marker currently under the editor cursor.
 */
export function expandPasteMarkerAtCursor(editor: PasteCollapseEditor): boolean {
    if (!isPasteEditorInternals(editor)) return false;

    const internals = editor;
    const marker = findPasteMarkerAtCursor(internals);
    if (marker === undefined) {
        return false;
    }

    internals.lastAction = null;
    internals.pushUndoSnapshot();
    replaceMarkerWithContent(internals, marker);
    editor.requestRenderNow?.();

    return true;
}

type HandlePaste = (this: PasteEditorRootView, pastedText: string) => void;

type PastePatchRecord = {
    readonly original: HandlePaste;
    readonly patch: LinkedMethodPatchHandle<PasteEditorRootView, [string], void>;
    readonly handle: PasteCollapseHandle;
};

type InstallHost = object & PasteCollapsePatchMarkerView;

function installPasteCollapsePatchOnPrototype(
    prototype: InstallHost,
    settings: PasteCollapseSettings,
): PasteCollapseHandle {
    const installed = prototype[PASTE_COLLAPSE_PATCH_MARKER];
    if (isInstalledPastePatch(installed)) {
        installed.handle.update(settings);
        return installed.handle;
    }

    if (!hasPasteHandler(prototype)) return { update(): void {}, dispose(): void {} };

    const typedTarget = prototype;
    currentPasteCollapseSettings = settings;

    const patch = installLinkedMethodPatch(
        typedTarget,
        "handlePaste",
        (predecessor) =>
            function handlePasteWithConfig(this: PasteEditorRootView, pastedText: string): void {
                if (!isPasteEditorInternals(this)) {
                    predecessor.call(this, pastedText);
                    return;
                }

                handlePasteWithUiTweaks(this, pastedText);
            },
    );
    let disposed = false;
    const handle: PasteCollapseHandle = {
        update(next): void {
            if (!disposed) currentPasteCollapseSettings = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            const marker = prototype[PASTE_COLLAPSE_PATCH_MARKER];
            if (isInstalledPastePatch(marker) && marker.handle === handle) {
                Reflect.deleteProperty(prototype, PASTE_COLLAPSE_PATCH_MARKER);
            }
        },
    };
    const record: PastePatchRecord = { original: patch.predecessor, patch, handle };
    Reflect.set(prototype, PASTE_COLLAPSE_PATCH_MARKER, record);

    return handle;
}

/** Installs or updates paste collapsing on Pi editor prototypes. */
export function installPasteCollapsePatch(
    settings: PasteCollapseSettings,
    prototype?: InstallHost,
): PasteCollapseHandle {
    if (prototype !== undefined) {
        return installPasteCollapsePatchOnPrototype(prototype, settings);
    }

    const editor = installPasteCollapsePatchOnPrototype(Editor.prototype, settings);
    const base: unknown = Object.getPrototypeOf(CustomEditor.prototype);
    if (!isInstallHost(base) || base === Editor.prototype) return editor;

    const custom = installPasteCollapsePatchOnPrototype(base, settings);
    let disposed = false;

    return {
        update(next): void {
            if (disposed) return;

            editor.update(next);
            custom.update(next);
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            custom.dispose();
            editor.dispose();
        },
    };
}

function matchesConfiguredExpandKey(data: string): boolean {
    const expandKey = currentPasteCollapseSettings.pasteCollapseExpandKey;
    if (expandKey === null) {
        return false;
    }

    return matchesRuntimeKey(data, expandKey);
}

function shouldTryExpandPasteMarker(data: string, keybindings: KeybindingsManager): boolean {
    if (matchesConfiguredExpandKey(data)) {
        return true;
    }

    return (
        currentPasteCollapseSettings.pasteCollapseUseToolExpandKey &&
        keybindings.matches(data, "app.tools.expand")
    );
}

function isEditorLike(value: unknown): value is EditorLike {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The object guard permits reading only optional editor methods; the predicate
    // verifies every method required by EditorLike before exposing that contract.
    const view = value as EditorMethodView;
    return (
        typeof view.getCursor === "function" &&
        typeof view.getText === "function" &&
        typeof view.handleInput === "function"
    );
}

type PasteEnhancerRecord = {
    readonly original: ReturnType<PasteCollapseEditorContext["ui"]["getEditorComponent"]>;
    readonly handle: PasteCollapseHandle;
};

type MarkedPasteUi = PasteCollapseEditorContext["ui"] & {
    [PASTE_COLLAPSE_ENHANCER_MARKER]?: PasteEnhancerRecord;
};

/** Installs or updates the paste-marker expansion editor enhancer. */
export function installPasteCollapseEditor(
    ctx: PasteCollapseEditorContext,
    settings: PasteCollapseSettings,
): PasteCollapseHandle {
    const ui: MarkedPasteUi = ctx.ui;
    const installed = ui[PASTE_COLLAPSE_ENHANCER_MARKER];
    if (installed !== undefined) {
        installed.handle.update(settings);
        return installed.handle;
    }

    currentPasteCollapseSettings = settings;

    const original = ctx.ui.getEditorComponent();
    const enhancer = registerEditorEnhancer(
        ctx,
        PASTE_COLLAPSE_ENHANCER_KEY,
        (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
        (editor, tui, _theme, keybindings) => {
            if (!isEditorLike(editor)) return editor;

            editor.requestRenderNow ??= () => tui.requestRender();

            const predecessor = editor.handleInput.bind(editor);

            editor.handleInput = (data: string): void => {
                if (shouldTryExpandPasteMarker(data, keybindings)) {
                    if (editor.onExtensionShortcut?.(data) === true) return;
                    if (expandPasteMarkerAtCursor(editor)) return;
                }

                predecessor(data);
            };

            return editor;
        },
    );
    let disposed = false;
    const handle: PasteCollapseHandle = {
        update(next): void {
            if (!disposed) currentPasteCollapseSettings = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            enhancer.dispose();

            if (ui[PASTE_COLLAPSE_ENHANCER_MARKER]?.handle === handle)
                delete ui[PASTE_COLLAPSE_ENHANCER_MARKER];
        },
    };

    ui[PASTE_COLLAPSE_ENHANCER_MARKER] = { original, handle };
    return handle;
}
