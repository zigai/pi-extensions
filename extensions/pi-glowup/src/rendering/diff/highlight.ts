import {
    cleanLastNewline,
    renderDiffWithHighlighter,
    setLanguageOverride,
    type FileDiffMetadata,
} from "@pierre/diffs";
import type {
    DiffSpan,
    HighlightedDiffCode,
    HighlightedDiffNode,
    HighlightedDiffSet,
    PierreAppearance,
} from "./types.ts";
import { enhanceSyntaxSegments } from "../syntax/brackets.ts";
import {
    getSyntaxHighlighterForLanguage,
    syntaxHighlightingVersion,
    type LoadedSyntaxHighlighter,
} from "../syntax/highlighter.ts";
import { expandTerminalTabs } from "../../text-boundaries.ts";
import type { Properties } from "hast";
import Type from "typebox";
import { Value } from "typebox/value";

const PIERRE_RENDER_OPTIONS = {
    useTokenTransformer: false,
    tokenizeMaxLineLength: Number.MAX_SAFE_INTEGER,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: Number.MAX_SAFE_INTEGER,
} as const;

const MAX_STYLE_CACHE_ENTRIES = 256;
const styleValueSchema = Type.String();
const fallbackTextFactorySchema = Type.Function([], Type.String());
const flattenedLineCache = new WeakMap<object, Map<string, ReadonlyArray<DiffSpan>>>();
const parsedStyleCache = new Map<string, ReadonlyMap<string, string>>();
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
    const requestedLanguage = metadata.lang ?? "text";
    const syntax =
        (await getSyntaxHighlighterForLanguage(requestedLanguage)) ??
        (await getSyntaxHighlighterForLanguage("text"));
    if (!syntax) {
        return { value: emptyHighlightedDiffSet(), failed: true };
    }

    const highlighted = renderHighlightedDiffCodeWithTextFallback(metadata, syntax);
    if (!highlighted) {
        return { value: emptyHighlightedDiffSet(), failed: true };
    }

    return { value: { dark: highlighted, light: highlighted }, failed: false };
}

/** Flattens Pierre's HAST-ish highlighted line tree into terminal spans. */
export function flattenHighlightedLine(
    node: HighlightedDiffNode | undefined,
    appearance: PierreAppearance,
    emphasisBg: string,
    fallbackText: string | (() => string),
    language?: string,
    options: { readonly boldEmphasized?: boolean; readonly dimUnchanged?: boolean } = {},
): ReadonlyArray<DiffSpan> {
    const cacheKey = `${appearance}\u0000${emphasisBg}\u0000${language ?? ""}\u0000${options.boldEmphasized === true ? 1 : 0}\u0000${options.dimUnchanged === true ? 1 : 0}\u0000${syntaxHighlightingVersion()}`;
    const cacheTarget = node;
    const cached = cacheTarget === undefined ? undefined : flattenedLineCache.get(cacheTarget);
    const cachedSpans = cached?.get(cacheKey);
    if (cachedSpans !== undefined) {
        return cachedSpans;
    }

    const spans: DiffSpan[] = [];
    const colorVariable = appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";
    let displayColumn = 0;

    function visit(current: HighlightedDiffNode, inherited: SpanStyle): void {
        if (current.type === "text") {
            const expanded = expandTerminalTabs(current.value, 4, displayColumn);
            displayColumn = expanded.finalDisplayColumn;
            mergeSpan(spans, makeDiffSpan(expanded.text, inherited));
            return;
        }

        if (current.type !== "element") {
            return;
        }

        const properties = current.properties;
        const styles = parseStyleValue(properties.style);
        const emphasized =
            Object.prototype.hasOwnProperty.call(properties, "data-diff-span") ||
            inherited.emphasized;
        const nextStyle: SpanStyle = {
            fg: styles.get(colorVariable) ?? styles.get("color") ?? inherited.fg,
            bg: emphasized ? emphasisBg : inherited.bg,
            emphasized,
            boldEmphasized: inherited.boldEmphasized,
            dimUnchanged: inherited.dimUnchanged,
        };
        for (const child of current.children) {
            visit(child, nextStyle);
        }
    }

    if (node !== undefined)
        visit(node, {
            fg: undefined,
            bg: undefined,
            emphasized: false,
            boldEmphasized: options.boldEmphasized === true,
            dimUnchanged: options.dimUnchanged === true,
        });

    if (spans.length > 0) {
        const enhanced = enhanceSyntaxSegments(spans, language);
        if (cacheTarget !== undefined) {
            const nextCache = cached ?? new Map<string, ReadonlyArray<DiffSpan>>();
            nextCache.set(cacheKey, enhanced);
            flattenedLineCache.set(cacheTarget, nextCache);
        }

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
                      boldEmphasized: options.boldEmphasized === true,
                      dimUnchanged: options.dimUnchanged === true,
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

function renderHighlightedDiffCodeWithTextFallback(
    metadata: FileDiffMetadata,
    syntax: LoadedSyntaxHighlighter,
): HighlightedDiffCode | undefined {
    const highlighted = renderHighlightedDiffCode(metadata, syntax);
    if (highlighted !== undefined || (metadata.lang ?? "text") === "text") {
        return highlighted;
    }

    return renderHighlightedDiffCode(setLanguageOverride(metadata, "text"), syntax);
}

function renderHighlightedDiffCode(
    metadata: FileDiffMetadata,
    syntax: LoadedSyntaxHighlighter,
): HighlightedDiffCode | undefined {
    try {
        const highlighted = renderDiffWithHighlighter(metadata, syntax.highlighter, {
            ...PIERRE_RENDER_OPTIONS,
            theme: syntax.themeName,
        });
        return {
            deletionLines: highlighted.code.deletionLines,
            additionLines: highlighted.code.additionLines,
        };
    } catch {
        return undefined;
    }
}

function parseStyleValue(styleValue: Properties["style"]): ReadonlyMap<string, string> {
    let parsedStyle: string;
    try {
        parsedStyle = Value.Parse(styleValueSchema, styleValue);
    } catch {
        return new Map();
    }

    const cached = parsedStyleCache.get(parsedStyle);
    if (cached !== undefined) {
        return cached;
    }

    const styles = new Map<string, string>();
    for (const segment of parsedStyle.split(";")) {
        const separator = segment.indexOf(":");
        if (separator <= 0) {
            continue;
        }

        const key = segment.slice(0, separator).trim();
        const value = segment.slice(separator + 1).trim();
        if (key.length > 0 && value.length > 0) {
            styles.set(key, value);
        }
    }

    parsedStyleCache.set(parsedStyle, styles);

    while (parsedStyleCache.size > MAX_STYLE_CACHE_ENTRIES) {
        const oldest = parsedStyleCache.keys().next().value;
        if (oldest === undefined) break;
        parsedStyleCache.delete(oldest);
    }

    return styles;
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

function mergeSpan(target: DiffSpan[], next: DiffSpan): void {
    if (next.text.length === 0) {
        return;
    }

    const previous = target[target.length - 1];
    if (
        previous &&
        previous.fg === next.fg &&
        previous.bg === next.bg &&
        previous.bold === next.bold &&
        previous.dim === next.dim &&
        previous.emphasized === next.emphasized
    ) {
        target[target.length - 1] = { ...previous, text: `${previous.text}${next.text}` };
        return;
    }

    target.push(next);
}
