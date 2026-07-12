import {
    cleanLastNewline,
    renderDiffWithHighlighter,
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
    getLoadedSyntaxHighlighterForLanguage,
    getSyntaxHighlighterForLanguage,
    type LoadedSyntaxHighlighter,
} from "../syntax/highlighter.ts";

const PIERRE_RENDER_OPTIONS = {
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 2_000,
} as const;

type UnknownRecord = {
    readonly [key: string]: unknown;
};

type SpanStyle = {
    readonly fg: string | undefined;
    readonly bg: string | undefined;
    readonly emphasized: boolean;
    readonly dimUnchanged: boolean;
};

/** Returns an empty highlighted set used while lazy highlighting is pending or unavailable. */
export function emptyHighlightedDiffSet(): HighlightedDiffSet {
    return {
        dark: { deletionLines: [], additionLines: [] },
        light: { deletionLines: [], additionLines: [] },
    };
}

/** Highlights Pierre diff metadata synchronously when the language is already loaded. */
export function highlightDiffIfLoaded(metadata: FileDiffMetadata): HighlightedDiffSet | undefined {
    const syntax = getLoadedSyntaxHighlighterForLanguage(metadata.lang ?? "text");
    if (!syntax) {
        return undefined;
    }

    const highlighted = renderHighlightedDiffCode(metadata, syntax);
    return highlighted ? { dark: highlighted, light: highlighted } : undefined;
}

/** Lazily highlights Pierre diff metadata for terminal themes. */
export async function loadHighlightedDiff(metadata: FileDiffMetadata): Promise<HighlightedDiffSet> {
    const syntax = await getSyntaxHighlighterForLanguage(metadata.lang ?? "text");
    if (!syntax) {
        return emptyHighlightedDiffSet();
    }

    const highlighted = renderHighlightedDiffCode(metadata, syntax);
    if (!highlighted) {
        return emptyHighlightedDiffSet();
    }
    return { dark: highlighted, light: highlighted };
}

/** Flattens Pierre's HAST-ish highlighted line tree into terminal spans. */
export function flattenHighlightedLine(
    node: unknown,
    appearance: PierreAppearance,
    emphasisBg: string,
    fallbackText: string,
    language?: string,
    options: { readonly dimUnchanged?: boolean } = {},
): ReadonlyArray<DiffSpan> {
    const spans: DiffSpan[] = [];
    const colorVariable = appearance === "light" ? "--diffs-token-light" : "--diffs-token-dark";

    function visit(current: unknown, inherited: SpanStyle): void {
        if (!isRecord(current)) {
            return;
        }

        if (current.type === "text") {
            const value = typeof current.value === "string" ? current.value : "";
            mergeSpan(spans, makeDiffSpan(tabify(value), inherited));
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
        dimUnchanged: options.dimUnchanged === true,
    });

    if (spans.length > 0) {
        return enhanceSyntaxSegments(spans, language);
    }
    return fallbackText.length > 0
        ? enhanceSyntaxSegments(
              [
                  makeDiffSpan(fallbackText, {
                      fg: undefined,
                      bg: undefined,
                      emphasized: false,
                      dimUnchanged: options.dimUnchanged === true,
                  }),
              ],
              language,
          )
        : [];
}

/** Normalizes a Pierre metadata line for terminal display. */
export function cleanDiffLine(line: string | undefined): string {
    return tabify(cleanLastNewline(line ?? "").replace(/\r$/, ""));
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

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tabify(text: string): string {
    return text.replace(/\t/g, "    ");
}

function parseStyleValue(styleValue: unknown): Map<string, string> {
    const styles = new Map<string, string>();
    if (typeof styleValue !== "string") {
        return styles;
    }

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

    return styles;
}

function makeDiffSpan(text: string, style: SpanStyle): DiffSpan {
    return {
        text,
        ...(style.fg === undefined ? {} : { fg: style.fg }),
        ...(style.bg === undefined ? {} : { bg: style.bg }),
        ...(style.emphasized && style.dimUnchanged ? { bold: true } : {}),
        ...(style.dimUnchanged && !style.emphasized ? { dim: true } : {}),
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
        previous.dim === next.dim
    ) {
        target[target.length - 1] = { ...previous, text: `${previous.text}${next.text}` };
        return;
    }

    target.push(next);
}
