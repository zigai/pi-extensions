import { keyHint } from "@earendil-works/pi-coding-agent";
import {
    truncateToWidth,
    type Component,
    visibleWidth,
    wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import ansiStyles from "ansi-styles";
import {
    buildSplitDiffRows,
    buildUnifiedDiffRows,
    normalizePierreDiffPayload,
    type DiffRenderLimits,
} from "./diff.ts";
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
import { shouldRenderSideBySide, type SideBySideLayout } from "./layout.ts";
import { getPierrePalette, type PierreTerminalPalette } from "./theme.ts";
import {
    configuredDiffLineNumberStyle,
    configuredNarrowDiffLayout,
    configuredRenderingAppearanceVersion,
    configuredSideBySideLayout,
    selectSemanticDiffIndices,
    type GlowupRenderTheme,
    type SemanticDiffRowKind,
} from "../rendering/core.ts";
import { neutralizeTerminalControls } from "../text-boundaries.ts";
import { syntaxHighlightingVersion } from "../syntax/highlighter.ts";
import { PREVIEW_MUTATION_SETTINGS, type MutationSettings } from "../mutations/settings.ts";

const ANSI_SEQUENCE_PREFIX = ansiStyles.modifier.reset.open.slice(0, 2);
const DIFF_STYLE_RESET = `${ansiStyles.modifier.bold.close}${ansiStyles.color.close}${ansiStyles.bgColor.close}`;
const INITIAL_TTY_DIFF_HIGHLIGHT_DEFER_MS = 1_500;
const MAX_QUEUED_DIFF_HIGHLIGHTS = 50;
const MAX_ACTIVE_DIFF_HIGHLIGHT_TIMERS = 16;
const MAX_VIEWPORT_DIFF_RENDER_LINES = 5_000;
const MAX_HIGHLIGHT_DIFF_LINES = 5_000;
const MAX_HIGHLIGHT_DIFF_BYTES = 512 * 1024;
const DISABLE_INITIAL_DEFER_ENV = "PI_GLOWUP_DISABLE_INITIAL_SYNTAX_DEFER";
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
    readonly dim: boolean | undefined;
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
    const visible = selected.map((index) => rows[index]).filter(isDefined);
    return [...visible, omission(rows.length - selected.length)];
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

export type PierreDiffRenderOptions = {
    readonly expanded: boolean;
    readonly mutationSettings?: MutationSettings;
    /** Preserve apply_patch's previous behavior of showing every row when expanded. */
    readonly expandedRows?: "viewport" | "full";
};

type PierreRowPolicy = {
    readonly collapseSemantically: boolean;
    readonly maxSourceRows: number | undefined;
    readonly maxVisibleLines: number | undefined;
};

function pierreRowPolicy(
    settings: MutationSettings,
    options: PierreDiffRenderOptions,
): PierreRowPolicy {
    const showEveryRow =
        settings.defaultView === "full" || (options.expanded && options.expandedRows === "full");
    if (showEveryRow) {
        return {
            collapseSemantically: false,
            maxSourceRows: settings.limits.maxDiffLines ?? undefined,
            maxVisibleLines: undefined,
        };
    }
    if (options.expanded) {
        const maxVisibleLines = maxVisibleDiffLines(true);
        return {
            collapseSemantically: false,
            maxSourceRows: maxVisibleLines + 1,
            maxVisibleLines,
        };
    }
    return {
        collapseSemantically: true,
        maxSourceRows: settings.limits.maxDiffLines ?? undefined,
        maxVisibleLines: settings.previewLines + 1,
    };
}

function pierreRowPoliciesEqual(left: PierreRowPolicy, right: PierreRowPolicy): boolean {
    return (
        left.collapseSemantically === right.collapseSemantically &&
        left.maxSourceRows === right.maxSourceRows &&
        left.maxVisibleLines === right.maxVisibleLines
    );
}

function addOneWhenDefined(value: number | undefined): number | undefined {
    return value === undefined ? undefined : value + 1;
}

/** Returns whether the configured width/content policy permits a split diff. */
export function shouldRenderSideBySideDiff(
    width: number,
    metadata: PierreRenderableDiffPayload["metadata"],
    layout: SideBySideLayout,
): boolean {
    return shouldRenderSideBySide(width, metadata, layout, configuredDiffLineNumberStyle());
}

/** Renders a replayable Pierre diff payload with lazy syntax highlighting. */
export function renderPierreDiff(
    payload: PierreDiffPayload,
    theme: GlowupRenderTheme,
    options: PierreDiffRenderOptions,
    context: PierreDiffRenderContext,
): Component {
    if (payload.kind === "summary") {
        return renderPierreDiffSummary(payload, theme);
    }

    const settings = options.mutationSettings ?? PREVIEW_MUTATION_SETTINGS;
    const rowPolicy = pierreRowPolicy(settings, options);
    const component =
        context.lastComponent instanceof PierreDiffComponent &&
        context.lastComponent.belongsTo(context.toolCallId)
            ? context.lastComponent
            : new PierreDiffComponent(
                  payload,
                  theme,
                  rowPolicy,
                  options.expanded,
                  context.toolCallId,
                  context.invalidate,
              );

    component.update(payload, theme, rowPolicy, options.expanded, context.invalidate);
    return component;
}

/** Reads a Pierre payload from result details when present and safe to render. */
export function getPierreDiffPayloadFromDetails(
    details: unknown,
    limits?: DiffRenderLimits,
): PierreDiffPayload | undefined {
    if (!isRecord(details)) {
        return undefined;
    }
    return normalizePierreDiffPayload(details.pierreDiff, limits);
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
    private rowPolicy: PierreRowPolicy;
    private expanded: boolean;
    private appearanceVersion: number;
    private syntaxVersion: number;
    private refreshPromise: Promise<void> | undefined;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private refreshKey: string | undefined;
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;
    private readonly toolCallId: string | undefined;
    private requestRender: (() => void) | undefined;

    constructor(
        payload: PierreRenderableDiffPayload,
        theme: GlowupRenderTheme,
        rowPolicy: PierreRowPolicy,
        expanded: boolean,
        toolCallId: string | undefined,
        requestRender: (() => void) | undefined,
    ) {
        this.payload = payload;
        this.palette = getPierrePalette(theme);
        this.highlighted = emptyHighlightedDiffSet();
        this.rowPolicy = rowPolicy;
        this.expanded = expanded;
        this.appearanceVersion = configuredRenderingAppearanceVersion();
        this.syntaxVersion = syntaxHighlightingVersion();
        this.toolCallId = toolCallId;
        this.requestRender = requestRender;
        if (this.shouldHighlight()) {
            this.maybeRefreshHighlightedDiff();
        }
    }

    belongsTo(toolCallId: string | undefined): boolean {
        return this.toolCallId === toolCallId;
    }

    update(
        payload: PierreRenderableDiffPayload,
        theme: GlowupRenderTheme,
        rowPolicy: PierreRowPolicy,
        expanded: boolean,
        requestRender: (() => void) | undefined,
    ): void {
        const previousPayload = this.payload;
        const previousKey = refreshKeyFor(previousPayload);
        const nextKey = refreshKeyFor(payload);
        const nextPalette = getPierrePalette(theme);
        const nextAppearanceVersion = configuredRenderingAppearanceVersion();
        const nextSyntaxVersion = syntaxHighlightingVersion();
        const syntaxChanged = this.syntaxVersion !== nextSyntaxVersion;
        const canReuseRenderedCache =
            previousPayload === payload &&
            pierreRowPoliciesEqual(this.rowPolicy, rowPolicy) &&
            this.expanded === expanded &&
            this.appearanceVersion === nextAppearanceVersion &&
            !syntaxChanged &&
            pierrePalettesEqual(this.palette, nextPalette);

        this.payload = payload;
        this.palette = nextPalette;
        this.rowPolicy = rowPolicy;
        this.expanded = expanded;
        this.appearanceVersion = nextAppearanceVersion;
        this.syntaxVersion = nextSyntaxVersion;
        this.requestRender = requestRender;
        if (!this.shouldHighlight()) {
            this.highlighted = emptyHighlightedDiffSet();
            this.refreshPromise = undefined;
            this.clearRefreshTimer();
        }
        if (!canReuseRenderedCache) {
            this.invalidate();
        }
        if (previousKey !== nextKey || syntaxChanged) {
            this.highlighted = emptyHighlightedDiffSet();
            this.refreshPromise = undefined;
            this.clearRefreshTimer();
            this.refreshKey = undefined;
        }
        if (this.shouldHighlight()) {
            this.maybeRefreshHighlightedDiff();
        }
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        const nextSyntaxVersion = syntaxHighlightingVersion();
        if (this.syntaxVersion !== nextSyntaxVersion) {
            this.syntaxVersion = nextSyntaxVersion;
            this.highlighted = emptyHighlightedDiffSet();
            this.refreshPromise = undefined;
            this.clearRefreshTimer();
            this.refreshKey = undefined;
            this.invalidate();
            if (this.shouldHighlight()) {
                this.maybeRefreshHighlightedDiff();
            }
        }
        if (this.shouldHighlight()) {
            this.highlightVisibleRenderIfPossible();
        }
        if (this.cachedWidth === safeWidth && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const highlighted = this.highlighted[this.palette.appearance];
        const bodyLines = shouldRenderSideBySideDiff(
            safeWidth,
            this.payload.metadata,
            configuredSideBySideLayout(),
        )
            ? this.renderSplitBody(safeWidth, highlighted)
            : this.renderUnifiedBody(safeWidth, highlighted);
        const lines = bodyLines;

        if (
            this.rowPolicy.maxVisibleLines === undefined ||
            lines.length <= this.rowPolicy.maxVisibleLines
        ) {
            this.cachedWidth = safeWidth;
            this.cachedLines = lines.map((line) =>
                truncateToWidth(neutralizeTerminalControls(line), safeWidth, ""),
            );
            return this.cachedLines;
        }

        const visible = Math.max(1, this.rowPolicy.maxVisibleLines - 1);
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
        ].map((line) => truncateToWidth(neutralizeTerminalControls(line), safeWidth, ""));
        return this.cachedLines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    private highlightVisibleRenderIfPossible(): void {
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
            ...(this.rowPolicy.maxSourceRows === undefined
                ? {}
                : { maxRows: this.rowPolicy.maxSourceRows }),
            narrowLayout: configuredNarrowDiffLayout(),
        });
        const rows = this.rowPolicy.collapseSemantically
            ? collapsedPierreRows(
                  sourceRows,
                  sourceRows.map((row): SemanticDiffRowKind => {
                      if (row.kind !== "line") return "meta";
                      if (row.lineType === "addition") return "insert";
                      if (row.lineType === "deletion") return "delete";
                      return "context";
                  }),
                  this.rowPolicy.maxVisibleLines ?? 1,
                  (count): UnifiedDiffRow => ({
                      kind: "collapsed",
                      text: `… +${count} lines (${pierreExpandHint()})`,
                      fg: this.palette.metadataFg,
                      bg: this.palette.metadataBg,
                  }),
              )
            : sourceRows;
        return renderUnifiedRows(
            rows,
            this.payload.metadata,
            width,
            addOneWhenDefined(this.rowPolicy.maxVisibleLines),
            this.rowPolicy.collapseSemantically ? 1 : undefined,
        );
    }

    private renderSplitBody(width: number, highlighted: HighlightedDiffSet["dark"]): string[] {
        const sourceRows = buildSplitDiffRows(
            this.payload.metadata,
            highlighted,
            this.palette,
            this.rowPolicy.maxSourceRows === undefined
                ? {}
                : { maxRows: this.rowPolicy.maxSourceRows },
        );
        const rows = this.rowPolicy.collapseSemantically
            ? collapsedPierreRows(
                  sourceRows,
                  sourceRows.map((row): SemanticDiffRowKind => {
                      if (row.kind !== "line") return "meta";
                      const hasAddition = row.addition.lineType === "addition";
                      const hasDeletion = row.deletion.lineType === "deletion";
                      if (hasAddition && !hasDeletion) return "insert";
                      if (hasDeletion && !hasAddition) return "delete";
                      return hasAddition ? "insert" : "context";
                  }),
                  this.rowPolicy.maxVisibleLines ?? 1,
                  (count): SplitDiffRow => ({
                      kind: "collapsed",
                      text: `… +${count} lines (${pierreExpandHint()})`,
                      fg: this.palette.metadataFg,
                      bg: this.palette.metadataBg,
                  }),
              )
            : sourceRows;
        return renderSplitRows(
            rows,
            this.payload.metadata,
            width,
            this.palette,
            addOneWhenDefined(this.rowPolicy.maxVisibleLines),
            this.rowPolicy.collapseSemantically ? 1 : undefined,
        );
    }

    private maybeRefreshHighlightedDiff(): void {
        if (!this.shouldHighlight()) {
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
                    this.requestRender?.();
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

    private usesChangedSpanBackgrounds(): boolean {
        return (
            (this.palette.additionSpanBg.length > 0 &&
                this.palette.additionSpanBg !== this.palette.additionRowBg) ||
            (this.palette.deletionSpanBg.length > 0 &&
                this.palette.deletionSpanBg !== this.palette.deletionRowBg)
        );
    }

    private shouldHighlight(): boolean {
        if (
            this.payload.stats.lineCount > MAX_HIGHLIGHT_DIFF_LINES ||
            this.payload.stats.sizeBytes > MAX_HIGHLIGHT_DIFF_BYTES
        ) {
            return false;
        }
        return (
            this.expanded ||
            this.rowPolicy.maxVisibleLines === undefined ||
            this.usesChangedSpanBackgrounds()
        );
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

function renderPierreDiffSummary(
    payload: PierreSummaryDiffPayload,
    theme: GlowupRenderTheme,
): Component {
    return {
        render(width: number): string[] {
            const safeWidth = Math.max(1, Math.floor(width));
            const changeStats = `${payload.stats.added.toLocaleString("en-US")} + / ${payload.stats.removed.toLocaleString("en-US")} -`;
            const headline = `${theme.fg("toolDiffContext", payload.path)} ${theme.fg("muted", changeStats)}`;
            const hint = "Use git diff or read the file directly to inspect the full change.";
            return [
                truncateToWidth(neutralizeTerminalControls(headline), safeWidth, ""),
                truncateToWidth(
                    neutralizeTerminalControls(`  └ ${theme.fg("muted", summaryDetail(payload))}`),
                    safeWidth,
                    "",
                ),
                truncateToWidth(
                    neutralizeTerminalControls(`    ${theme.fg("muted", hint)}`),
                    safeWidth,
                    "",
                ),
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
    const limits = [
        payload.summary.maxBytes === null
            ? undefined
            : `${formatDiffSize(payload.summary.maxBytes)}`,
        payload.summary.maxLines === null
            ? undefined
            : `${payload.summary.maxLines.toLocaleString("en-US")} lines`,
    ].filter(isDefined);
    const limitText = limits.length === 0 ? "the render budget" : limits.join(" or ");
    return `Large diff omitted: ${formatDiffSize(payload.stats.sizeBytes)} / ${payload.stats.lineCount.toLocaleString("en-US")} lines exceeds ${limitText}`;
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
    maxRenderedLines: number | undefined,
    maxRowsPerDiffRow: number | undefined,
): string[] {
    const rendered: string[] = [];
    for (const row of rows) {
        const rowLines = renderUnifiedRow(row, metadata, width);
        const visibleLines = limitDiffRowLines(rowLines, maxRowsPerDiffRow, width);
        if (appendBudgetedRenderedLines(rendered, visibleLines, maxRenderedLines)) {
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
    maxRenderedLines: number | undefined,
    maxRowsPerDiffRow: number | undefined,
): string[] {
    const rendered: string[] = [];
    for (const row of rows) {
        const rowLines = renderSplitRow(row, metadata, width, palette);
        const visibleLines = limitDiffRowLines(rowLines, maxRowsPerDiffRow, width);
        if (appendBudgetedRenderedLines(rendered, visibleLines, maxRenderedLines)) {
            break;
        }
    }
    return rendered;
}

function limitDiffRowLines(
    lines: ReadonlyArray<string>,
    maxRows: number | undefined,
    width: number,
): ReadonlyArray<string> {
    if (maxRows === undefined || lines.length <= maxRows) {
        return lines;
    }

    const visible = lines.slice(0, Math.max(1, maxRows));
    const lastIndex = visible.length - 1;
    const lastLine = visible[lastIndex];
    if (lastLine === undefined) {
        return visible;
    }
    visible[lastIndex] = `${truncateToWidth(lastLine, Math.max(1, width - 1), "")}…`;
    return visible;
}

function appendBudgetedRenderedLines(
    target: string[],
    lines: ReadonlyArray<string>,
    maxRenderedLines: number | undefined,
): boolean {
    if (maxRenderedLines === undefined) {
        target.push(...lines);
        return false;
    }
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
        const gutterWidth =
            configuredDiffLineNumberStyle() === "dual"
                ? lineNumberWidth * 2 + 3
                : lineNumberWidth + 1;
        const text = row.kind === "collapsed" ? `${" ".repeat(gutterWidth)} ${row.text}` : row.text;
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
    const firstPrefix = unifiedDiffPrefix(row, marker, lineNumberWidth);
    const restPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(8, width - visibleWidth(firstPrefix));
    const content = renderContent(row.spans, baseStyle({ fg: row.rowFg, bg: row.rowBg }));
    if (visibleWidth(content) === 0) {
        const prefix = renderUnifiedDiffPrefix(
            firstPrefix,
            lineNumberWidth,
            row.rowFg,
            row.lineNumberFg,
            row.rowBg,
        );
        if (row.lineType === "context") {
            return [`${prefix}${DIFF_STYLE_RESET}`];
        }
        const rowStyle = baseStyle({ fg: row.rowFg, bg: row.rowBg });
        return [padRenderedLine(prefix, width, rowStyle, blankContentStyle(row, rowStyle))];
    }

    const wrapped = wrapTextWithAnsi(content, contentWidth);
    const segments = wrapped.length > 0 ? wrapped : [""];

    return segments.map((segment, index) => {
        const prefix = index === 0 ? firstPrefix : restPrefix;
        const currentPrefixAnsi =
            index === 0
                ? renderUnifiedDiffPrefix(
                      prefix,
                      lineNumberWidth,
                      row.rowFg,
                      row.lineNumberFg,
                      row.rowBg,
                  )
                : renderSegments(
                      [{ text: prefix, fg: row.lineNumberFg, bg: row.rowBg }],
                      baseStyle({ fg: row.lineNumberFg, bg: row.rowBg }),
                  );
        return padRenderedLine(
            `${currentPrefixAnsi}${segment}`,
            width,
            baseStyle({ fg: row.rowFg, bg: row.rowBg }),
        );
    });
}

function unifiedDiffPrefix(
    row: Extract<UnifiedDiffRow, { readonly kind: "line" }>,
    marker: string,
    lineNumberWidth: number,
): string {
    if (configuredDiffLineNumberStyle() === "single") {
        const lineNumber = row.lineType === "deletion" ? row.oldLineNumber : row.newLineNumber;
        return `${marker}${formatLineNumber(lineNumber, lineNumberWidth)} `;
    }
    return `${formatLineNumber(row.oldLineNumber, lineNumberWidth)} ${formatLineNumber(row.newLineNumber, lineNumberWidth)} ${marker} `;
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
    const firstPrefix =
        configuredDiffLineNumberStyle() === "dual"
            ? `${formatLineNumber(cell.lineNumber, lineNumberWidth)} ${marker} `
            : `${marker}${formatLineNumber(cell.lineNumber, lineNumberWidth)} `;
    const restPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(8, width - visibleWidth(firstPrefix));
    const content = renderContent(cell.spans, baseStyle({ fg: cell.rowFg, bg: cell.rowBg }));
    if (visibleWidth(content) === 0) {
        const prefix = renderSplitDiffPrefix(
            firstPrefix,
            lineNumberWidth,
            cell.rowFg,
            cell.lineNumberFg,
            cell.rowBg,
        );
        const rowStyle = baseStyle({ fg: cell.rowFg, bg: cell.rowBg });
        return [padRenderedLine(prefix, width, rowStyle, blankContentStyle(cell, rowStyle))];
    }

    const wrapped = wrapTextWithAnsi(content, contentWidth);
    const segments = wrapped.length > 0 ? wrapped : [""];

    return segments.map((segment, index) => {
        const prefix = index === 0 ? firstPrefix : restPrefix;
        const currentPrefixAnsi = renderSplitDiffPrefix(
            prefix,
            lineNumberWidth,
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

function renderSplitDiffPrefix(
    prefix: string,
    lineNumberWidth: number,
    markerFg: string,
    lineNumberFg: string,
    rowBg: string,
): string {
    if (configuredDiffLineNumberStyle() === "single") {
        return renderDiffPrefix(prefix, markerFg, lineNumberFg, rowBg);
    }
    return renderDiffPrefixAtMarker(prefix, lineNumberWidth + 1, markerFg, lineNumberFg, rowBg);
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

function renderUnifiedDiffPrefix(
    prefix: string,
    lineNumberWidth: number,
    markerFg: string,
    lineNumberFg: string,
    rowBg: string,
): string {
    if (configuredDiffLineNumberStyle() === "single") {
        return renderDiffPrefix(prefix, markerFg, lineNumberFg, rowBg);
    }
    return renderDiffPrefixAtMarker(prefix, lineNumberWidth * 2 + 2, markerFg, lineNumberFg, rowBg);
}

function renderDiffPrefixAtMarker(
    prefix: string,
    markerIndex: number,
    markerFg: string,
    lineNumberFg: string,
    rowBg: string,
): string {
    return renderSegments(
        [
            { text: prefix.slice(0, markerIndex), fg: lineNumberFg, bg: rowBg },
            { text: prefix.slice(markerIndex, markerIndex + 1), fg: markerFg, bg: rowBg },
            { text: prefix.slice(markerIndex + 1), fg: lineNumberFg, bg: rowBg },
        ],
        baseStyle({ fg: lineNumberFg, bg: rowBg }),
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

function blankContentStyle(
    line: Pick<SplitDiffCell, "contentBg" | "rowBg">,
    rowStyle: AnsiStyle,
): AnsiStyle {
    return line.rowBg.length > 0 && line.contentBg !== line.rowBg
        ? baseStyle({ ...rowStyle, bg: line.contentBg })
        : rowStyle;
}

function padRenderedLine(
    line: string,
    width: number,
    base: AnsiStyle,
    paddingBase: AnsiStyle = base,
): string {
    const targetWidth = Math.max(1, width);
    const truncated = truncateToWidth(line, targetWidth, "");
    const padding = Math.max(0, targetWidth - visibleWidth(truncated));
    return `${truncated}${openAnsi(paddingBase)}${" ".repeat(padding)}${DIFF_STYLE_RESET}`;
}

function renderSegments(segments: ReadonlyArray<RenderSegment>, base: AnsiStyle): string {
    let output = openAnsi(base);
    for (const segment of segments) {
        output += openAnsi(
            baseStyle({
                fg: segment.fg ?? base.fg,
                bg: segment.bg ?? base.bg,
                bold: segment.bold ?? base.bold,
                dim: segment.dim ?? base.dim,
            }),
        );
        output += neutralizeTerminalControls(segment.text.replace(/[\r\n]/gu, ""));
    }
    output += openAnsi(base);
    return output;
}

function openAnsi(style: AnsiStyle): string {
    const fg = toRgb(style.fg);
    const bg = toRgb(style.bg);

    const intensity =
        style.bold === true
            ? ansiStyles.modifier.bold.open
            : style.dim === true
              ? ansiStyles.modifier.dim.open
              : ansiStyles.modifier.bold.close;
    return [
        intensity,
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
    readonly dim?: boolean | undefined;
}): AnsiStyle {
    return {
        fg: input.fg,
        bg: input.bg,
        bold: input.bold,
        dim: input.dim,
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
        left.additionSpanBg === right.additionSpanBg &&
        left.deletionFg === right.deletionFg &&
        left.deletionRowBg === right.deletionRowBg &&
        left.deletionSpanBg === right.deletionSpanBg &&
        left.emptyFg === right.emptyFg &&
        left.emptyRowBg === right.emptyRowBg &&
        left.lineNumberFg === right.lineNumberFg &&
        left.metadataFg === right.metadataFg &&
        left.metadataBg === right.metadataBg &&
        left.dividerFg === right.dividerFg &&
        left.dividerBg === right.dividerBg &&
        left.dimUnchangedText === right.dimUnchangedText
    );
}

function maxVisibleDiffLines(expanded: boolean): number {
    const terminalRows = typeof process.stdout.rows === "number" ? process.stdout.rows : 40;
    const expandedLimit = Math.min(
        MAX_VIEWPORT_DIFF_RENDER_LINES,
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
