import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    type Component,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import { buildSplitDiffRows, buildUnifiedDiffRows, normalizePierreDiffPayload } from "./diff.ts";
import {
    emptyHighlightedDiffSet,
    highlightDiffIfLoaded,
    loadHighlightedDiff,
} from "./highlight.ts";
import type {
    DiffSpan,
    HighlightedDiffSet,
    PierreDiffPayload,
    PierreRenderableDiffPayload,
    PierreSummaryDiffPayload,
    SplitDiffCell,
    SplitDiffRow,
    UnifiedDiffRow,
} from "./types.ts";
import { getPierrePalette, type PierreTerminalPalette } from "./theme.ts";
import {
    MUTATION_DIFF_PREVIEW_ROWS,
    selectSemanticDiffIndices,
    type SemanticDiffRowKind,
} from "../rendering/core.ts";

const ANSI_SEQUENCE_PREFIX = ansiStyles.modifier.reset.open.slice(0, 2);
const DIFF_STYLE_RESET = `${ansiStyles.modifier.bold.close}${ansiStyles.color.close}${ansiStyles.bgColor.close}`;
const SIDE_BY_SIDE_MIN_WIDTH = 140;
const INITIAL_TTY_DIFF_HIGHLIGHT_DEFER_MS = 1_500;
const MAX_QUEUED_DIFF_HIGHLIGHTS = 50;
const MAX_ACTIVE_DIFF_HIGHLIGHT_TIMERS = 16;
const MAX_EXPANDED_DIFF_RENDER_LINES = 5_000;
const DISABLE_INITIAL_DEFER_ENV = "PI_CODEX_LOOK_DISABLE_INITIAL_SYNTAX_DEFER";
const moduleLoadedAtMs = Date.now();

let highlightGeneration = 0;
let queuedDiffHighlightRunning = false;
let queuedDiffHighlightTimer: ReturnType<typeof setTimeout> | undefined;
const activeDiffHighlightTimers = new Set<ReturnType<typeof setTimeout>>();
const queuedDiffHighlights: Array<{
    readonly generation: number;
    readonly run: () => Promise<void>;
    readonly resolve: () => void;
}> = [];

type AnsiStyle = {
    readonly fg: string | undefined;
    readonly bg: string | undefined;
    readonly bold: boolean | undefined;
};

type RenderSegment = DiffSpan & {
    readonly bold?: boolean;
};

