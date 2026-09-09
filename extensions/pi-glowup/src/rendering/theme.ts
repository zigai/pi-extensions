import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
    type DiffLineNumberStyle,
    type NarrowDiffLayout,
    type SideBySideLayout,
} from "./diff/layout.ts";
import ansiStyles from "ansi-styles";

type GlowupRenderBg = "toolSuccessBg" | "toolErrorBg";

export type GlowupRenderTheme = {
    readonly fg: (token: ThemeColor, text: string) => string;
    readonly bg?: (token: GlowupRenderBg, text: string) => string;
    readonly bold: (text: string) => string;
    readonly getFgAnsi?: (token: ThemeColor) => string;
    readonly getBgAnsi?: (token: GlowupRenderBg) => string;
};

export type DiffBackgroundStyle = "changed-spans" | "two-tone" | "full-row";

export type RenderingAppearance = {
    readonly diffBackgroundStyle: DiffBackgroundStyle;
    readonly diffLineNumberStyle: DiffLineNumberStyle;
    readonly narrowDiffLayout: NarrowDiffLayout;
    readonly sideBySideLayout: SideBySideLayout;
    readonly addedRowBackground: string | null;
    readonly deletedRowBackground: string | null;
    readonly addedContentBackground: string | null;
    readonly deletedContentBackground: string | null;
    readonly instructionPathColor: string | null;
    readonly dimUnchangedDiffText: boolean;
};

export type ToolCallIndicator = {
    readonly symbol: string;
    readonly bold: boolean;
};

let renderingAppearance: RenderingAppearance = {
    diffBackgroundStyle: "two-tone",
    diffLineNumberStyle: "dual",
    narrowDiffLayout: "paired",
    sideBySideLayout: "content-aware",
    addedRowBackground: "#213A2B",
    deletedRowBackground: "#4A221D",
    addedContentBackground: "#0D5728",
    deletedContentBackground: "#762925",
    instructionPathColor: null,
    dimUnchangedDiffText: false,
};

let renderingAppearanceVersion = 0;

let toolCallIndicator: ToolCallIndicator = {
    symbol: "•",
    bold: true,
};

/** Applies user-configured semantic colors used by all renderer families. */
export function configureRenderingAppearance(appearance: RenderingAppearance): void {
    renderingAppearance = { ...appearance };
    renderingAppearanceVersion += 1;
}

/** Returns a monotonic version for invalidating components that depend on appearance globals. */
export function configuredRenderingAppearanceVersion(): number {
    return renderingAppearanceVersion;
}

/** Applies user-configured tool-call indicator text used by all renderer families. */
export function configureToolCallIndicator(indicator: ToolCallIndicator): void {
    toolCallIndicator = { ...indicator };
}

function trueColorOpen(hex: string, background: boolean): string {
    const [red, green, blue] = ansiStyles.hexToRgb(hex);
    return background
        ? ansiStyles.bgColor.ansi16m(red, green, blue)
        : ansiStyles.color.ansi16m(red, green, blue);
}

/** Returns a configured semantic diff background ANSI opener when overridden. */
export function configuredDiffBackgroundAnsi(kind: "insert" | "delete"): string | undefined {
    const color =
        kind === "insert"
            ? renderingAppearance.addedRowBackground
            : renderingAppearance.deletedRowBackground;
    return color === null ? undefined : trueColorOpen(color, true);
}

/** Returns a configured semantic intraline background ANSI opener when overridden. */
export function configuredDiffContentBackgroundAnsi(kind: "insert" | "delete"): string | undefined {
    const color =
        kind === "insert"
            ? renderingAppearance.addedContentBackground
            : renderingAppearance.deletedContentBackground;
    return color === null ? undefined : trueColorOpen(color, true);
}

/** Returns the configured placement strategy for semantic diff backgrounds. */
export function configuredDiffBackgroundStyle(): DiffBackgroundStyle {
    return renderingAppearance.diffBackgroundStyle;
}

/** Returns the configured compact unified line-number gutter style. */
export function configuredDiffLineNumberStyle(): DiffLineNumberStyle {
    return renderingAppearance.diffLineNumberStyle;
}

/** Returns how replacement rows are ordered when a diff uses one column. */
export function configuredNarrowDiffLayout(): NarrowDiffLayout {
    return renderingAppearance.narrowDiffLayout;
}

/** Returns how side-by-side eligibility responds to terminal width and content. */
export function configuredSideBySideLayout(): SideBySideLayout {
    return renderingAppearance.sideBySideLayout;
}

/** Returns whether unchanged text in changed diff rows should be dimmed. */
export function configuredDimUnchangedDiffText(): boolean {
    return renderingAppearance.dimUnchangedDiffText;
}

export type GlowupCallState = "running" | "success" | "error" | "muted";

export function actionText(
    theme: GlowupRenderTheme,
    text: string,
    options?: { readonly bold?: boolean },
): string {
    const styled = options?.bold === true ? theme.bold(text) : text;
    return theme.fg("toolTitle", styled);
}

export function dim(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("dim", text);
}

export function muted(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("muted", text);
}

export function pathText(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("accent", text);
}

export function instructionPathText(theme: GlowupRenderTheme, text: string): string {
    if (renderingAppearance.instructionPathColor !== null) {
        return `${trueColorOpen(renderingAppearance.instructionPathColor, false)}${text}${ansiStyles.color.close}`;
    }

    return theme.fg("customMessageLabel", text);
}

export function green(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("toolDiffAdded", text);
}

export function red(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("toolDiffRemoved", text);
}

function success(theme: GlowupRenderTheme, text: string): string {
    return theme.fg("success", text);
}

export function renderBullet(theme: GlowupRenderTheme, state: GlowupCallState): string {
    const indicator = toolCallIndicator.bold
        ? theme.bold(toolCallIndicator.symbol)
        : toolCallIndicator.symbol;
    if (state === "success") {
        return success(theme, indicator);
    }

    if (state === "error") {
        return red(theme, indicator);
    }

    if (state === "muted") {
        return dim(theme, indicator);
    }

    return muted(theme, indicator);
}
