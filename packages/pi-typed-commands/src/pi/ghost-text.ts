import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    CURSOR_MARKER,
    isFocusable,
    truncateToWidth,
    type AutocompleteProvider,
    type EditorComponent,
    type Focusable,
} from "@earendil-works/pi-tui";
import { resolveTypedCommandRoute } from "../command/subcommands.js";
import type { TypedCommandRegistry } from "../registry.js";
import type {
    RegisteredTypedCommand,
    TypedCommandGhostText,
    TypedCommandGhostTextContext,
} from "./command-types.js";
import { commandDisplayName } from "./editor-invocation.js";

const EXACT_INVOCATION_PATTERN = /^\/(\S+)(?:\s+(\S+))?\s?$/;
const END_CURSOR = `${CURSOR_MARKER}\x1b[7m \x1b[0m`;

type ResolvedGhostText = {
    readonly text: string;
    readonly command: RegisteredTypedCommand;
    readonly subcommand?: string;
};

type CursorAwareEditor = EditorComponent &
    Focusable & {
        getCursor(): unknown;
    };

type EditorCursor = {
    readonly line: number;
    readonly col: number;
};

type GhostTextSubcommandFields = {
    subcommand?: string;
};

function normalizedGhostText(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const normalized = value.replaceAll(/\p{Cc}+/gu, " ").trim();
    if (normalized.length === 0) {
        return undefined;
    }

    return normalized;
}

function resolveConfiguredGhostText(
    configured: TypedCommandGhostText,
    context: TypedCommandGhostTextContext,
): string | undefined {
    if (typeof configured === "string") {
        return normalizedGhostText(configured);
    }

    try {
        return normalizedGhostText(configured(context));
    } catch {
        return undefined;
    }
}

/** Resolve opt-in ghost text for an exact root command or subcommand invocation. */
export function resolveGhostText(
    editorText: string,
    registry: TypedCommandRegistry,
    ctx: ExtensionContext,
): ResolvedGhostText | undefined {
    if (/[\r\n]/.test(editorText)) {
        return undefined;
    }

    const match = EXACT_INVOCATION_PATTERN.exec(editorText);
    const commandName = match?.[1];
    if (commandName === undefined) {
        return undefined;
    }

    const root = registry.get(commandName);
    if (root === undefined) {
        return undefined;
    }

    const subcommandSpelling = match?.[2];
    let command = root;
    let subcommand: string | undefined;
    if (subcommandSpelling !== undefined) {
        const route = resolveTypedCommandRoute(root, subcommandSpelling);
        if (route.status !== "subcommand" || route.subcommand === undefined) {
            return undefined;
        }

        const selected = root.subcommands?.[route.subcommand];
        if (selected === undefined) {
            return undefined;
        }

        subcommand = route.subcommand;
        command = selected;
    }

    const configured = command.ghostText;
    if (configured === undefined) {
        return undefined;
    }

    const subcommandFields: GhostTextSubcommandFields = {};
    if (subcommand !== undefined) {
        subcommandFields.subcommand = subcommand;
    }

    const context: TypedCommandGhostTextContext = {
        ctx,
        commandName: commandDisplayName(root),
        ...subcommandFields,
    };
    const text = resolveConfiguredGhostText(configured, context);
    if (text === undefined) {
        return undefined;
    }

    return {
        text,
        command,
        ...subcommandFields,
    };
}

function isCursorAwareEditor(component: EditorComponent): component is CursorAwareEditor {
    const getCursor: unknown = Reflect.get(component, "getCursor");
    return isFocusable(component) && typeof getCursor === "function";
}

function reflectedValue(target: object, key: string): unknown {
    const value: unknown = Reflect.get(target, key);
    return value;
}

function readEditorCursor(component: CursorAwareEditor): EditorCursor | undefined {
    let value: unknown;
    try {
        value = component.getCursor();
    } catch {
        return undefined;
    }

    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const line: unknown = Reflect.get(value, "line");
    const col: unknown = Reflect.get(value, "col");
    if (!Number.isInteger(line) || !Number.isInteger(col)) {
        return undefined;
    }

    return { line: Number(line), col: Number(col) };
}

/** Insert styled ghost text after the rendered end cursor without changing editor content. */
export function renderGhostTextOnEditorLines(
    lines: readonly string[],
    width: number,
    ghostText: string,
    style: (text: string) => string,
): string[] {
    const result = [...lines];
    const cursorLine = result.findIndex((line) => line.includes(END_CURSOR));
    if (cursorLine < 0) {
        return result;
    }

    const line = result[cursorLine];
    if (line === undefined) {
        return result;
    }

    const insertion = line.indexOf(END_CURSOR) + END_CURSOR.length;
    result[cursorLine] = truncateToWidth(
        `${line.slice(0, insertion)}${style(ghostText)}${line.slice(insertion)}`,
        width,
        "",
    );

    return result;
}