function collapsedPierreRows<T>(
    rows: readonly T[],
    kinds: readonly SemanticDiffRowKind[],
    rowBudget: number,
    omission: (count: number) => T,
): readonly T[] {
    if (rows.length <= rowBudget) {
        return rows;
    }
    const selected = selectSemanticDiffIndices(kinds, Math.max(1, rowBudget - 1));
    const split = Math.ceil(selected.length / 2);
    const head = selected
        .slice(0, split)
        .map((index) => rows[index])
        .filter(isDefined);
    const tail = selected
        .slice(split)
        .map((index) => rows[index])
        .filter(isDefined);
    return [...head, omission(rows.length - selected.length), ...tail];
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

/** Context fields Pierre's lazy renderer consumes from Pi's public render context. */
export type PierreDiffRenderContext = {
    readonly lastComponent: Component | undefined;
    readonly invalidate?: () => void;
    readonly toolCallId?: string;
};

/** Returns whether a terminal width is wide enough for side-by-side diffs. */
export function shouldRenderSideBySideDiff(width: number): boolean {
    return width >= SIDE_BY_SIDE_MIN_WIDTH;
}

/** Renders a replayable Pierre diff payload with lazy syntax highlighting. */
export function renderPierreDiff(
    payload: PierreDiffPayload,
    theme: Theme,
    options: { readonly expanded: boolean },
    context: PierreDiffRenderContext,
): Component {
    if (payload.kind === "summary") {
        return renderPierreDiffSummary(payload, theme);
    }

    const maxVisibleLines = options.expanded
        ? maxVisibleDiffLines(true)
        : MUTATION_DIFF_PREVIEW_ROWS + 1;
    const component =
        context.lastComponent instanceof PierreDiffComponent
            ? context.lastComponent
            : new PierreDiffComponent(payload, theme, maxVisibleLines, options.expanded);

    component.update(payload, theme, maxVisibleLines, options.expanded);
    return component;
}

/** Reads a Pierre payload from result details when present and safe to render. */
export function getPierreDiffPayloadFromDetails(details: unknown): PierreDiffPayload | undefined {
    if (!isRecord(details)) {
        return undefined;
    }
    return normalizePierreDiffPayload(details.pierreDiff);
}

/** Returns bounded lazy-diff scheduler stats for diagnostics. */
export function pierreDiffHighlightStats(): {
    readonly activeTimers: number;
    readonly queuedHighlights: number;
    readonly queueRunning: boolean;
} {
    return {
        activeTimers: activeDiffHighlightTimers.size,
        queuedHighlights: queuedDiffHighlights.length,
        queueRunning: queuedDiffHighlightRunning,
    };
}

class PierreDiffComponent implements Component {
    private payload: PierreRenderableDiffPayload;
    private palette: PierreTerminalPalette;
    private highlighted: HighlightedDiffSet;
    private maxVisibleLines: number;
    private expanded: boolean;
    private refreshPromise: Promise<void> | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshKey: string | undefined;
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(
        payload: PierreRenderableDiffPayload,
        theme: Theme,
        maxVisibleLines: number,
        expanded: boolean,
    ) {
        this.payload = payload;
        this.palette = getPierrePalette(theme);
        this.highlighted = emptyHighlightedDiffSet();
        this.maxVisibleLines = maxVisibleLines;
        this.expanded = expanded;
        if (this.expanded) {
            this.maybeRefreshHighlightedDiff();
        }
    }

    update(
        payload: PierreRenderableDiffPayload,
        theme: Theme,
        maxVisibleLines: number,
        expanded: boolean,
    ): void {
        const previousPayload = this.payload;
        const previousKey = refreshKeyFor(previousPayload);
        const nextKey = refreshKeyFor(payload);
        const nextPalette = getPierrePalette(theme);
        const canReuseRenderedCache =
            previousPayload === payload &&
            this.maxVisibleLines === maxVisibleLines &&
            this.expanded === expanded &&
            pierrePalettesEqual(this.palette, nextPalette);

        this.payload = payload;
        this.palette = nextPalette;
        this.maxVisibleLines = maxVisibleLines;
        this.expanded = expanded;
        if (!this.expanded) {
            this.highlighted = emptyHighlightedDiffSet();
            this.refreshPromise = undefined;
            this.clearRefreshTimer();
        }
        if (!canReuseRenderedCache) {
            this.invalidate();
        }
        if (previousKey !== nextKey) {
            this.highlighted = emptyHighlightedDiffSet();
            this.refreshPromise = undefined;
            this.clearRefreshTimer();
            this.refreshKey = undefined;
        }
        if (this.expanded) {
            this.maybeRefreshHighlightedDiff();
        }
    }

    render(width: number): string[] {
        const safeWidth = Math.max(24, Math.floor(width));
        this.highlightVisibleRenderIfPossible();
        if (this.cachedWidth === safeWidth && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const highlighted = this.highlighted[this.palette.appearance];
        const bodyLines =
            this.expanded && shouldRenderSideBySideDiff(safeWidth)
                ? this.renderSplitBody(safeWidth, highlighted)
                : this.renderUnifiedBody(safeWidth, highlighted);
        const lines = bodyLines;

        if (lines.length <= this.maxVisibleLines) {
            this.cachedWidth = safeWidth;
            this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth, ""));
            return this.cachedLines;
        }

        const visible = Math.max(1, this.maxVisibleLines - 1);
        this.cachedWidth = safeWidth;
        this.cachedLines = [
            ...lines.slice(0, visible),
            renderFullWidthLine(
                [
                    {
                        text: `… ${omittedDiffLineCount(this.payload, lines.length, visible).toLocaleString("en-US")} more lines`,
                        fg: this.palette.metadataFg,
                        bg: this.palette.metadataBg,
                    },
                ],
                safeWidth,
                baseStyle({ fg: this.palette.metadataFg, bg: this.palette.metadataBg }),
            ),
        ].map((line) => truncateToWidth(line, safeWidth, ""));
        return this.cachedLines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    private highlightVisibleRenderIfPossible(): void {
        if (!this.expanded) {
            return;
        }
        if (hasHighlightedLines(this.highlighted)) {
            return;
        }
        const highlighted = highlightDiffIfLoaded(this.payload.metadata);
        if (!highlighted) {
            return;
        }
        this.highlighted = highlighted;
        this.invalidate();
    }

    private renderUnifiedBody(width: number, highlighted: HighlightedDiffSet["dark"]): string[] {
        const sourceRows = buildUnifiedDiffRows(this.payload.metadata, highlighted, this.palette, {
            maxRows: this.expanded ? this.maxVisibleLines + 1 : MAX_EXPANDED_DIFF_RENDER_LINES,
        });
        const rows = this.expanded
            ? sourceRows
            : collapsedPierreRows(
                  sourceRows,
                  sourceRows.map((row): SemanticDiffRowKind => {
                      if (row.kind !== "line") return "meta";
                      if (row.lineType === "addition") return "insert";
                      if (row.lineType === "deletion") return "delete";
                      return "context";
                  }),
                  this.maxVisibleLines,
                  (count): UnifiedDiffRow => ({
                      kind: "collapsed",
                      text: `… +${count} lines (${pierreExpandHint()})`,
                      fg: this.palette.metadataFg,
                      bg: this.palette.metadataBg,
                  }),
              );
        return renderUnifiedRows(
            rows,
            this.payload.metadata,
            width,
            this.maxVisibleLines + 1,
            this.expanded ? undefined : 1,
        );
    }

    private renderSplitBody(width: number, highlighted: HighlightedDiffSet["dark"]): string[] {
        const sourceRows = buildSplitDiffRows(this.payload.metadata, highlighted, this.palette, {
            maxRows: this.expanded ? this.maxVisibleLines + 1 : MAX_EXPANDED_DIFF_RENDER_LINES,
        });
        const rows = this.expanded
            ? sourceRows
            : collapsedPierreRows(
                  sourceRows,
                  sourceRows.map((row): SemanticDiffRowKind => {
                      if (row.kind !== "line") return "meta";
                      const hasAddition = row.addition.lineType === "addition";
                      const hasDeletion = row.deletion.lineType === "deletion";
                      if (hasAddition && !hasDeletion) return "insert";
                      if (hasDeletion && !hasAddition) return "delete";
                      return hasAddition ? "insert" : "context";
                  }),
                  this.maxVisibleLines,
                  (count): SplitDiffRow => ({
                      kind: "collapsed",
                      text: `… +${count} lines (${pierreExpandHint()})`,
                      fg: this.palette.metadataFg,
                      bg: this.palette.metadataBg,
                  }),
              );
        return renderSplitRows(
            rows,
            this.payload.metadata,
            width,
            this.palette,
            this.maxVisibleLines + 1,
            this.expanded ? undefined : 1,
        );
    }

    private maybeRefreshHighlightedDiff(): void {
        if (!this.expanded) {
            return;
        }
        if (hasHighlightedLines(this.highlighted)) {
            return;
        }
        if (activeDiffHighlightTimers.size >= MAX_ACTIVE_DIFF_HIGHLIGHT_TIMERS) {
            return;
        }

        const nextKey = refreshKeyFor(this.payload);
        if ((this.refreshPromise || this.refreshTimer) && this.refreshKey === nextKey) {
            return;
        }

        this.refreshKey = nextKey;
        const generation = highlightGeneration;
        const timer = setTimeout(() => {
            activeDiffHighlightTimers.delete(timer);
            if (this.refreshTimer === timer) {
                this.refreshTimer = undefined;
            }
            if (generation !== highlightGeneration || this.refreshKey !== nextKey) {
                return;
            }
            if (hasHighlightedLines(this.highlighted)) {
                return;
            }
            this.refreshPromise = runQueuedDiffHighlight(() =>
                loadHighlightedDiff(this.payload.metadata).then((highlighted) => {
                    if (generation !== highlightGeneration || this.refreshKey !== nextKey) {
                        return;
                    }
                    this.highlighted = highlighted;
                    this.invalidate();
                }),
            )
                .catch(() => {})
                .finally(() => {
                    if (this.refreshKey === nextKey) {
                        this.refreshPromise = undefined;
                    }
                });
        }, initialDiffHighlightDelayMs());
        timer.unref?.();
        this.refreshTimer = timer;
        activeDiffHighlightTimers.add(timer);
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer === undefined) {
            return;
        }
        clearTimeout(this.refreshTimer);
        activeDiffHighlightTimers.delete(this.refreshTimer);
        this.refreshTimer = undefined;
    }
}

