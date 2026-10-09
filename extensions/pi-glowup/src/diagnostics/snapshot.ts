import { type GlowupConfig } from "../config/normalize.ts";
import { numberParser, stringParser } from "../json-scalar.ts";
import { jsonValueParser, type JsonValue } from "../json-value.ts";
import { markdownSyntaxPatchStats } from "../pi/patches/markdown-syntax.ts";
import { toolRendererPatchStats } from "../pi/patches/tool-execution-patch.ts";
import { type BuiltInToolName } from "../tools/built-in/names.ts";
import { pierreDiffHighlightStats } from "../rendering/diff/pierre-renderer.ts";
import {
    isSyntaxHighlightingReady,
    syntaxHighlighterDiagnostics,
} from "../rendering/syntax/highlighter.ts";
import { createNativeBashFeature } from "../tools/built-in/bash/preview.ts";
import { createNativeEditFeature } from "../tools/built-in/edit.ts";
import { createExplorationFeature } from "../tools/built-in/exploration.ts";
import { isRecord } from "../unknown-values.ts";
import { type DebugLogFields } from "./logger.ts";

export function configDiagnostics(config: GlowupConfig): DebugLogFields {
    return {
        appearance: {
            diffBackgroundStyle: config.appearance.diffBackgroundStyle,
            diffLineNumberStyle: config.appearance.diffLineNumberStyle,
            narrowDiffLayout: config.appearance.narrowDiffLayout,
            sideBySideLayout: config.appearance.sideBySideLayout,
            customRowBackgrounds:
                config.appearance.addedRowBackground !== null ||
                config.appearance.deletedRowBackground !== null,
            customContentBackgrounds:
                config.appearance.addedContentBackground !== null ||
                config.appearance.deletedContentBackground !== null,
        },
        mutations: {
            defaultView: config.mutations.defaultView,
            previewLines: config.mutations.previewLines,
            ...config.mutations.limits,
        },
        debugLog: {
            enabled: config.debugLog.enabled,
            maxBytes: config.debugLog.maxBytes,
            memorySampleIntervalMs: config.debugLog.memorySampleIntervalMs,
        },
        renderCache: config.renderCache,
        scriptPreview: {
            headerLayout: config.scriptHeaderLayout,
            maxCodePreviewLines: config.scriptMaxCodePreviewLines,
            showPrologueOmission: config.scriptShowPrologueOmission,
            shellLayout: config.shellLayout,
            shellOperatorPosition: config.shellOperatorPosition,
            formatterCount: config.scriptFormatters.size,
        },
        toolLabels: {
            mode: config.toolLabels.mode,
        },
        writePreview: {
            movingViewport: config.writePreview.movingViewport,
        },
        syntax: {
            preloadLanguages: config.syntax.preloadLanguages,
            bracketPairColoring: config.syntax.bracketPairColoring,
            projectLanguageDetection: config.syntax.projectLanguageDetection.enabled,
        },
        patches: {
            assistantSeparator: config.patches.assistantSeparator,
            workingWidgetSpacing: config.patches.workingWidgetSpacing,
            autocompleteCleanup: config.patches.autocompleteCleanup,
            markdownSyntax: config.patches.markdownSyntax,
            thirdPartyToolRenderers: config.patches.thirdPartyToolRenderers,
        },
        preserveToolCount: config.preserveTools.length,
    };
}

export function valueKind(value: JsonValue | undefined): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (stringParser.parse(value) !== undefined) return "string";
    if (numberParser.parse(value) !== undefined) return "number";
    if (value === true || value === false) return "boolean";
    return "object";
}

export function textByteLength(text: string | undefined): number | undefined {
    return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
}

export function detailsDiagnostics(details: unknown): DebugLogFields {
    const parsed = jsonValueParser.parse(details);
    if (!isRecord(parsed)) {
        return { detailsKind: valueKind(parsed) };
    }

    const diff = parsed.diff;
    const pierreDiff = parsed.pierreDiff;

    return {
        detailsKind: "object",
        detailKeyCount: Object.keys(parsed).length,
        detailsDiffBytes:
            stringParser.parse(diff) === undefined
                ? undefined
                : Buffer.byteLength(stringParser.parse(diff) ?? "", "utf8"),
        pierreDiffKind: isRecord(pierreDiff) ? stringParser.parse(pierreDiff.kind) : undefined,
    };
}

