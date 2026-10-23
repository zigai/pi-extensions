import {
    sliceByColumn,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { stripVTControlCharacters } from "node:util";

export type TableContent = {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
    readonly align: readonly ("left" | "center" | "right" | null)[];
};

export type TableRenderInput = TableContent & {
    readonly width: number;
    readonly header: (text: string) => string;
    readonly rule: (text: string) => string;
};

export type TableRenderer = (input: TableRenderInput) => string[];

function cellWidth(text: string): number {
    return wrapTextWithAnsi(text, Infinity).reduce(
        (width, line) => Math.max(width, visibleWidth(line)),
        0,
    );
}

function wrapCell(text: string, width: number): string[] {
    const lines = wrapTextWithAnsi(text, Infinity).flatMap((line) => {
        if (visibleWidth(line) <= width) return [line];

        const leading = /^ +(?=\S)/u.exec(stripVTControlCharacters(line))?.[0].length ?? 0;
        const indent = " ".repeat(Math.min(leading, width - 1));
        const content = sliceByColumn(line, leading, Infinity);

        return wrapTextWithAnsi(content, width - indent.length).map((part) => `${indent}${part}`);
    });

    return lines.map((line, index) => {
        if (index === lines.length - 1) return line;
        return `${line}\u001b[22;23;24;25;27;28;29;39m`;
    });
}

export const renderCodexTable: TableRenderer = (input) => {
    const width = Math.max(0, Math.floor(input.width) - 2);
    const columns = input.headers.length;
    if (columns === 0 || width === 0) return [];

    const rows = [input.headers, ...input.rows];
    if (width < columns * 2 + (columns - 1) * 2) {
        return rows.flatMap((row, rowIndex) =>
            input.headers.flatMap((header, index) => {
                const value = row[index] ?? "";
                let text = `${header}: ${value}`;
                if (rowIndex === 0) text = input.header(header);

                return wrapCell(text, width).map((line) => ` ${truncateToWidth(line, width, "")} `);
            }),
        );
    }

    const available = width - (columns - 1) * 2;
    const natural = input.headers.map((_header, index) =>
        Math.max(2, ...rows.map((row) => cellWidth(row[index] ?? ""))),
    );
    const widths = natural.map(() => 2);
    let remaining = available - columns * 2;
    while (remaining > 0) {
        // Grow the narrowest unfinished column. Short fields stop at their natural
        // width; long fields share the remaining space instead of starving one another.
        const column = widths.reduce((chosen, current, index) => {
            if (
                current < (natural[index] ?? 0) &&
                (chosen < 0 || current < (widths[chosen] ?? 0))
            ) {
                return index;
            }

            return chosen;
        }, -1);
        if (column < 0) break;

        widths[column] = (widths[column] ?? 0) + 1;
        remaining -= 1;
    }

    const separator = widths.map((size) => "─".repeat(size)).join("  ");
    const rendered: string[] = [];
    for (const [rowIndex, row] of rows.entries()) {
        const cells = input.headers.map((_header, index) =>
            wrapCell(row[index] ?? "", widths[index] ?? 2),
        );
        const height = Math.max(1, ...cells.map((cell) => cell.length));
        for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
            const parts = cells.map((cell, index) => {
                const text = truncateToWidth(cell[lineIndex] ?? "", widths[index] ?? 2, "");
                const padding = Math.max(0, (widths[index] ?? 2) - visibleWidth(text));
                let left = 0;
                if (rowIndex !== 0 && input.align[index] === "right") left = padding;
                if (rowIndex !== 0 && input.align[index] === "center")
                    left = Math.floor(padding / 2);

                const value = " ".repeat(left) + text + " ".repeat(padding - left);
                if (rowIndex === 0) return input.header(value);
                return value;
            });

            rendered.push(` ${parts.join("  ")} `);
        }

        if (rowIndex < rows.length - 1) {
            let rule = input.rule(separator);
            if (rowIndex === 0) rule = input.header(separator);
            rendered.push(` ${rule} `);
        }
    }

    return rendered;
};

const REGISTRY = Symbol.for("zigai.pi-response-renderer.table-renderers");

type Registry = {
    readonly version: number;
    readonly renderers: Map<string, TableRenderer>;
    readonly listeners: Set<() => void>;
    selection: string;
    previousSelection: string;
    revision: number;
};

function registry(): Registry {
    const state: typeof globalThis & { [REGISTRY]?: Registry } = globalThis;
    state[REGISTRY] ??= {
        version: 1,
        renderers: new Map([["codex", renderCodexTable]]),
        listeners: new Set(),
        selection: "codex",
        previousSelection: "native",
        revision: 0,
    };
    const current = state[REGISTRY];
    if (current.version !== 1) throw new Error("Unsupported table renderer registry version");
    return current;
}

function changed(): void {
    const state = registry();
    state.revision += 1;
    for (const listener of state.listeners) listener();
}

export function selectTableRenderer(name: string): void {
    if (name !== "native" && !registry().renderers.has(name)) {
        throw new Error(`Unknown table renderer: ${name}`);
    }

    const state = registry();
    if (state.selection !== name) state.previousSelection = state.selection;
    state.selection = name;
    changed();
}

export function registerTableRenderer(name: string, renderer: TableRenderer) {
    const state = registry();
    if (name === "native" || name === "codex" || state.renderers.has(name)) {
        throw new Error(`Table renderer already registered: ${name}`);
    }

    state.renderers.set(name, renderer);
    changed();

    let disposed = false;

    return {
        update(next: TableRenderer): void {
            if (disposed) return;

            state.renderers.set(name, next);
            changed();
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            state.renderers.delete(name);

            if (state.selection === name) {
                state.selection = state.previousSelection;
                if (state.selection !== "native" && !state.renderers.has(state.selection))
                    state.selection = "codex";
            }

            changed();
        },
    };
}

export function tableRenderingState() {
    const state = registry();
    return {
        name: state.selection,
        renderer: state.renderers.get(state.selection),
        revision: state.revision,
    };
}

export function observeTableRendering(listener: () => void): () => void {
    registry().listeners.add(listener);

    return () => {
        registry().listeners.delete(listener);
    };
}
