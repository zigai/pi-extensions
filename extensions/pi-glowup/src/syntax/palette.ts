import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** Named syntax accent colors mirrored from the bundled VS Code-compatible theme. */
export const SYNTAX_ACCENT_COLORS = {
  bracketPair: ["#FFD700", "#DA70D6", "#179FFF"],
  neutralForegrounds: ["#d4d4d4", "#eeffff"],
  pythonImportIdentifier: "#4EC9B0",
  pythonConstantIdentifier: "#4EC9B0",
  pythonVariableIdentifier: "#9CDCFE",
  pythonFunctionIdentifier: "#DCDCAA",
} as const;

/** Semantic Pi theme tokens used by custom Codex-look renderers. */
export const RENDER_THEME_TOKENS = {
  url: "accent",
} as const satisfies Record<string, ThemeColor>;
