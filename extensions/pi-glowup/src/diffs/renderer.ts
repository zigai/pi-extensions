import { keyHint } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../unknown-values.ts";
import {
    sliceByColumn,
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
    cleanDiffLine,
    emptyHighlightedDiffSet,
    getCachedHighlightedDiff,
    loadHighlightedDiffResult,
    type HighlightedDiffLoadResult,
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
import {
    diffLineNumberWidth,
    pairReplacementLines,
    shouldRenderSideBySide,
    type NarrowDiffLayout,
    type SideBySideLayout,
} from "./layout.ts";
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
import { replacementFocusColumns } from "./intraline.ts";

const ANSI_SEQUENCE_PREFIX = ansiStyles.modifier.reset.open.slice(0, 2);
const DIFF_STYLE_RESET = `${ansiStyles.modifier.bold.close}${ansiStyles.color.close}${ansiStyles.bgColor.close}`;
const INITIAL_TTY_DIFF_HIGHLIGHT_DEFER_MS = 1_500;
const MAX_VIEWPORT_DIFF_RENDER_LINES = 5_000;
const MAX_CACHED_DIFF_HIGHLIGHTS = 100;
const DISABLE_INITIAL_DEFER_ENV = "PI_GLOWUP_DISABLE_INITIAL_SYNTAX_DEFER";
const moduleLoadedAtMs = Date.now();

type HighlightState =
    | { readonly status: "idle" }
    | { readonly status: "pending"; readonly key: string }
    | { readonly status: "ready"; readonly key: string; readonly value: HighlightedDiffSet }
    | { readonly status: "failed"; readonly key: string; readonly fallback: HighlightedDiffSet };

type QueuedHighlight = {
    readonly key: string;
    readonly priority: number;
    readonly run: () => Promise<HighlightedDiffLoadResult>;
    readonly resolve: (result: HighlightedDiffLoadResult) => void;
};

class DiffHighlightScheduler {
    private readonly queued: QueuedHighlight[] = [];
    private readonly pending = new Map<string, Promise<HighlightedDiffLoadResult>>();
    private readonly cached = new Map<string, HighlightedDiffLoadResult>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    private disposed = false;

    schedule(
        key: string,
        run: () => Promise<HighlightedDiffLoadResult>,
        priority = 0,
    ): Promise<HighlightedDiffLoadResult> {
        const cached = this.cached.get(key);
        if (cached !== undefined) return Promise.resolve(cached);
        const pending = this.pending.get(key);
        if (pending !== undefined) return pending;

        const promise = new Promise<HighlightedDiffLoadResult>((resolve) => {
            const task = { key, priority, run, resolve };
            const insertionIndex = this.queued.findIndex((queued) => queued.priority < priority);
            if (insertionIndex < 0) this.queued.push(task);
            else this.queued.splice(insertionIndex, 0, task);
        });
        this.pending.set(key, promise);
        this.scheduleNext(this.running ? 100 : initialDiffHighlightDelayMs());
        return promise;
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const fallback = { value: emptyHighlightedDiffSet(), failed: true } as const;
        for (const task of this.queued.splice(0)) {
            this.pending.delete(task.key);
            task.resolve(fallback);
        }
        this.cached.clear();
    }

    stats(): { readonly activeTimers: number; readonly queued: number; readonly running: boolean } {
        return {
            activeTimers: this.timer === undefined ? 0 : 1,
            queued: this.queued.length,
            running: this.running,
        };
    }

    private scheduleNext(delayMs: number): void {
        if (this.disposed || this.running || this.timer !== undefined || this.queued.length === 0) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.processNext();
        }, delayMs);
        this.timer.unref?.();
    }

    private async processNext(): Promise<void> {
        if (this.disposed || this.running) return;
        const task = this.queued.shift();
        if (task === undefined) return;
        this.running = true;
        let result: HighlightedDiffLoadResult;
        try {
            result = await task.run();
        } catch {
            result = { value: emptyHighlightedDiffSet(), failed: true };
        }
        this.pending.delete(task.key);
        if (!this.disposed) {
            this.cached.delete(task.key);
            this.cached.set(task.key, result);
            while (this.cached.size > MAX_CACHED_DIFF_HIGHLIGHTS) {
                const oldest = this.cached.keys().next().value;
                if (typeof oldest !== "string") break;
                this.cached.delete(oldest);
            }
        }
        task.resolve(result);
        this.running = false;
        this.scheduleNext(0);
    }
}

