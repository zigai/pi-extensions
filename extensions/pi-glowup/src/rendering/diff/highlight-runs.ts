import {
    getFiletypeFromFileName,
    renderDiffWithHighlighter,
    setLanguageOverride,
    type FileDiffMetadata,
} from "@pierre/diffs";
import type { ElementContent, Properties } from "hast";
import type { HighlighterGeneric, ThemeRegistration } from "shiki";
import {
    isLoadableSyntaxLanguage,
    normalizeSyntaxLanguage,
    syntaxLanguageInput,
} from "../syntax/language.ts";

const PIERRE_RENDER_OPTIONS = {
    useTokenTransformer: false,
    tokenizeMaxLineLength: Number.MAX_SAFE_INTEGER,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: Number.MAX_SAFE_INTEGER,
} as const;

const DARK_COLOR_VARIABLE = "--diffs-token-dark";
const LIGHT_COLOR_VARIABLE = "--diffs-token-light";

/** HAST subset of Pierre's highlighted lines (tag names are irrelevant here). */
export type HighlightedDiffNode =
    | Exclude<ElementContent, { readonly type: "element" }>
    | {
          readonly type: "element";
          readonly tagName?: string;
          readonly properties: Properties;
          readonly children: ReadonlyArray<HighlightedDiffNode>;
      };

/** One line as `[text, runs]`, or `null` where Pierre produced no line. */
export type PackedDiffLine = readonly [string, readonly number[]] | null;

export type PackedDiffCode = {
    readonly colors: readonly string[];
    readonly deletionLines: readonly PackedDiffLine[];
    readonly additionLines: readonly PackedDiffLine[];
};

/** Highlighted diff in transfer and storage form. `light` is `null` when it equals `dark`. */
export type PackedDiffHighlight = {
    readonly dark: PackedDiffCode;
    readonly light: PackedDiffCode | null;
};

export type DiffHighlightOutput = {
    /** Undefined when even the plain-text grammar failed. */
    readonly highlight: PackedDiffHighlight | undefined;
    readonly failures: readonly string[];
};

type LineTrees = {
    readonly deletionLines: ReadonlyArray<HighlightedDiffNode | undefined>;
    readonly additionLines: ReadonlyArray<HighlightedDiffNode | undefined>;
};

type PackedCodeResult = {
    readonly code: PackedDiffCode;
    readonly appearanceSpecific: boolean;
};

type RunStyle = {
    readonly color: number;
    readonly emphasized: boolean;
};

type PackState = {
    readonly colorVariable: string;
    readonly colors: Map<string, number>;
    readonly styles: Map<string, ReadonlyMap<string, string>>;
    appearanceSpecific: boolean;
};

/** Highlights diff metadata with Pierre and keeps only per-line text and style runs. */
export async function renderPackedDiffHighlight(
    highlighter: HighlighterGeneric<string, string>,
    metadata: FileDiffMetadata,
    theme: ThemeRegistration,
): Promise<DiffHighlightOutput> {
    const failures: string[] = [];
    const themeName = theme.name;
    if (themeName === undefined)
        return { highlight: undefined, failures: ["Syntax theme has no name"] };

    if (!highlighter.getLoadedThemes().includes(themeName)) await highlighter.loadTheme(theme);

    const requested = metadata.lang ?? getFiletypeFromFileName(metadata.name);
    const language = normalizeSyntaxLanguage(requested);
    if (language !== undefined && language !== "text" && isLoadableSyntaxLanguage(language)) {
        try {
            await highlighter.loadLanguage(syntaxLanguageInput(language));
        } catch (cause: unknown) {
            failures.push(errorMessage(cause));
        }
    }

    let trees = renderLineTrees(metadata, highlighter, themeName, failures);
    if (trees === undefined && (metadata.lang ?? "text") !== "text")
        trees = renderLineTrees(
            setLanguageOverride(metadata, "text"),
            highlighter,
            themeName,
            failures,
        );

    if (trees === undefined) return { highlight: undefined, failures };

    return { highlight: packHighlightedLines(trees), failures };
}

