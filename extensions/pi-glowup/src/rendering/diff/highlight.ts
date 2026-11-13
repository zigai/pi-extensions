import { cleanLastNewline, type FileDiffMetadata } from "@pierre/diffs";
import type {
    DiffSpan,
    HighlightedDiffCode,
    HighlightedDiffLine,
    HighlightedDiffSet,
} from "./types.ts";
import type { PackedDiffCode, PackedDiffLine } from "./highlight-runs.ts";
import { enhanceSyntaxSegments } from "../syntax/brackets.ts";
import { highlightSyntaxDiff, syntaxHighlightingVersion } from "../syntax/highlighter.ts";
import { expandTerminalTabs } from "../../text-boundaries.ts";
import Type from "typebox";
import { Value } from "typebox/value";
import { recordRenderError } from "../../diagnostics/render-events.ts";

const fallbackTextFactorySchema = Type.Function([], Type.String());
const flattenedLineCache = new WeakMap<object, Map<string, ReadonlyArray<DiffSpan>>>();
const highlightedMetadataCache = new WeakMap<
    FileDiffMetadata,
    { readonly syntaxVersion: number; readonly result: HighlightedDiffLoadResult }
>();
const pendingMetadataHighlights = new WeakMap<
    FileDiffMetadata,
    { readonly syntaxVersion: number; readonly promise: Promise<HighlightedDiffLoadResult> }
>();

export type HighlightedDiffLoadResult = {
    readonly value: HighlightedDiffSet;
    readonly failed: boolean;
};

type SpanStyle = {
    readonly fg: string | undefined;
    readonly bg: string | undefined;
    readonly emphasized: boolean;
    readonly boldEmphasized: boolean;
    readonly dimUnchanged: boolean;
};

/** Returns an empty highlighted set used while lazy highlighting is pending or unavailable. */
export function emptyHighlightedDiffSet(): HighlightedDiffSet {
    return {
        dark: { deletionLines: [], additionLines: [] },
        light: { deletionLines: [], additionLines: [] },
    };
}

/** Lazily highlights Pierre diff metadata for terminal themes. */
export async function loadHighlightedDiff(metadata: FileDiffMetadata): Promise<HighlightedDiffSet> {
    return (await loadHighlightedDiffResult(metadata)).value;
}

/** Lazily highlights metadata and reports whether even the stable text fallback failed. */
export async function loadHighlightedDiffResult(
    metadata: FileDiffMetadata,
): Promise<HighlightedDiffLoadResult> {
    const syntaxVersion = syntaxHighlightingVersion();
    const cached = highlightedMetadataCache.get(metadata);
    if (cached?.syntaxVersion === syntaxVersion) {
        return cached.result;
    }

    const pending = pendingMetadataHighlights.get(metadata);
    if (pending?.syntaxVersion === syntaxVersion) {
        return pending.promise;
    }

    const promise = loadHighlightedDiffUncached(metadata).then((result) => {
        if (syntaxHighlightingVersion() === syntaxVersion) {
            highlightedMetadataCache.set(metadata, { syntaxVersion, result });
        }

        return result;
    });

    pendingMetadataHighlights.set(metadata, { syntaxVersion, promise });

    return promise.finally(() => {
        if (pendingMetadataHighlights.get(metadata)?.promise === promise) {
            pendingMetadataHighlights.delete(metadata);
        }
    });
}

/** Returns a previously computed highlight without loading grammars or tokenizing source. */
export function getCachedHighlightedDiff(
    metadata: FileDiffMetadata,
): HighlightedDiffLoadResult | undefined {
    const cached = highlightedMetadataCache.get(metadata);
    return cached?.syntaxVersion === syntaxHighlightingVersion() ? cached.result : undefined;
}

async function loadHighlightedDiffUncached(
    metadata: FileDiffMetadata,
): Promise<HighlightedDiffLoadResult> {
    const output = await highlightSyntaxDiff(metadata);
    for (const failure of output?.failures ?? [])
        recordRenderError("diff.highlight", new Error(failure));

    const packed = output?.highlight;
    if (packed === undefined) return { value: emptyHighlightedDiffSet(), failed: true };

    const dark = unpackDiffCode(packed.dark);
    let light = dark;
    if (packed.light !== null) light = unpackDiffCode(packed.light);

    return { value: { dark, light }, failed: false };
}