let diffHighlightScheduler = new DiffHighlightScheduler();

type AnsiStyle = {
    readonly fg: string | undefined;
    readonly bg: string | undefined;
    readonly bold: boolean | undefined;
    readonly dim: boolean | undefined;
};

type RenderSegment = DiffSpan & {
    readonly bold?: boolean;
};

type SemanticSourceRow = {
    readonly sourceIndex: number;
    readonly kind: SemanticDiffRowKind;
    readonly edgeCollapsed: boolean;
};

function semanticUnifiedSourceRows(
    metadata: PierreRenderableDiffPayload["metadata"],
    layout: NarrowDiffLayout,
): readonly SemanticSourceRow[] {
    const rows: SemanticSourceRow[] = [];
    const push = (kind: SemanticDiffRowKind, edgeCollapsed = false): void => {
        rows.push({ sourceIndex: rows.length, kind, edgeCollapsed });
    };
    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) push("meta", true);
        let deletionIndex = hunk.deletionLineIndex;
        let additionIndex = hunk.additionLineIndex;
        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let index = 0; index < content.lines; index += 1) push("context");
                deletionIndex += content.lines;
                additionIndex += content.lines;
                continue;
            }
            if (layout === "traditional" || content.deletions * content.additions > 256) {
                for (let index = 0; index < content.deletions; index += 1) push("delete");
                for (let index = 0; index < content.additions; index += 1) push("insert");
            } else {
                const kinds = orderedReplacementKinds(
                    metadata.deletionLines.slice(deletionIndex, deletionIndex + content.deletions),
                    metadata.additionLines.slice(additionIndex, additionIndex + content.additions),
                    layout,
                );
                for (const kind of kinds) push(kind);
            }
            deletionIndex += content.deletions;
            additionIndex += content.additions;
        }
        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) push("meta");
    }
    if (hasSemanticTrailingCollapsedLines(metadata)) push("meta", true);
    return trimSemanticEdgeCollapsedRows(rows);
}

function orderedReplacementKinds(
    deletions: readonly string[],
    additions: readonly string[],
    layout: NarrowDiffLayout,
): readonly SemanticDiffRowKind[] {
    if (layout === "traditional" || deletions.length * additions.length > 256) {
        return [
            ...deletions.map((): SemanticDiffRowKind => "delete"),
            ...additions.map((): SemanticDiffRowKind => "insert"),
        ];
    }
    const pairs = pairReplacementLines(deletions.map(cleanDiffLine), additions.map(cleanDiffLine));
    if (pairs === undefined) {
        return [
            ...deletions.map((): SemanticDiffRowKind => "delete"),
            ...additions.map((): SemanticDiffRowKind => "insert"),
        ];
    }
    const kinds: SemanticDiffRowKind[] = [];
    let deletionIndex = 0;
    let additionIndex = 0;
    for (const pair of pairs) {
        while (deletionIndex < pair.deletionIndex) {
            kinds.push("delete");
            deletionIndex += 1;
        }
        while (additionIndex < pair.additionIndex) {
            kinds.push("insert");
            additionIndex += 1;
        }
        kinds.push("delete", "insert");
        deletionIndex += 1;
        additionIndex += 1;
    }
    while (deletionIndex < deletions.length) {
        kinds.push("delete");
        deletionIndex += 1;
    }
    while (additionIndex < additions.length) {
        kinds.push("insert");
        additionIndex += 1;
    }
    return kinds;
}

function semanticSplitSourceRows(
    metadata: PierreRenderableDiffPayload["metadata"],
): readonly SemanticSourceRow[] {
    const rows: SemanticSourceRow[] = [];
    const push = (kind: SemanticDiffRowKind, edgeCollapsed = false): void => {
        rows.push({ sourceIndex: rows.length, kind, edgeCollapsed });
    };
    for (const hunk of metadata.hunks) {
        if (hunk.collapsedBefore > 0) push("meta", true);
        for (const content of hunk.hunkContent) {
            if (content.type === "context") {
                for (let index = 0; index < content.lines; index += 1) push("context");
                continue;
            }
            const kind: SemanticDiffRowKind = content.additions > 0 ? "insert" : "delete";
            for (
                let index = 0;
                index < Math.max(content.deletions, content.additions);
                index += 1
            ) {
                push(kind);
            }
        }
        if (hunk.noEOFCRDeletions || hunk.noEOFCRAdditions) push("meta");
    }
    if (hasSemanticTrailingCollapsedLines(metadata)) push("meta", true);
    return trimSemanticEdgeCollapsedRows(rows);
}