function renderPierreDiffSummary(payload: PierreSummaryDiffPayload, theme: Theme): Component {
    return {
        render(width: number): string[] {
            const safeWidth = Math.max(24, Math.floor(width));
            const changeStats = `${payload.stats.added.toLocaleString("en-US")} + / ${payload.stats.removed.toLocaleString("en-US")} -`;
            const headline = `${theme.fg("toolDiffContext", payload.path)} ${theme.fg("muted", changeStats)}`;
            const hint = "Use git diff or read the file directly to inspect the full change.";
            return [
                truncateToWidth(headline, safeWidth, ""),
                truncateToWidth(`  └ ${theme.fg("muted", summaryDetail(payload))}`, safeWidth, ""),
                truncateToWidth(`    ${theme.fg("muted", hint)}`, safeWidth, ""),
            ];
        },
        invalidate() {},
    };
}

function pierreExpandHint(): string {
    try {
        return keyHint("app.tools.expand", "to expand");
    } catch {
        return "expand to inspect";
    }
}

function omittedDiffLineCount(
    payload: PierreRenderableDiffPayload,
    renderedLineCount: number,
    visibleLineCount: number,
): number {
    return Math.max(
        1,
        renderedLineCount - visibleLineCount,
        payload.stats.lineCount - visibleLineCount,
    );
}