/** Compacts highlighted line trees into text and `[end, color, emphasized]` runs. */
export function packHighlightedLines(trees: LineTrees): PackedDiffHighlight {
    const dark = packCode(trees, DARK_COLOR_VARIABLE);
    if (!dark.appearanceSpecific) return { dark: dark.code, light: null };

    return { dark: dark.code, light: packCode(trees, LIGHT_COLOR_VARIABLE).code };
}

function renderLineTrees(
    metadata: FileDiffMetadata,
    highlighter: HighlighterGeneric<string, string>,
    themeName: string,
    failures: string[],
): LineTrees | undefined {
    try {
        const highlighted = renderDiffWithHighlighter(metadata, highlighter, {
            ...PIERRE_RENDER_OPTIONS,
            theme: themeName,
        });
        return {
            deletionLines: highlighted.code.deletionLines,
            additionLines: highlighted.code.additionLines,
        };
    } catch (cause: unknown) {
        failures.push(errorMessage(cause));
        return undefined;
    }
}

function packCode(trees: LineTrees, colorVariable: string): PackedCodeResult {
    const state: PackState = {
        colorVariable,
        colors: new Map(),
        styles: new Map(),
        appearanceSpecific: false,
    };
    const deletionLines = Array.from(trees.deletionLines, (node) => packLine(node, state));
    const additionLines = Array.from(trees.additionLines, (node) => packLine(node, state));
    return {
        code: { colors: [...state.colors.keys()], deletionLines, additionLines },
        appearanceSpecific: state.appearanceSpecific,
    };
}

function packLine(node: HighlightedDiffNode | undefined, state: PackState): PackedDiffLine {
    if (node === undefined) return null;

    let text = "";
    const runs: number[] = [];

    function visit(current: HighlightedDiffNode, inherited: RunStyle): void {
        if (current.type === "text") {
            if (current.value.length === 0) return;

            text += current.value;

            const last = runs.length - 3;
            if (
                last >= 0 &&
                runs[last + 1] === inherited.color &&
                runs[last + 2] === Number(inherited.emphasized)
            ) {
                runs[last] = text.length;
                return;
            }

            runs.push(text.length, inherited.color, Number(inherited.emphasized));

            return;
        }

        if (current.type !== "element") return;

        const properties = current.properties;
        const styles = parseStyle(properties.style, state);
        if (styles.has(DARK_COLOR_VARIABLE) || styles.has(LIGHT_COLOR_VARIABLE))
            state.appearanceSpecific = true;

        const value = styles.get(state.colorVariable) ?? styles.get("color");
        let color = inherited.color;
        if (value !== undefined) color = colorIndex(value, state);

        const next: RunStyle = {
            color,
            emphasized: Object.hasOwn(properties, "data-diff-span") || inherited.emphasized,
        };
        for (const child of current.children) visit(child, next);
    }

    visit(node, { color: -1, emphasized: false });

    return [text, runs];
}

function colorIndex(color: string, state: PackState): number {
    const existing = state.colors.get(color);
    if (existing !== undefined) return existing;

    const index = state.colors.size;
    state.colors.set(color, index);

    return index;
}

function parseStyle(style: Properties["style"], state: PackState): ReadonlyMap<string, string> {
    const text = style ?? "";
    const cached = state.styles.get(text);
    if (cached !== undefined) return cached;

    const styles = new Map<string, string>();
    for (const segment of text.split(";")) {
        const separator = segment.indexOf(":");
        if (separator <= 0) continue;

        const key = segment.slice(0, separator).trim();
        const value = segment.slice(separator + 1).trim();
        if (key.length > 0 && value.length > 0) styles.set(key, value);
    }

    state.styles.set(text, styles);

    return styles;
}

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}
