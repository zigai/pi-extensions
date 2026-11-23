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
import {
    functionCallRanges,
    pythonCallColors,
    pythonFunctionNames,
    sameColor,
    type PythonCallColors,
} from "../syntax/python-class-calls.ts";
import { trimRangeWhitespace, type TextRange } from "./text-ranges.ts";

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

    const trees = renderLineTrees(metadata, highlighter, themeName, failures);
    if (trees === undefined) {
        if ((metadata.lang ?? "text") === "text") return { highlight: undefined, failures };

        const plain = renderLineTrees(
            setLanguageOverride(metadata, "text"),
            highlighter,
            themeName,
            failures,
        );
        if (plain === undefined) return { highlight: undefined, failures };

        return { highlight: packHighlightedLines(plain), failures };
    }

    const highlight = packHighlightedLines(trees);
    if (language !== "python") return { highlight, failures };

    return {
        highlight: recolorPythonFunctionCallRuns(highlight, metadata, highlighter, theme),
        failures,
    };
}

function recolorPythonFunctionCallRuns(
    highlight: PackedDiffHighlight,
    metadata: FileDiffMetadata,
    highlighter: HighlighterGeneric<string, string>,
    theme: ThemeRegistration,
): PackedDiffHighlight {
    const deletionNames = pythonFunctionNames(metadata.deletionLines);
    const additionNames = pythonFunctionNames(metadata.additionLines);
    if (deletionNames.size === 0 && additionNames.size === 0) return highlight;

    const colors = pythonCallColors(highlighter, theme);
    if (colors === undefined) return highlight;

    const recolor = (code: PackedDiffCode): PackedDiffCode =>
        recolorCodeRuns(code, colors, deletionNames, additionNames);

    let light: PackedDiffCode | null = null;
    if (highlight.light !== null) light = recolor(highlight.light);

    return { dark: recolor(highlight.dark), light };
}

function recolorCodeRuns(
    code: PackedDiffCode,
    colors: PythonCallColors,
    deletionNames: ReadonlySet<string>,
    additionNames: ReadonlySet<string>,
): PackedDiffCode {
    const from = code.colors.findIndex((color) => sameColor(color, colors.classCall));
    if (from < 0) return code;

    const palette = [...code.colors];
    let to = palette.findIndex((color) => sameColor(color, colors.functionCall));
    if (to < 0) to = palette.push(colors.functionCall) - 1;

    const recolorLine =
        (names: ReadonlySet<string>) =>
        (line: PackedDiffLine): PackedDiffLine => {
            if (line === null || names.size === 0) return line;

            const [text, runs] = line;
            const recolored: number[] = [];
            let start = 0;
            for (let index = 0; index + 2 < runs.length; index += 3) {
                const end = runs[index] ?? start;
                const color = runs[index + 1] ?? -1;
                const emphasized = runs[index + 2] ?? 0;
                if (color === from)
                    for (const [rangeStart, rangeEnd] of functionCallRanges(
                        text,
                        start,
                        end,
                        names,
                    )) {
                        if (rangeStart > start) recolored.push(rangeStart, color, emphasized);
                        recolored.push(rangeEnd, to, emphasized);
                        start = rangeEnd;
                    }

                if (end > start) recolored.push(end, color, emphasized);
                start = end;
            }

            return [text, recolored];
        };

    return {
        colors: palette,
        deletionLines: code.deletionLines.map(recolorLine(deletionNames)),
        additionLines: code.additionLines.map(recolorLine(additionNames)),
    };
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
    const spans: TextRange[] = [];

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

        const opensSpan = !inherited.emphasized && Object.hasOwn(properties, "data-diff-span");
        const next: RunStyle = { color, emphasized: inherited.emphasized || opensSpan };
        const start = text.length;

        for (const child of current.children) visit(child, next);

        if (opensSpan) spans.push({ start, end: text.length });
    }

    visit(node, { color: -1, emphasized: false });

    if (spans.length === 0) return [text, runs];

    return [text, emphasizeOnly(runs, trimRangeWhitespace(text, spans))];
}

function emphasizeOnly(runs: readonly number[], kept: readonly TextRange[]): number[] {
    const packed: number[] = [];
    const push = (end: number, color: number, emphasized: number): void => {
        const last = packed.length - 3;
        if (last >= 0 && packed[last + 1] === color && packed[last + 2] === emphasized) {
            packed[last] = end;
            return;
        }

        packed.push(end, color, emphasized);
    };

    let start = 0;
    let keptIndex = 0;
    for (let index = 0; index + 2 < runs.length; index += 3) {
        const end = runs[index] ?? start;
        const color = runs[index + 1] ?? -1;
        if (runs[index + 2] !== 1) {
            push(end, color, 0);
            start = end;
            continue;
        }

        let offset = start;
        while (offset < end) {
            while ((kept[keptIndex]?.end ?? Infinity) <= offset) keptIndex += 1;

            const range = kept[keptIndex];
            if (range === undefined || range.start >= end) {
                push(end, color, 0);
                break;
            }

            if (range.start > offset) push(range.start, color, 0);

            offset = Math.min(range.end, end);
            push(offset, color, 1);
        }

        start = end;
    }

    return packed;
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