class GhostTextEditor implements EditorComponent, Focusable {
    constructor(
        private readonly base: CursorAwareEditor,
        private readonly getGhostText: () => string | undefined,
        private readonly style: (text: string) => string,
    ) {
        Object.defineProperties(this, {
            onSubmit: {
                configurable: true,
                get: () => this.base.onSubmit,
                set: (value: unknown) => Reflect.set(this.base, "onSubmit", value),
            },
            onChange: {
                configurable: true,
                get: () => this.base.onChange,
                set: (value: unknown) => Reflect.set(this.base, "onChange", value),
            },
            borderColor: {
                configurable: true,
                get: () => this.base.borderColor,
                set: (value: unknown) => Reflect.set(this.base, "borderColor", value),
            },
            wantsKeyRelease: {
                configurable: true,
                get: () => reflectedValue(this.base, "wantsKeyRelease"),
                set: (value: unknown) => Reflect.set(this.base, "wantsKeyRelease", value),
            },
            actionHandlers: {
                configurable: true,
                get: () => reflectedValue(this.base, "actionHandlers"),
                set: (value: unknown) => Reflect.set(this.base, "actionHandlers", value),
            },
            onEscape: {
                configurable: true,
                get: () => reflectedValue(this.base, "onEscape"),
                set: (value: unknown) => Reflect.set(this.base, "onEscape", value),
            },
            onCtrlD: {
                configurable: true,
                get: () => reflectedValue(this.base, "onCtrlD"),
                set: (value: unknown) => Reflect.set(this.base, "onCtrlD", value),
            },
            onPasteImage: {
                configurable: true,
                get: () => reflectedValue(this.base, "onPasteImage"),
                set: (value: unknown) => Reflect.set(this.base, "onPasteImage", value),
            },
            onExtensionShortcut: {
                configurable: true,
                get: () => reflectedValue(this.base, "onExtensionShortcut"),
                set: (value: unknown) => Reflect.set(this.base, "onExtensionShortcut", value),
            },
        });
    }

    get focused(): boolean {
        return this.base.focused;
    }

    set focused(value: boolean) {
        this.base.focused = value;
    }

    render(width: number): string[] {
        const lines = this.base.render(width);
        const cursor = readEditorCursor(this.base);
        const editorText = this.base.getText();
        if (cursor?.line !== 0 || cursor.col !== editorText.length) {
            return lines;
        }

        const ghostText = this.getGhostText();
        if (ghostText === undefined) {
            return lines;
        }

        return renderGhostTextOnEditorLines(lines, width, ghostText, this.style);
    }

    invalidate(): void {
        this.base.invalidate();
    }

    handleInput(data: string): void {
        this.base.handleInput(data);
    }

    getText(): string {
        return this.base.getText();
    }

    getCursor(): unknown {
        return this.base.getCursor();
    }

    setText(text: string): void {
        this.base.setText(text);
    }

    addToHistory(text: string): void {
        this.base.addToHistory?.(text);
    }

    insertTextAtCursor(text: string): void {
        if (this.base.insertTextAtCursor !== undefined) {
            this.base.insertTextAtCursor(text);
            return;
        }

        this.base.setText(`${this.base.getText()}${text}`);
    }

    getExpandedText(): string {
        return this.base.getExpandedText?.() ?? this.base.getText();
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.base.setAutocompleteProvider?.(provider);
    }

    setPaddingX(padding: number): void {
        this.base.setPaddingX?.(padding);
    }

    setAutocompleteMaxVisible(maxVisible: number): void {
        this.base.setAutocompleteMaxVisible?.(maxVisible);
    }

    dispose(): void {
        const dispose: unknown = Reflect.get(this.base, "dispose");
        if (typeof dispose === "function") {
            Reflect.apply(dispose, this.base, []);
        }
    }
}

/** Decorate a compatible Pi editor, or return an incompatible custom editor unchanged. */
export function withGhostText(
    base: EditorComponent,
    getGhostText: () => string | undefined,
    style: (text: string) => string,
): EditorComponent {
    if (!isCursorAwareEditor(base)) {
        return base;
    }

    return new GhostTextEditor(base, getGhostText, style);
}
