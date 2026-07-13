import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PierreAppearance } from "./types.ts";
import { SYNTAX_THEME_APPEARANCE } from "../syntax/theme-assets.ts";
import { strongerDiffBackgroundAnsi } from "./ansi-colors.ts";
import {
    configuredDiffBackgroundAnsi,
    configuredDiffBackgroundStyle,
    configuredDiffContentBackgroundAnsi,
    configuredDimUnchangedDiffText,
} from "../rendering/core.ts";

/** Terminal color palette derived from Pi's active theme. */
export type PierreTerminalPalette = {
    readonly appearance: PierreAppearance;
    readonly contextFg: string;
    readonly contextRowBg: string;
    readonly additionFg: string;
    readonly additionRowBg: string;
    readonly additionSpanBg: string;
    readonly deletionFg: string;
    readonly deletionRowBg: string;
    readonly deletionSpanBg: string;
    readonly emptyFg: string;
    readonly emptyRowBg: string;
    readonly lineNumberFg: string;
    readonly metadataFg: string;
    readonly metadataBg: string;
    readonly dividerFg: string;
    readonly dividerBg: string;
    readonly dimUnchangedText: boolean;
};

/** Resolves the closest Pierre syntax-highlighting appearance for the active Pi theme. */
export function getPierreAppearance(_theme: Theme): PierreAppearance {
    return SYNTAX_THEME_APPEARANCE satisfies PierreAppearance;
}

/** Resolves diff terminal styling from Pi theme tokens. */
export function getPierrePalette(theme: Theme): PierreTerminalPalette {
    const additionBackground =
        configuredDiffBackgroundAnsi("insert") ?? theme.getBgAnsi("toolSuccessBg");
    const deletionBackground =
        configuredDiffBackgroundAnsi("delete") ?? theme.getBgAnsi("toolErrorBg");
    const backgroundStyle = configuredDiffBackgroundStyle();
    const paintChangedRows = backgroundStyle === "full-row" || backgroundStyle === "two-tone";
    const additionSpanBackground =
        backgroundStyle === "two-tone"
            ? (configuredDiffContentBackgroundAnsi("insert") ??
              strongerDiffBackgroundAnsi(additionBackground, theme.getFgAnsi("toolDiffAdded")) ??
              additionBackground)
            : additionBackground;
    const deletionSpanBackground =
        backgroundStyle === "two-tone"
            ? (configuredDiffContentBackgroundAnsi("delete") ??
              strongerDiffBackgroundAnsi(deletionBackground, theme.getFgAnsi("toolDiffRemoved")) ??
              deletionBackground)
            : deletionBackground;
    return {
        appearance: getPierreAppearance(theme),
        contextFg: theme.getFgAnsi("toolDiffContext"),
        contextRowBg: "",
        additionFg: theme.getFgAnsi("toolDiffAdded"),
        additionRowBg: paintChangedRows ? additionBackground : "",
        additionSpanBg: additionSpanBackground,
        deletionFg: theme.getFgAnsi("toolDiffRemoved"),
        deletionRowBg: paintChangedRows ? deletionBackground : "",
        deletionSpanBg: deletionSpanBackground,
        emptyFg: theme.getFgAnsi("dim"),
        emptyRowBg: "",
        lineNumberFg: theme.getFgAnsi("dim"),
        metadataFg: theme.getFgAnsi("muted"),
        metadataBg: "",
        dividerFg: theme.getFgAnsi("dim"),
        dividerBg: "",
        dimUnchangedText: configuredDimUnchangedDiffText() && !paintChangedRows,
    };
}