function hasSemanticTrailingCollapsedLines(
    metadata: PierreRenderableDiffPayload["metadata"],
): boolean {
    const lastHunk = metadata.hunks.at(-1);
    if (lastHunk === undefined || metadata.isPartial) return false;
    const additions =
        metadata.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
    const deletions =
        metadata.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);
    return additions === deletions && additions > 0;
}

function trimSemanticEdgeCollapsedRows(
    rows: readonly SemanticSourceRow[],
): readonly SemanticSourceRow[] {
    let start = 0;
    let end = rows.length;
    while (rows[start]?.edgeCollapsed === true) start += 1;
    while (end > start && rows[end - 1]?.edgeCollapsed === true) end -= 1;
    return rows.slice(start, end);
}

function semanticPreviewSelection(
    rows: readonly SemanticSourceRow[],
    rowBudget: number,
): { readonly sourceIndices: ReadonlySet<number>; readonly omitted: number } {
    const selected = selectSemanticDiffIndices(
        rows.map((row) => row.kind),
        Math.max(1, rowBudget - 1),
    );
    return {
        sourceIndices: new Set(
            selected.flatMap((index) => {
                const row = rows[index];
                return row === undefined ? [] : [row.sourceIndex];
            }),
        ),
        omitted: Math.max(0, rows.length - selected.length),
    };
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
    readonly activeHighlights: number;
    readonly queuedHighlights: number;
    readonly queueRunning: boolean;
} {
    const stats = diffHighlightScheduler.stats();
    return {
        activeTimers: stats.activeTimers,
        activeHighlights: stats.running ? 1 : 0,
        queuedHighlights: stats.queued,
        queueRunning: stats.running,
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
    private highlightState: HighlightState = { status: "idle" };
    private readonly cachedLinesByWidth = new Map<number, string[]>();
    private cachedUnifiedRows: ReadonlyArray<UnifiedDiffRow> | undefined;
    private cachedSplitRows: ReadonlyArray<SplitDiffRow> | undefined;
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
        this.maybeRefreshHighlightedDiff();
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
            previousPayload.modelKey === payload.modelKey &&
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
        if (!canReuseRenderedCache) {
            this.invalidate();
        }
        if (previousKey !== nextKey) {
            this.highlighted = emptyHighlightedDiffSet();
            this.highlightState = { status: "idle" };
        } else if (syntaxChanged) {
            this.highlightState = { status: "idle" };
        }
        this.maybeRefreshHighlightedDiff();
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        const nextSyntaxVersion = syntaxHighlightingVersion();
        if (this.syntaxVersion !== nextSyntaxVersion) {
            this.syntaxVersion = nextSyntaxVersion;
            this.highlightState = { status: "idle" };
            this.invalidate();
            this.maybeRefreshHighlightedDiff();
        }
        const cachedLines = this.cachedLinesByWidth.get(safeWidth);
        if (cachedLines !== undefined) return cachedLines;

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
            return this.cacheRenderedLines(
                safeWidth,
                lines.map((line) =>
                    truncateToWidth(neutralizeTerminalControls(line), safeWidth, ""),
                ),
            );
        }

        const visible = Math.max(1, this.rowPolicy.maxVisibleLines - 1);
        return this.cacheRenderedLines(
            safeWidth,
            [
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
            ].map((line) => truncateToWidth(neutralizeTerminalControls(line), safeWidth, "")),
        );
    }

    invalidate(): void {
        this.cachedLinesByWidth.clear();
        this.cachedUnifiedRows = undefined;
        this.cachedSplitRows = undefined;
    }

    private cacheRenderedLines(width: number, lines: string[]): string[] {
        this.cachedLinesByWidth.delete(width);
        this.cachedLinesByWidth.set(width, lines);
        while (this.cachedLinesByWidth.size > 2) {
            const oldest = this.cachedLinesByWidth.keys().next().value;
            if (typeof oldest !== "number") break;
            this.cachedLinesByWidth.delete(oldest);
        }
        return lines;
    }

    private renderUnifiedBody(width: number, highlighted: HighlightedDiffSet["dark"]): string[] {
        const narrowLayout = configuredNarrowDiffLayout();
        const sourceRows =
            this.cachedUnifiedRows ?? this.buildUnifiedRows(highlighted, narrowLayout);
        this.cachedUnifiedRows = sourceRows;
        return renderUnifiedRows(
            sourceRows,
            this.payload.metadata,
            width,
            addOneWhenDefined(this.rowPolicy.maxVisibleLines),
            this.rowPolicy.collapseSemantically ? 1 : undefined,
        );
    }

    private renderSplitBody(width: number, highlighted: HighlightedDiffSet["dark"]): string[] {
        const sourceRows = this.cachedSplitRows ?? this.buildSplitRows(highlighted);
        this.cachedSplitRows = sourceRows;
        return renderSplitRows(
            sourceRows,
            this.payload.metadata,
            width,
            this.palette,
            addOneWhenDefined(this.rowPolicy.maxVisibleLines),
            this.rowPolicy.collapseSemantically ? 1 : undefined,
        );
    }

    private buildUnifiedRows(
        highlighted: HighlightedDiffSet["dark"],
        narrowLayout: NarrowDiffLayout,
    ): ReadonlyArray<UnifiedDiffRow> {
        if (!this.rowPolicy.collapseSemantically) {
            return buildUnifiedDiffRows(this.payload.metadata, highlighted, this.palette, {
                ...(this.rowPolicy.maxSourceRows === undefined
                    ? {}
                    : { maxRows: this.rowPolicy.maxSourceRows }),
                narrowLayout,
            });
        }
        const selection = semanticPreviewSelection(
            semanticUnifiedSourceRows(this.payload.metadata, narrowLayout),
            this.rowPolicy.maxVisibleLines ?? 1,
        );
        const visible = buildUnifiedDiffRows(this.payload.metadata, highlighted, this.palette, {
            includedRowIndices: selection.sourceIndices,
            narrowLayout,
        });
        return selection.omitted === 0
            ? visible
            : [
                  ...visible,
                  {
                      kind: "collapsed",
                      text: `… +${selection.omitted} lines (${pierreExpandHint()})`,
                      fg: this.palette.metadataFg,
                      bg: this.palette.metadataBg,
                  },
              ];
    }

    private buildSplitRows(highlighted: HighlightedDiffSet["dark"]): ReadonlyArray<SplitDiffRow> {
        if (!this.rowPolicy.collapseSemantically) {
            return buildSplitDiffRows(
                this.payload.metadata,
                highlighted,
                this.palette,
                this.rowPolicy.maxSourceRows === undefined
                    ? {}
                    : { maxRows: this.rowPolicy.maxSourceRows },
            );
        }
        const selection = semanticPreviewSelection(
            semanticSplitSourceRows(this.payload.metadata),
            this.rowPolicy.maxVisibleLines ?? 1,
        );
        const visible = buildSplitDiffRows(this.payload.metadata, highlighted, this.palette, {
            includedRowIndices: selection.sourceIndices,
        });
        return selection.omitted === 0
            ? visible
            : [
                  ...visible,
                  {
                      kind: "collapsed",
                      text: `… +${selection.omitted} lines (${pierreExpandHint()})`,
                      fg: this.palette.metadataFg,
                      bg: this.palette.metadataBg,
                  },
              ];
    }

    private maybeRefreshHighlightedDiff(): void {
        const nextKey = `${refreshKeyFor(this.payload)}\u0000syntax:${this.syntaxVersion}`;
        if (this.highlightState.status !== "idle" && this.highlightState.key === nextKey) {
            return;
        }
        const cached = getCachedHighlightedDiff(this.payload.metadata);
        if (cached !== undefined) {
            this.highlighted = cached.value;
            this.highlightState = cached.failed
                ? { status: "failed", key: nextKey, fallback: cached.value }
                : { status: "ready", key: nextKey, value: cached.value };
            return;
        }
        this.highlightState = { status: "pending", key: nextKey };
        const metadata = this.payload.metadata;
        const scheduler = diffHighlightScheduler;
        void scheduler
            .schedule(nextKey, () => loadHighlightedDiffResult(metadata), this.expanded ? 1 : 0)
            .then((result) => {
                if (
                    scheduler !== diffHighlightScheduler ||
                    this.highlightState.status !== "pending" ||
                    this.highlightState.key !== nextKey
                ) {
                    return;
                }
                this.highlighted = result.value;
                this.highlightState = result.failed
                    ? { status: "failed", key: nextKey, fallback: result.value }
                    : { status: "ready", key: nextKey, value: result.value };
                this.invalidate();
                this.requestRender?.();
            });
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
    if (payload.summary.reason === "metadata-invalid") {
        return "Diff omitted: generated diff metadata was invalid.";
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

/** Drops pending lazy syntax-highlight work during extension shutdown. */
export function clearQueuedDiffHighlights(): void {
    diffHighlightScheduler.dispose();
    diffHighlightScheduler = new DiffHighlightScheduler();
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
    const lineNumberWidth = diffLineNumberWidth(metadata);
    for (const row of rows) {
        const rowLines = renderUnifiedRow(row, width, lineNumberWidth, maxRowsPerDiffRow === 1);
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
    const lineNumberWidth = diffLineNumberWidth(metadata);
    const divider = renderFullWidthLine(
        [{ text: " │ ", fg: palette.dividerFg, bg: palette.dividerBg }],
        3,
        baseStyle({ fg: palette.dividerFg, bg: palette.dividerBg }),
    );
    const dividerWidth = visibleWidth(divider);
    const leftWidth = Math.max(24, Math.floor((width - dividerWidth) / 2));
    const rightWidth = Math.max(24, width - dividerWidth - leftWidth);
    for (const row of rows) {
        const rowLines = renderSplitRow(
            row,
            width,
            lineNumberWidth,
            divider,
            leftWidth,
            rightWidth,
            maxRowsPerDiffRow === 1,
        );
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
    width: number,
    lineNumberWidth: number,
    focusChanged: boolean,
): string[] {
    if (row.kind !== "line") {
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

    const marker = markerForLineType(row.lineType);
    const firstPrefix = unifiedDiffPrefix(row, marker, lineNumberWidth);
    const prefixWidth = visibleWidth(firstPrefix);
    const restPrefix = " ".repeat(prefixWidth);
    const contentWidth = Math.max(8, width - prefixWidth);
    const spans = focusChanged
        ? changedPreviewSpans(row.spans, contentWidth, row.focusColumn)
        : row.spans;
    const content = renderContent(spans, baseStyle({ fg: row.rowFg, bg: row.rowBg }));
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
    width: number,
    lineNumberWidth: number,
    divider: string,
    leftWidth: number,
    rightWidth: number,
    focusChanged: boolean,
): string[] {
    if (row.kind !== "line") {
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

    const fallbackFocus = replacementFocusColumns(
        row.deletion.spans.map((span) => span.text).join(""),
        row.addition.spans.map((span) => span.text).join(""),
    );
    const deletionLines = renderSplitCell(
        row.deletion,
        leftWidth,
        lineNumberWidth,
        focusChanged,
        fallbackFocus.before,
    );
    const additionLines = renderSplitCell(
        row.addition,
        rightWidth,
        lineNumberWidth,
        focusChanged,
        fallbackFocus.after,
    );
    const rowCount = Math.max(deletionLines.length, additionLines.length);
    const rendered: string[] = [];

    for (let index = 0; index < rowCount; index += 1) {
        const deletionLine = deletionLines[index] ?? emptyPane(leftWidth, row.deletion);
        const additionLine = additionLines[index] ?? emptyPane(rightWidth, row.addition);
        rendered.push(`${deletionLine}${divider}${additionLine}`);
    }

    return rendered;
}

function renderSplitCell(
    cell: SplitDiffCell,
    width: number,
    lineNumberWidth: number,
    focusChanged: boolean,
    fallbackFocus: number | undefined,
): string[] {
    const marker = markerForLineType(cell.lineType);
    const firstPrefix =
        configuredDiffLineNumberStyle() === "dual"
            ? `${formatLineNumber(cell.lineNumber, lineNumberWidth)} ${marker} `
            : `${marker}${formatLineNumber(cell.lineNumber, lineNumberWidth)} `;
    const prefixWidth = visibleWidth(firstPrefix);
    const restPrefix = " ".repeat(prefixWidth);
    const contentWidth = Math.max(8, width - prefixWidth);
    const spans = focusChanged
        ? changedPreviewSpans(cell.spans, contentWidth, fallbackFocus)
        : cell.spans;
    const content = renderContent(spans, baseStyle({ fg: cell.rowFg, bg: cell.rowBg }));
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

function changedPreviewSpans(
    spans: ReadonlyArray<DiffSpan>,
    width: number,
    fallbackFocus: number | undefined,
): ReadonlyArray<DiffSpan> {
    const contentWidth = Math.max(1, width);
    let totalWidth = 0;
    let emphasizedStart: number | undefined;
    for (const span of spans) {
        if (emphasizedStart === undefined && span.emphasized === true) {
            emphasizedStart = totalWidth;
        }
        totalWidth += visibleWidth(span.text);
    }
    const focus = emphasizedStart ?? fallbackFocus;
    if (focus === undefined || totalWidth <= contentWidth) return spans;

    const sliceWidth = Math.max(1, contentWidth - 2);
    const start = Math.min(
        Math.max(0, focus - Math.floor(sliceWidth / 3)),
        Math.max(0, totalWidth - sliceWidth),
    );
    const end = Math.min(totalWidth, start + sliceWidth);
    return [
        ...(start === 0 ? [] : [{ text: "…" }]),
        ...sliceDiffSpans(spans, start, end),
        ...(end === totalWidth ? [] : [{ text: "…" }]),
    ];
}

function sliceDiffSpans(
    spans: ReadonlyArray<DiffSpan>,
    start: number,
    end: number,
): ReadonlyArray<DiffSpan> {
    const sliced: DiffSpan[] = [];
    let column = 0;
    for (const span of spans) {
        const spanWidth = visibleWidth(span.text);
        const spanEnd = column + spanWidth;
        const visibleStart = Math.max(start, column);
        const visibleEnd = Math.min(end, spanEnd);
        if (visibleStart < visibleEnd) {
            const text = sliceByColumn(span.text, visibleStart - column, visibleEnd - visibleStart);
            if (text.length > 0) sliced.push({ ...span, text });
        }
        column = spanEnd;
        if (column >= end) break;
    }
    return sliced;
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
    let current: AnsiStyle | undefined;
    let output = ansiTransition(current, base);
    current = base;
    for (const segment of segments) {
        const next = baseStyle({
            fg: segment.fg ?? base.fg,
            bg: segment.bg ?? base.bg,
            bold: segment.bold ?? base.bold,
            dim: segment.dim ?? base.dim,
        });
        output += ansiTransition(current, next);
        current = next;
        output += neutralizeTerminalControls(segment.text.replace(/[\r\n]/gu, ""));
    }
    output += ansiTransition(current, base);
    return output;
}

function openAnsi(style: AnsiStyle): string {
    return ansiTransition(undefined, style);
}

function ansiTransition(previous: AnsiStyle | undefined, next: AnsiStyle): string {
    const fg = toRgb(next.fg);
    const bg = toRgb(next.bg);
    const transitions: string[] = [];
    if (previous === undefined || previous.bold !== next.bold || previous.dim !== next.dim) {
        transitions.push(
            next.bold === true
                ? ansiStyles.modifier.bold.open
                : next.dim === true
                  ? ansiStyles.modifier.dim.open
                  : ansiStyles.modifier.bold.close,
        );
    }
    if (previous === undefined || previous.fg !== next.fg) {
        transitions.push(
            isAnsiStyle(next.fg)
                ? (next.fg ?? "")
                : fg === undefined
                  ? ansiStyles.color.close
                  : ansiStyles.color.ansi16m(fg.red, fg.green, fg.blue),
        );
    }
    if (previous === undefined || previous.bg !== next.bg) {
        transitions.push(
            isAnsiStyle(next.bg)
                ? (next.bg ?? "")
                : bg === undefined
                  ? ansiStyles.bgColor.close
                  : ansiStyles.bgColor.ansi16m(bg.red, bg.green, bg.blue),
        );
    }
    return transitions.join("");
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

function refreshKeyFor(payload: PierreRenderableDiffPayload): string {
    return `${payload.modelKey}\u0000${payload.metadata.lang ?? "text"}`;
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
