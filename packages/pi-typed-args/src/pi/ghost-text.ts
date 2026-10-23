import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    CURSOR_MARKER,
    isFocusable,
    renderFakeCursor,
    truncateToWidth,
    type EditorComponent,
    type Focusable,
} from "@earendil-works/pi-tui";
import { resolveTypedCommandRoute } from "../command/subcommands.ts";
import type { TypedCommandRegistry } from "../registry.ts";
import type {
    RegisteredTypedCommand,
    TypedCommandGhostText,
    TypedCommandGhostTextContext,
} from "./command-types.ts";
import { commandDisplayName } from "./editor-invocation.ts";

const EXACT_INVOCATION_PATTERN = /^\/(\S+)(?:\s+(\S+))?\s?$/;
const END_CURSOR = `${CURSOR_MARKER}${renderFakeCursor(" ")}`;

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

/** Decorate a compatible Pi editor, or return an incompatible custom editor unchanged. */
export function withGhostText(
    base: EditorComponent,
    getGhostText: () => string | undefined,
    style: (text: string) => string,
): EditorComponent {
    if (!isCursorAwareEditor(base)) {
        return base;
    }

    const render = base.render.bind(base);

    base.render = (width) => {
        const lines = render(width);
        const cursor = readEditorCursor(base);
        const editorText = base.getText();
        if (cursor?.line !== 0 || cursor.col !== editorText.length) return lines;

        const ghostText = getGhostText();
        if (ghostText === undefined) return lines;

        return renderGhostTextOnEditorLines(lines, width, ghostText, style);
    };

    return base;
}
