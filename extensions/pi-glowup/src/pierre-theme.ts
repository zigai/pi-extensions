import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PierreAppearance } from "./pierre-diff-types.ts";

/** Terminal color palette derived from Pi's active theme. */
export type PierreTerminalPalette = {
  readonly appearance: PierreAppearance;
  readonly contextFg: string;
  readonly contextRowBg: string;
  readonly additionFg: string;
  readonly additionRowBg: string;
  readonly deletionFg: string;
  readonly deletionRowBg: string;
  readonly emptyFg: string;
  readonly emptyRowBg: string;
  readonly lineNumberFg: string;
  readonly metadataFg: string;
  readonly metadataBg: string;
  readonly dividerFg: string;
  readonly dividerBg: string;
};

/** Resolves the closest Pierre syntax-highlighting appearance for the active Pi theme. */
export function getPierreAppearance(theme: Theme): PierreAppearance {
  return theme.name?.toLowerCase().includes("light") ? "light" : "dark";
}

/** Resolves diff terminal styling from Pi theme tokens. */
export function getPierrePalette(theme: Theme): PierreTerminalPalette {
  return {
    appearance: getPierreAppearance(theme),
    contextFg: theme.getFgAnsi("toolDiffContext"),
    contextRowBg: "",
    additionFg: theme.getFgAnsi("toolDiffAdded"),
    additionRowBg: theme.getBgAnsi("toolSuccessBg"),
    deletionFg: theme.getFgAnsi("toolDiffRemoved"),
    deletionRowBg: theme.getBgAnsi("toolErrorBg"),
    emptyFg: theme.getFgAnsi("dim"),
    emptyRowBg: "",
    lineNumberFg: theme.getFgAnsi("dim"),
    metadataFg: theme.getFgAnsi("muted"),
    metadataBg: "",
    dividerFg: theme.getFgAnsi("dim"),
    dividerBg: "",
  };
}