function summaryDetail(payload: PierreSummaryDiffPayload): string {
    if (payload.summary.reason === "not-readable") {
        return `Diff omitted: ${payload.path} could not be read safely.`;
    }
    if (payload.summary.reason === "metadata-too-large") {
        return "Diff omitted: generated diff metadata exceeded the render budget.";
    }
    return `Large diff omitted: ${formatDiffSize(payload.stats.sizeBytes)} / ${payload.stats.lineCount.toLocaleString("en-US")} lines exceeds ${formatDiffSize(payload.summary.maxBytes)} or ${payload.summary.maxLines.toLocaleString("en-US")} lines`;
}

function formatDiffSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function runQueuedDiffHighlight(run: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
        queuedDiffHighlights.push({ generation: highlightGeneration, run, resolve });
        trimQueuedDiffHighlights();
        scheduleQueuedDiffHighlight();
    });
}

/** Drops pending lazy syntax-highlight work during extension shutdown. */
export function clearQueuedDiffHighlights(): void {
    highlightGeneration += 1;
    for (const timer of activeDiffHighlightTimers) {
        clearTimeout(timer);
    }
    activeDiffHighlightTimers.clear();
    if (queuedDiffHighlightTimer !== undefined) {
        clearTimeout(queuedDiffHighlightTimer);
        queuedDiffHighlightTimer = undefined;
    }

    const pendingTasks = queuedDiffHighlights.splice(0);
    for (const task of pendingTasks) {
        task.resolve();
    }
    queuedDiffHighlightRunning = false;
}