export function createDiagnosticSnapshot(features: {
    readonly edit: ReturnType<typeof createNativeEditFeature>;
    readonly bash: ReturnType<typeof createNativeBashFeature>;
    readonly exploration: ReturnType<typeof createExplorationFeature>;
}) {
    const builtInRenderCallCounts: Record<string, number> = {};
    const builtInRenderResultCounts: Record<string, number> = {};

    function recordBuiltInRender(kind: "call" | "result", toolName: BuiltInToolName): void {
        const counts = kind === "call" ? builtInRenderCallCounts : builtInRenderResultCounts;
        counts[toolName] = (counts[toolName] ?? 0) + 1;
    }

    function diagnosticSnapshot(): DebugLogFields {
        const memory = process.memoryUsage();
        const editStats = features.edit.stats();
        const scriptStats = features.bash.stats();
        const explorationStats = features.exploration.explorationGroups.stats();
        const diffStats = pierreDiffHighlightStats();
        const syntaxStats = syntaxHighlighterDiagnostics();
        const markdownStats = markdownSyntaxPatchStats();
        const rendererStats = toolRendererPatchStats();

        return {
            memory: {
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
                heapTotalBytes: memory.heapTotal,
                externalBytes: memory.external,
                arrayBuffersBytes: memory.arrayBuffers,
            },
            stores: {
                editPreviewEntries: editStats.entries,
                editPreviewBytes: editStats.bytes,
                nativeEditSnapshots: editStats.nativeEditSnapshots,
                nativeEditPierrePayloads: editStats.nativeEditPierrePayloads,
                scriptPreviewEntries: scriptStats.entries,
                scriptPreviewBytes: scriptStats.bytes,
                explorationGroups: explorationStats.groups,
                explorationToolCalls: explorationStats.toolCalls,
                explorationPendingBoundaries: explorationStats.pendingBoundaries,
            },
            syntax: {
                ready: isSyntaxHighlightingReady(),
                ...syntaxStats,
                markdownHighlightingEnabled: markdownStats.highlightingEnabled,
                markdownRenderPatchEnabled: markdownStats.renderPatchEnabled,
                markdownRenderInjections: markdownStats.renderInjections,
                markdownThemePatchAttempts: markdownStats.themePatchAttempts,
                markdownThemePatches: markdownStats.themePatches,
                markdownThemePatchHits: markdownStats.themePatchHits,
                markdownThemePatchFailures: markdownStats.themePatchFailures,
                markdownThinkingThemeSuppressions: markdownStats.thinkingThemeSuppressions,
                markdownThinkingThemeSuppressionFailures:
                    markdownStats.thinkingThemeSuppressionFailures,
            },
            diffHighlights: {
                queuedHighlights: diffStats.queuedHighlights,
                activeTimers: diffStats.activeTimers,
                queueRunning: diffStats.queueRunning,
            },
            renderers: {
                builtInPatchEnabled: rendererStats.builtInPatchEnabled,
                thirdPartyPatchEnabled: rendererStats.thirdPartyPatchEnabled,
                thirdPartyRendererCacheEntries: rendererStats.thirdPartyRendererCacheEntries,
                completedLineCacheEntries: rendererStats.completedLineCacheEntries,
                completedLineCacheBytes: rendererStats.completedLineCacheBytes,
                completedLineCacheLimitBytes: rendererStats.completedLineCacheLimitBytes,
                completedLineCacheLimitEntries: rendererStats.completedLineCacheLimitEntries,
                completedLineCacheEvictions: rendererStats.completedLineCacheEvictions,
                completedLineCacheHits: rendererStats.completedLineCacheHits,
                completedLineCacheMisses: rendererStats.completedLineCacheMisses,
                builtInRenderCalls: { ...builtInRenderCallCounts },
                builtInRenderResults: { ...builtInRenderResultCounts },
            },
        };
    }

    return { diagnosticSnapshot, recordBuiltInRender };
}
