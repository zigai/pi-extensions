import {
    cleanLastNewline,
    renderDiffWithHighlighter,
    setLanguageOverride,
    type DiffsHighlighter,
    type FileDiffMetadata,
} from "@pierre/diffs";
import type {
    DiffSpan,
    HighlightedDiffCode,
    HighlightedDiffSet,
    PierreAppearance,
} from "./types.ts";
import { enhanceSyntaxSegments } from "../syntax/brackets.ts";
import {
    getSyntaxHighlighterForLanguage,
    syntaxHighlightingVersion,
    type LoadedSyntaxHighlighter,
} from "../syntax/highlighter.ts";
import { expandTerminalTabs } from "../text-boundaries.ts";
import { isRecord } from "../unknown-values.ts";

const PIERRE_RENDER_OPTIONS = {
    useTokenTransformer: false,
    tokenizeMaxLineLength: Number.MAX_SAFE_INTEGER,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: Number.MAX_SAFE_INTEGER,
} as const;

const MAX_STYLE_CACHE_ENTRIES = 256;
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
    node: unknown,
    appearance: PierreAppearance,
    emphasisBg: string,
    fallbackText: string | (() => string),
    language?: string,
    options: { readonly boldEmphasized?: boolean; readonly dimUnchanged?: boolean } = {},
): ReadonlyArray<DiffSpan> {
    const cacheKey = `${appearance}\u0000${emphasisBg}\u0000${language ?? ""}\u0000${options.boldEmphasized === true ? 1 : 0}\u0000${options.dimUnchanged === true ? 1 : 0}\u0000${syntaxHighlightingVersion()}`;
    const cacheTarget = typeof node === "object" && node !== null ? node : undefined;
    const cached = cacheTarget === undefined ? undefined : flattenedLineCache.get(cacheTarget);
    const cachedSpans = cached?.get(cacheKey);
    if (cachedSpans !== undefined) {
        return cachedSpans;
    }

    const spans: DiffSpan[] = [];
    const colorVariable = appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";
    let displayColumn = 0;

    function visit(current: unknown, inherited: SpanStyle): void {
        if (!isRecord(current)) {
            return;
        }

        if (current.type === "text") {
            const value = typeof current.value === "string" ? current.value : "";
            const expanded = expandTerminalTabs(value, 4, displayColumn);
            displayColumn = expanded.finalDisplayColumn;
            mergeSpan(spans, makeDiffSpan(expanded.text, inherited));
            return;
        }

        if (current.type !== "element") {
            return;
        }

        const properties = isRecord(current.properties) ? current.properties : {};
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
        const children = Array.isArray(current.children) ? current.children : [];
        for (const child of children) {
            visit(child, nextStyle);
        }
    }

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
    const resolvedFallback = typeof fallbackText === "function" ? fallbackText() : fallbackText;
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
        const highlighted = renderDiffWithHighlighter(
            metadata,
            // SAFETY: Pierre's DiffsHighlighter generic type is narrower than Shiki's runtime highlighter
            // because it models Pierre's bundled theme-name set. This highlighter is the same Shiki
            // implementation and is already loaded with syntax.themeName before renderDiffWithHighlighter runs.
            syntax.highlighter as unknown as DiffsHighlighter,
            {
                ...PIERRE_RENDER_OPTIONS,
                theme: syntax.themeName,
            },
        );

        return {
            deletionLines: highlighted.code.deletionLines,
            additionLines: highlighted.code.additionLines,
        };
    } catch {
        return undefined;
    }
}

function parseStyleValue(styleValue: unknown): ReadonlyMap<string, string> {
    if (typeof styleValue !== "string") {
        return new Map();
    }
    const cached = parsedStyleCache.get(styleValue);
    if (cached !== undefined) {
        return cached;
    }

    const styles = new Map<string, string>();

    for (const segment of styleValue.split(";")) {
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

    parsedStyleCache.set(styleValue, styles);
    while (parsedStyleCache.size > MAX_STYLE_CACHE_ENTRIES) {
        const oldest = parsedStyleCache.keys().next().value;
        if (typeof oldest !== "string") break;
        parsedStyleCache.delete(oldest);
    }
    return styles;
}

function makeDiffSpan(text: string, style: SpanStyle): DiffSpan {
    return {
        text,
        ...(style.fg === undefined ? {} : { fg: style.fg }),
        ...(style.bg === undefined ? {} : { bg: style.bg }),
        ...(style.emphasized && style.boldEmphasized ? { bold: true } : {}),
        ...(style.dimUnchanged && !style.emphasized ? { dim: true } : {}),
        ...(style.emphasized ? { emphasized: true } : {}),
    };
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