function trimQueuedDiffHighlights(): void {
    while (queuedDiffHighlights.length > MAX_QUEUED_DIFF_HIGHLIGHTS) {
        queuedDiffHighlights.shift()?.resolve();
    }
}

function scheduleDiffHighlightQueueTimer(delayMs: number): void {
    if (queuedDiffHighlightTimer !== undefined) {
        clearTimeout(queuedDiffHighlightTimer);
    }
    queuedDiffHighlightTimer = setTimeout(() => {
        queuedDiffHighlightTimer = undefined;
        processNextQueuedDiffHighlight();
    }, delayMs);
    queuedDiffHighlightTimer.unref?.();
}

function scheduleQueuedDiffHighlight(): void {
    if (queuedDiffHighlightRunning) {
        return;
    }
    queuedDiffHighlightRunning = true;
    scheduleDiffHighlightQueueTimer(0);
}

function processNextQueuedDiffHighlight(): void {
    const task = queuedDiffHighlights.shift();
    if (!task) {
        queuedDiffHighlightRunning = false;
        return;
    }

    if (task.generation !== highlightGeneration) {
        task.resolve();
        scheduleDiffHighlightQueueTimer(0);
        return;
    }

    const taskGeneration = task.generation;
    task.run()
        .catch(() => {})
        .finally(() => {
            task.resolve();
            if (taskGeneration !== highlightGeneration) {
                queuedDiffHighlightRunning = false;
                return;
            }
            scheduleDiffHighlightQueueTimer(100);
        });
}

function initialDiffHighlightDelayMs(): number {
    if (
        process.env[DISABLE_INITIAL_DEFER_ENV] === "1" ||
        process.stdout.isTTY !== true ||
        !isLikelySessionRestore()
    ) {
        return 0;
    }
    return Math.max(0, INITIAL_TTY_DIFF_HIGHLIGHT_DEFER_MS - (Date.now() - moduleLoadedAtMs));
}

function isLikelySessionRestore(): boolean {
    return process.argv.some(
        (arg) =>
            arg === "--session" ||
            arg.startsWith("--session=") ||
            arg === "--continue" ||
            arg === "-c" ||
            arg === "--resume" ||
            arg === "-r" ||
            arg === "--fork" ||
            arg.startsWith("--fork="),
    );
}

function renderUnifiedRows(
    rows: ReadonlyArray<UnifiedDiffRow>,
    metadata: PierreRenderableDiffPayload["metadata"],
    width: number,
    maxRenderedLines: number,
    maxRowsPerDiffRow: number | undefined,
): string[] {
    const rendered: string[] = [];
    for (const row of rows) {
        const rowLines = renderUnifiedRow(row, metadata, width);
        if (
            appendBudgetedRenderedLines(
                rendered,
                maxRowsPerDiffRow === undefined ? rowLines : rowLines.slice(0, maxRowsPerDiffRow),
                maxRenderedLines,
            )
        ) {
            break;
        }
    }
    return rendered;
}

function renderSplitRows(
    rows: ReadonlyArray<SplitDiffRow>,
    metadata: PierreRenderableDiffPayload["metadata"],
    width: number,
    palette: PierreTerminalPalette,
    maxRenderedLines: number,
    maxRowsPerDiffRow: number | undefined,
): string[] {
    const rendered: string[] = [];
    for (const row of rows) {
        const rowLines = renderSplitRow(row, metadata, width, palette);
        if (
            appendBudgetedRenderedLines(
                rendered,
                maxRowsPerDiffRow === undefined ? rowLines : rowLines.slice(0, maxRowsPerDiffRow),
                maxRenderedLines,
            )
        ) {
            break;
        }
    }
    return rendered;
}

