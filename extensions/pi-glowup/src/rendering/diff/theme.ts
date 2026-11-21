import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { PierreAppearance } from "./types.ts";
import { SYNTAX_THEME_APPEARANCE } from "../syntax/theme-assets.ts";
import { strongerDiffBackgroundAnsi } from "./ansi-colors.ts";
import {
    configuredDiffBackgroundAnsi,
    configuredDiffBackgroundStyle,
    configuredDiffContentBackgroundAnsi,
    configuredDimUnchangedDiffText,
    type GlowupRenderTheme,
} from "../theme.ts";

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

export function getPierrePalette(theme: GlowupRenderTheme): PierreTerminalPalette {
    const additionBackground =
        configuredDiffBackgroundAnsi("insert") ?? theme.getBgAnsi?.("toolSuccessBg") ?? "";
    const deletionBackground =
        configuredDiffBackgroundAnsi("delete") ?? theme.getBgAnsi?.("toolErrorBg") ?? "";
    const backgroundStyle = configuredDiffBackgroundStyle();
    const paintChangedRows = backgroundStyle === "full-row" || backgroundStyle === "two-tone";
    const additionSpanBackground =
        backgroundStyle === "two-tone"
            ? (configuredDiffContentBackgroundAnsi("insert") ??
              strongerDiffBackgroundAnsi(additionBackground, themeFgAnsi(theme, "toolDiffAdded")) ??
              additionBackground)
            : additionBackground;
    const deletionSpanBackground =
        backgroundStyle === "two-tone"
            ? (configuredDiffContentBackgroundAnsi("delete") ??
              strongerDiffBackgroundAnsi(
                  deletionBackground,
                  themeFgAnsi(theme, "toolDiffRemoved"),
              ) ??
              deletionBackground)
            : deletionBackground;

    return {
        appearance: SYNTAX_THEME_APPEARANCE,
        contextFg: themeFgAnsi(theme, "toolDiffContext"),
        contextRowBg: "",
        additionFg: themeFgAnsi(theme, "toolDiffAdded"),
        additionRowBg: paintChangedRows ? additionBackground : "",
        additionSpanBg: additionSpanBackground,
        deletionFg: themeFgAnsi(theme, "toolDiffRemoved"),
        deletionRowBg: paintChangedRows ? deletionBackground : "",
        deletionSpanBg: deletionSpanBackground,
        emptyFg: themeFgAnsi(theme, "dim"),
        emptyRowBg: "",
        lineNumberFg: themeFgAnsi(theme, "dim"),
        metadataFg: themeFgAnsi(theme, "muted"),
        metadataBg: "",
        dividerFg: themeFgAnsi(theme, "dim"),
        dividerBg: "",
        dimUnchangedText: configuredDimUnchangedDiffText() && !paintChangedRows,
    };
}

function themeFgAnsi(theme: GlowupRenderTheme, token: ThemeColor): string {
    return theme.getFgAnsi?.(token) ?? "";
}
