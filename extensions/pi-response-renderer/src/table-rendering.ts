import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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

// A two-column grapheme cannot fit a one-column terminal. Replace only that
// indivisible grapheme; retaining the ANSI sequences keeps adjacent text styled.
function fitSingleColumn(text: string): string {
    const controls = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/gu;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let result = "";
    let offset = 0;

    const appendText = (part: string) => {
        for (const { segment } of segmenter.segment(part)) {
            if (visibleWidth(segment) > 1) result += "�";
            else result += segment;
        }
    };

    for (const match of text.matchAll(controls)) {
        appendText(text.slice(offset, match.index));
        result += match[0];
        offset = match.index + match[0].length;
    }

    appendText(text.slice(offset));

    return result;
}

function wrapCell(text: string, width: number): string[] {
    if (width === 1) text = fitSingleColumn(text);

    const lines = wrapTextWithAnsi(text, Infinity).flatMap((line) => {
        if (visibleWidth(line) <= width) return [line];

        const leading = /^ +(?=\S)/u.exec(stripVTControlCharacters(line))?.[0].length ?? 0;
        let minimumContentWidth = 1;
        if (
            [
                ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
                    stripVTControlCharacters(line),
                ),
            ].some(({ segment }) => visibleWidth(segment) > 1)
        ) {
            minimumContentWidth = 2;
        }
        const indent = " ".repeat(Math.min(leading, Math.max(0, width - minimumContentWidth)));
        const content = sliceByColumn(line, leading, Infinity);

        return wrapTextWithAnsi(content, width - indent.length).map((part) => `${indent}${part}`);
    });

    return lines.map((line, index) => {
        if (index === lines.length - 1) return line;
        return `${line}\u001b[22;23;24;25;27;28;29;39;49m`;
    });
}

type ColumnKind = "token" | "narrative" | "compact";
type Metrics = { max: number; headerToken: number; bodyToken: number; kind: ColumnKind };

function tokens(text: string): string[] {
    return stripVTControlCharacters(text).split(/\s+/u).filter(Boolean);
}

function columnMetrics(header: string, body: string[]): Metrics {
    const bodyTokens = body.flatMap(tokens);
    const nonempty = body.filter((cell) => tokens(cell).length > 0);
    const long = bodyTokens.filter((token) => visibleWidth(token) >= 20).length;
    let averageWords = tokens(header).length;
    let averageWidth = cellWidth(header);
    if (nonempty.length > 0) {
        averageWords = bodyTokens.length / nonempty.length;
        averageWidth =
            nonempty.reduce((sum, cell) => sum + visibleWidth(stripVTControlCharacters(cell)), 0) /
            nonempty.length;
    }

    let kind: ColumnKind = "compact";
    if (long > 0 && long >= bodyTokens.length - long) kind = "token";
    else if (averageWords >= 4 || averageWidth >= 28) kind = "narrative";

    return {
        max: Math.max(3, cellWidth(header), ...body.map(cellWidth)),
        headerToken: Math.max(0, ...tokens(header).map(visibleWidth)),
        bodyToken: Math.max(0, ...bodyTokens.map(visibleWidth)),
        kind,
    };
}

// Match upstream's bulk water-filling shrink, including left-to-right tie breaks.
function shrink(widths: number[], floors: number[], metrics: Metrics[], amount: number): void {
    for (const kind of ["token", "narrative", "compact"] as const) {
        const indices = widths
            .map((_width, index) => index)
            .filter((index) => metrics[index].kind === kind);
        const slack = (index: number) => Math.max(0, widths[index] - floors[index]);
        const remove = Math.min(
            amount,
            indices.reduce((sum, index) => sum + slack(index), 0),
        );
        if (remove === 0) continue;

        let low = 0;
        let high = Math.max(0, ...indices.map(slack));
        while (low < high) {
            const cap = low + Math.floor((high - low) / 2);
            const removed = indices.reduce(
                (sum, index) => sum + Math.max(0, slack(index) - cap),
                0,
            );
            if (removed > remove) low = cap + 1;
            else high = cap;
        }

        let removed = 0;
        for (const index of indices) {
            const reduction = Math.max(0, slack(index) - low);
            widths[index] -= reduction;
            removed += reduction;
        }

        let remainder = remove - removed;
        for (const index of indices) {
            if (remainder === 0) break;

            if (slack(index) === low) {
                widths[index]--;
                remainder--;
            }
        }

        amount -= remove;
        if (amount === 0) break;
    }
}