function appendBudgetedRenderedLines(
    target: string[],
    lines: ReadonlyArray<string>,
    maxRenderedLines: number,
): boolean {
    if (target.length + lines.length <= maxRenderedLines) {
        target.push(...lines);
        return target.length >= maxRenderedLines;
    }

    const remaining = Math.max(0, maxRenderedLines - target.length);
    target.push(...lines.slice(0, remaining));
    return true;
}

function renderUnifiedRow(
    row: UnifiedDiffRow,
    metadata: PierreRenderableDiffPayload["metadata"],
    width: number,
): string[] {
    if (row.kind !== "line") {
        const lineNumberWidth = lineNumberWidthFor(metadata);
        const text =
            row.kind === "collapsed" ? ` ${" ".repeat(lineNumberWidth)} ${row.text}` : row.text;
        return [
            renderFullWidthLine(
                [{ text, fg: row.fg, bg: row.bg }],
                width,
                baseStyle({ fg: row.fg, bg: row.bg }),
            ),
        ];
    }

    const lineNumberWidth = lineNumberWidthFor(metadata);
    const marker = markerForLineType(row.lineType);
    const firstPrefix = `${marker}${formatLineNumber(row.lineNumber, lineNumberWidth)} `;
    const restPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(8, width - visibleWidth(firstPrefix));
    const content = renderContent(row.spans, baseStyle({ fg: row.rowFg, bg: row.rowBg }));
    if (visibleWidth(content) === 0) {
        const prefix = renderDiffPrefix(firstPrefix, row.rowFg, row.lineNumberFg, row.rowBg);
        if (row.lineType === "context") {
            return [`${prefix}${DIFF_STYLE_RESET}`];
        }
        return [padRenderedLine(prefix, width, baseStyle({ fg: row.rowFg, bg: row.rowBg }))];
    }

    const wrapped = wrapTextWithAnsi(content, contentWidth);
    const segments = wrapped.length > 0 ? wrapped : [""];

    return segments.map((segment, index) => {
        const prefix = index === 0 ? firstPrefix : restPrefix;
        const currentPrefixAnsi = renderDiffPrefix(prefix, row.rowFg, row.lineNumberFg, row.rowBg);
        return padRenderedLine(
            `${currentPrefixAnsi}${segment}`,
            width,
            baseStyle({ fg: row.rowFg, bg: row.rowBg }),
        );
    });
}

function renderSplitRow(
    row: SplitDiffRow,
    metadata: PierreRenderableDiffPayload["metadata"],
    width: number,
    palette: PierreTerminalPalette,
): string[] {
    if (row.kind !== "line") {
        const lineNumberWidth = lineNumberWidthFor(metadata);
        const text =
            row.kind === "collapsed" ? ` ${" ".repeat(lineNumberWidth)} ${row.text}` : row.text;
        return [
            renderFullWidthLine(
                [{ text, fg: row.fg, bg: row.bg }],
                width,
                baseStyle({ fg: row.fg, bg: row.bg }),
            ),
        ];
    }

    const divider = renderFullWidthLine(
        [{ text: " │ ", fg: palette.dividerFg, bg: palette.dividerBg }],
        3,
        baseStyle({ fg: palette.dividerFg, bg: palette.dividerBg }),
    );
    const leftWidth = Math.max(24, Math.floor((width - visibleWidth(divider)) / 2));
    const rightWidth = Math.max(24, width - visibleWidth(divider) - leftWidth);
    const lineNumberWidth = lineNumberWidthFor(metadata);
    const deletionLines = renderSplitCell(row.deletion, leftWidth, lineNumberWidth);
    const additionLines = renderSplitCell(row.addition, rightWidth, lineNumberWidth);
    const rowCount = Math.max(deletionLines.length, additionLines.length);
    const rendered: string[] = [];

    for (let index = 0; index < rowCount; index += 1) {
        const deletionLine = deletionLines[index] ?? emptyPane(leftWidth, row.deletion);
        const additionLine = additionLines[index] ?? emptyPane(rightWidth, row.addition);
        rendered.push(`${deletionLine}${divider}${additionLine}`);
    }

    return rendered;
}