/** Turns a highlighted diff line into terminal spans with the row's emphasis styling. */
export function flattenHighlightedLine(
    line: HighlightedDiffLine | undefined,
    emphasisBg: string,
    fallbackText: string | (() => string),
    language?: string,
    options: { readonly boldEmphasized?: boolean; readonly dimUnchanged?: boolean } = {},
): ReadonlyArray<DiffSpan> {
    const boldEmphasized = options.boldEmphasized === true;
    const dimUnchanged = options.dimUnchanged === true;
    const cacheKey = `${emphasisBg}\u0000${language ?? ""}\u0000${Number(boldEmphasized)}\u0000${Number(dimUnchanged)}\u0000${syntaxHighlightingVersion()}`;
    let cached: Map<string, ReadonlyArray<DiffSpan>> | undefined;
    if (line !== undefined) cached = flattenedLineCache.get(line);

    const cachedSpans = cached?.get(cacheKey);
    if (cachedSpans !== undefined) {
        return cachedSpans;
    }

    if (line !== undefined && line.text.length > 0) {
        const spans: DiffSpan[] = [];
        let displayColumn = 0;
        let start = 0;
        let end = 0;
        let style = -1;
        const emit = (): void => {
            if (end <= start) return;

            const emphasized = (style & 1) === 1;
            const expanded = expandTerminalTabs(line.text.slice(start, end), 4, displayColumn);
            displayColumn = expanded.finalDisplayColumn;

            let bg: string | undefined;
            if (emphasized) bg = emphasisBg;

            spans.push(
                makeDiffSpan(expanded.text, {
                    fg: line.colors[(style >> 1) - 1],
                    bg,
                    emphasized,
                    boldEmphasized,
                    dimUnchanged,
                }),
            );
        };

        for (let index = 0; index + 1 < line.runs.length; index += 2) {
            const length = line.runs.charCodeAt(index);
            const next = line.runs.charCodeAt(index + 1);
            if (next !== style) {
                emit();
                start = end;
                style = next;
            }

            end += length;
        }

        emit();

        const enhanced = enhanceSyntaxSegments(spans, language);
        const nextCache = cached ?? new Map<string, ReadonlyArray<DiffSpan>>();
        nextCache.set(cacheKey, enhanced);
        flattenedLineCache.set(line, nextCache);

        return enhanced;
    }

    const resolvedFallback = Value.Check(fallbackTextFactorySchema, fallbackText)
        ? fallbackText()
        : fallbackText;

    return resolvedFallback.length > 0
        ? enhanceSyntaxSegments(
              [
                  makeDiffSpan(resolvedFallback, {
                      fg: undefined,
                      bg: undefined,
                      emphasized: false,
                      boldEmphasized,
                      dimUnchanged,
                  }),
              ],
              language,
          )
        : [];
}

/** Normalizes a Pierre metadata line for terminal display. */
export function cleanDiffLine(line: string | undefined): string {
    return expandTerminalTabs(cleanLastNewline(line ?? "").replace(/\r$/, ""), 4, 0).text;
}

const MAX_RUN_LENGTH = 0xffff;
const RUN_ENCODING_CHUNK = 4096;

function unpackDiffCode(code: PackedDiffCode): HighlightedDiffCode {
    const colors = code.colors;
    const unpack = (line: PackedDiffLine): HighlightedDiffLine | undefined => {
        if (line === null) return undefined;

        return { text: line[0], runs: encodeRuns(line[1]), colors };
    };

    return {
        deletionLines: code.deletionLines.map(unpack),
        additionLines: code.additionLines.map(unpack),
    };
}

function makeDiffSpan(text: string, style: SpanStyle): DiffSpan {
    let span: DiffSpan = { text };
    if (style.fg !== undefined) {
        span = { ...span, fg: style.fg };
    }

    if (style.bg !== undefined) {
        span = { ...span, bg: style.bg };
    }

    if (style.emphasized && style.boldEmphasized) {
        span = { ...span, bold: true };
    }

    if (style.dimUnchanged && !style.emphasized) {
        span = { ...span, dim: true };
    }

    if (style.emphasized) {
        span = { ...span, emphasized: true };
    }

    return span;
}

// Two-byte strings retain far less than arrays of boxed numbers.
function encodeRuns(runs: readonly number[]): string {
    const codes: number[] = [];
    let start = 0;
    for (let index = 0; index + 2 < runs.length; index += 3) {
        const end = runs[index] ?? start;
        const style = ((runs[index + 1] ?? -1) + 1) * 2 + (runs[index + 2] ?? 0);
        for (let remaining = end - start; remaining > 0; remaining -= MAX_RUN_LENGTH)
            codes.push(Math.min(remaining, MAX_RUN_LENGTH), style);

        start = end;
    }

    let encoded = "";
    for (let index = 0; index < codes.length; index += RUN_ENCODING_CHUNK)
        encoded += String.fromCharCode(...codes.slice(index, index + RUN_ENCODING_CHUNK));

    return encoded;
}