function renderRecords(input: TableRenderInput, metrics: Metrics[], width: number): string[] {
    const labelWidth = Math.max(0, ...input.headers.map(cellWidth));
    let minimumValueWidth = 12;
    if (metrics.some((m) => m.kind !== "compact")) minimumValueWidth = 24;

    const aligned = 1 + labelWidth + 2 + minimumValueWidth <= width;
    const result: string[] = [];

    input.rows.forEach((row, rowIndex) => {
        input.headers.forEach((header, i) => {
            const value = row[i] ?? "";
            if (aligned) {
                const indent = 1 + labelWidth + 2;

                wrapCell(value, Math.max(1, width - indent)).forEach((line, index) => {
                    let label = " ".repeat(indent);
                    if (index === 0)
                        label = ` ${input.header(header)}${" ".repeat(labelWidth - cellWidth(header) + 2)}`;

                    result.push(label + line);
                });
            } else {
                const labelIndent = Math.min(1, Math.max(0, width - 2));
                const valueIndent = Math.min(2, Math.max(0, width - 2));

                for (const line of wrapCell(header, Math.max(1, width - labelIndent)))
                    result.push(" ".repeat(labelIndent) + input.header(line));

                for (const line of wrapCell(value, Math.max(1, width - valueIndent)))
                    result.push(" ".repeat(valueIndent) + line);
            }
        });

        if (rowIndex + 1 < input.rows.length) result.push(input.rule("─".repeat(width)));
    });

    return result;
}

export const renderCodexTable: TableRenderer = (input) => {
    const width = Math.max(0, Math.floor(input.width));
    const columns = input.headers.length;
    if (!columns || width === 0) return [];

    const metrics = input.headers.map((header, i) =>
        columnMetrics(
            header,
            input.rows.map((row) => row[i] ?? ""),
        ),
    );
    const budget = width - columns * 2 - (columns - 1) * 2;
    if (budget < columns * 3) {
        if (input.rows.length) return renderRecords(input, metrics, width);

        const header = `| ${input.headers.map((cell) => cell.replace(/\|/gu, "\\|")).join(" | ")} |`;
        const delimiter = `| ${input.headers
            .map((_, i) => {
                if (input.align[i] === "center") return ":---:";
                if (input.align[i] === "right") return "---:";
                if (input.align[i] === "left") return ":---";
                return "---";
            })
            .join(" | ")} |`;

        return [header, delimiter].flatMap((line) => wrapCell(line, width));
    }

    const widths = metrics.map((m) => m.max);
    const floors = metrics.map((m) => {
        let target = 16;
        if (m.kind === "compact") target = Math.max(m.headerToken, Math.min(m.bodyToken, 16));

        return Math.min(m.max, Math.max(3, target));
    });

    shrink(
        floors,
        floors.map(() => 3),
        metrics,
        Math.max(0, floors.reduce((a, b) => a + b, 0) - budget),
    );

    shrink(widths, floors, metrics, Math.max(0, widths.reduce((a, b) => a + b, 0) - budget));

    const affected = input.rows.filter((row) => {
        let tall = 0;

        return (
            metrics.some((m, i) => {
                const value = row[i] ?? "";
                const fragmented = tokens(value).some((token) => visibleWidth(token) > widths[i]);
                if (
                    (m.kind === "compact" && fragmented) ||
                    (m.kind === "token" && widths[i] < 12 && fragmented)
                )
                    return true;

                if (m.kind !== "compact") {
                    const height = wrapCell(value, widths[i]).length;
                    if (height >= 4) tall++;
                    if (m.kind === "narrative" && widths[i] < 12 && height >= 7) return true;
                }

                return false;
            }) || tall >= 2
        );
    }).length;
    let threshold = Math.max(2, Math.ceil(input.rows.length / 3));
    if (input.rows.length === 1) threshold = 1;
    if (input.rows.length && affected >= threshold) return renderRecords(input, metrics, width);

    const separator = (character: string) =>
        input.rule(widths.map((size) => character.repeat(size + 2)).join("  "));

    const result: string[] = [];

    [input.headers, ...input.rows].forEach((row, rowIndex) => {
        const cells = widths.map((size, i) => wrapCell(row[i] ?? "", size));
        const height = Math.max(1, ...cells.map((cell) => cell.length));
        for (let line = 0; line < height; line++) {
            let last = cells.length - 1;
            while (last >= 0 && visibleWidth(cells[last]?.[line] ?? "") === 0) last--;
            const parts = cells.slice(0, last + 1).map((cell, i) => {
                const text = cell[line] ?? "";
                const padding = Math.max(0, widths[i] - visibleWidth(text));
                let left = 0;
                if (input.align[i] === "right") left = padding;
                else if (input.align[i] === "center") left = Math.floor(padding / 2);

                let value = text;
                if (rowIndex === 0) value = input.header(text);

                let right = "";
                if (i !== last) right = " ".repeat(padding - left) + " ";

                return " " + " ".repeat(left) + value + right;
            });

            result.push(parts.join("  "));
        }

        if (rowIndex === 0) result.push(separator("━"));
        else if (rowIndex < input.rows.length) result.push(separator("─"));
    });

    return result;
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