function renderSplitCell(cell: SplitDiffCell, width: number, lineNumberWidth: number): string[] {
    const marker = markerForLineType(cell.lineType);
    const firstPrefix = `${marker}${formatLineNumber(cell.lineNumber, lineNumberWidth)} `;
    const restPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(8, width - visibleWidth(firstPrefix));
    const content = renderContent(cell.spans, baseStyle({ fg: cell.rowFg, bg: cell.rowBg }));
    if (visibleWidth(content) === 0) {
        const prefix = renderDiffPrefix(firstPrefix, cell.rowFg, cell.lineNumberFg, cell.rowBg);
        if (cell.lineType === "context" || cell.lineType === "empty") {
            return [`${prefix}${DIFF_STYLE_RESET}`];
        }
        return [padRenderedLine(prefix, width, baseStyle({ fg: cell.rowFg, bg: cell.rowBg }))];
    }

    const wrapped = wrapTextWithAnsi(content, contentWidth);
    const segments = wrapped.length > 0 ? wrapped : [""];

    return segments.map((segment, index) => {
        const prefix = index === 0 ? firstPrefix : restPrefix;
        const currentPrefixAnsi = renderDiffPrefix(
            prefix,
            cell.rowFg,
            cell.lineNumberFg,
            cell.rowBg,
        );
        return padRenderedLine(
            `${currentPrefixAnsi}${segment}`,
            width,
            baseStyle({ fg: cell.rowFg, bg: cell.rowBg }),
        );
    });
}

function renderDiffPrefix(
    prefix: string,
    markerFg: string,
    lineNumberFg: string,
    rowBg: string,
): string {
    return renderSegments(
        [
            { text: prefix.slice(0, 1), fg: markerFg, bg: rowBg },
            { text: prefix.slice(1), fg: lineNumberFg, bg: rowBg },
        ],
        baseStyle({ fg: markerFg, bg: rowBg }),
    );
}

function renderContent(spans: ReadonlyArray<DiffSpan>, base: AnsiStyle): string {
    if (spans.length === 0) {
        return "";
    }
    return renderSegments(spans, base);
}

function emptyPane(width: number, cell: SplitDiffCell): string {
    return renderFullWidthLine([], width, baseStyle({ fg: cell.rowFg, bg: cell.rowBg }));
}

function renderFullWidthLine(
    segments: ReadonlyArray<RenderSegment>,
    width: number,
    base: AnsiStyle,
): string {
    const rendered = renderSegments(segments, base);
    return padRenderedLine(truncateToWidth(rendered, width, ""), width, base);
}

function padRenderedLine(line: string, width: number, base: AnsiStyle): string {
    const targetWidth = Math.max(1, width - 1);
    const truncated = truncateToWidth(line, targetWidth, "");
    const padding = Math.max(0, targetWidth - visibleWidth(truncated));
    return `${truncated}${openAnsi(base)}${" ".repeat(padding)}${DIFF_STYLE_RESET}`;
}

function renderSegments(segments: ReadonlyArray<RenderSegment>, base: AnsiStyle): string {
    let output = openAnsi(base);
    for (const segment of segments) {
        output += openAnsi(
            baseStyle({
                fg: segment.fg ?? base.fg,
                bg: segment.bg ?? base.bg,
                bold: segment.bold ?? base.bold,
            }),
        );
        output += segment.text;
    }
    output += openAnsi(base);
    return output;
}

function openAnsi(style: AnsiStyle): string {
    const fg = toRgb(style.fg);
    const bg = toRgb(style.bg);

    return [
        style.bold === true ? ansiStyles.modifier.bold.open : ansiStyles.modifier.bold.close,
        isAnsiStyle(style.fg)
            ? style.fg
            : fg === undefined
              ? ansiStyles.color.close
              : ansiStyles.color.ansi16m(fg.red, fg.green, fg.blue),
        isAnsiStyle(style.bg)
            ? style.bg
            : bg === undefined
              ? ansiStyles.bgColor.close
              : ansiStyles.bgColor.ansi16m(bg.red, bg.green, bg.blue),
    ].join("");
}

function isAnsiStyle(value: string | undefined): boolean {
    return value?.startsWith(ANSI_SEQUENCE_PREFIX) ?? false;
}

function baseStyle(input: {
    readonly fg: string | undefined;
    readonly bg: string | undefined;
    readonly bold?: boolean | undefined;
}): AnsiStyle {
    return {
        fg: input.fg,
        bg: input.bg,
        bold: input.bold,
    };
}

function toRgb(hex: string | undefined):
    | {
          readonly red: number;
          readonly green: number;
          readonly blue: number;
      }
    | undefined {
    const normalized = hex?.trim();
    if (normalized === undefined || !/^#[0-9a-fA-F]{6}$/.test(normalized)) {
        return undefined;
    }

    return {
        red: Number.parseInt(normalized.slice(1, 3), 16),
        green: Number.parseInt(normalized.slice(3, 5), 16),
        blue: Number.parseInt(normalized.slice(5, 7), 16),
    };
}

function formatLineNumber(lineNumber: number | undefined, width: number): string {
    return lineNumber === undefined ? " ".repeat(width) : String(lineNumber).padStart(width, " ");
}

function markerForLineType(lineType: SplitDiffCell["lineType"] | UnifiedDiffRowLineType): string {
    if (lineType === "addition") {
        return "+";
    }
    if (lineType === "deletion") {
        return "-";
    }
    return " ";
}

type UnifiedDiffRowLineType = Extract<UnifiedDiffRow, { readonly kind: "line" }>["lineType"];

function lineNumberWidthFor(metadata: PierreRenderableDiffPayload["metadata"]): number {
    let maxLineNumber = 1;
    for (const hunk of metadata.hunks) {
        maxLineNumber = Math.max(
            maxLineNumber,
            hunk.deletionStart + Math.max(0, hunk.deletionCount - 1),
            hunk.additionStart + Math.max(0, hunk.additionCount - 1),
        );
    }
    return String(maxLineNumber).length;
}

function hasHighlightedLines(highlighted: HighlightedDiffSet): boolean {
    return (
        highlighted.dark.deletionLines.length > 0 ||
        highlighted.dark.additionLines.length > 0 ||
        highlighted.light.deletionLines.length > 0 ||
        highlighted.light.additionLines.length > 0
    );
}

function refreshKeyFor(payload: PierreRenderableDiffPayload): string {
    return `${payload.path}\u0000${payload.metadata.cacheKey ?? ""}\u0000${payload.stats.lineCount}\u0000${payload.stats.added}\u0000${payload.stats.removed}\u0000${payload.metadata.lang ?? ""}`;
}

function pierrePalettesEqual(left: PierreTerminalPalette, right: PierreTerminalPalette): boolean {
    return (
        left.appearance === right.appearance &&
        left.contextFg === right.contextFg &&
        left.contextRowBg === right.contextRowBg &&
        left.additionFg === right.additionFg &&
        left.additionRowBg === right.additionRowBg &&
        left.deletionFg === right.deletionFg &&
        left.deletionRowBg === right.deletionRowBg &&
        left.emptyFg === right.emptyFg &&
        left.emptyRowBg === right.emptyRowBg &&
        left.lineNumberFg === right.lineNumberFg &&
        left.metadataFg === right.metadataFg &&
        left.metadataBg === right.metadataBg &&
        left.dividerFg === right.dividerFg &&
        left.dividerBg === right.dividerBg
    );
}

function maxVisibleDiffLines(expanded: boolean): number {
    const terminalRows = typeof process.stdout.rows === "number" ? process.stdout.rows : 40;
    const expandedLimit = Math.min(
        MAX_EXPANDED_DIFF_RENDER_LINES,
        Math.max(24, Math.floor(terminalRows * 0.65)),
    );
    if (expanded) {
        return expandedLimit;
    }
    return Math.min(expandedLimit, 18);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
