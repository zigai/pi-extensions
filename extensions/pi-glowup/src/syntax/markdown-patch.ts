import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { highlightSyntaxCode } from "./highlighter.ts";

const MARKDOWN_PATCH_KEY = Symbol.for("zigai.pi-glowup.syntax-markdown");
const MARKDOWN_PATCH_STATE_KEY = Symbol.for("zigai.pi-glowup.syntax-markdown.state");

let markdownSyntaxEnabled = false;
let markdownRenderInjections = 0;
let markdownThemePatchAttempts = 0;
let markdownThemePatches = 0;
let markdownThemePatchHits = 0;
let markdownThemePatchFailures = 0;
let markdownThinkingThemeSuppressions = 0;
let markdownThinkingThemeSuppressionFailures = 0;

type MarkdownInstance = object;

type MarkdownPatchState = {
    enabled: boolean;
    readonly originalRender: MarkdownPrototype["render"];
    readonly wrapperRender: NonNullable<MarkdownPrototype["render"]>;
};

type MarkdownPrototype = {
    render?: (this: MarkdownInstance, width: number) => string[];
    [MARKDOWN_PATCH_KEY]?: true;
    [MARKDOWN_PATCH_STATE_KEY]?: MarkdownPatchState;
};

export type MarkdownSyntaxPatchStats = {
    readonly highlightingEnabled: boolean;
    readonly renderPatchEnabled: boolean;
    readonly renderInjections: number;
    readonly themePatchAttempts: number;
    readonly themePatches: number;
    readonly themePatchHits: number;
    readonly themePatchFailures: number;
    readonly thinkingThemeSuppressions: number;
    readonly thinkingThemeSuppressionFailures: number;
};

function highlightMarkdownCode(code: string, lang?: string): string[] {
    return markdownSyntaxEnabled ? highlightSyntaxCode(code, lang) : splitMarkdownCodeLines(code);
}

/** Returns Markdown syntax patch counters for debug diagnostics. */
export function markdownSyntaxPatchStats(
    prototype: MarkdownPrototype = Markdown.prototype as unknown as MarkdownPrototype,
): MarkdownSyntaxPatchStats {
    return {
        highlightingEnabled: markdownSyntaxEnabled,
        renderPatchEnabled: prototype[MARKDOWN_PATCH_STATE_KEY]?.enabled === true,
        renderInjections: markdownRenderInjections,
        themePatchAttempts: markdownThemePatchAttempts,
        themePatches: markdownThemePatches,
        themePatchHits: markdownThemePatchHits,
        themePatchFailures: markdownThemePatchFailures,
        thinkingThemeSuppressions: markdownThinkingThemeSuppressions,
        thinkingThemeSuppressionFailures: markdownThinkingThemeSuppressionFailures,
    };
}

/** Installs an idempotent Markdown render patch that injects the central syntax highlighter. */
export function installMarkdownSyntaxPatch(
    prototype: MarkdownPrototype = Markdown.prototype as unknown as MarkdownPrototype,
): void {
    configureMarkdownSyntaxPatch(true, prototype);
}

/** Enables or disables the Markdown syntax prototype patch. */
export function configureMarkdownSyntaxPatch(
    enabled: boolean,
    prototype: MarkdownPrototype = Markdown.prototype as unknown as MarkdownPrototype,
): void {
    const state = prototype[MARKDOWN_PATCH_STATE_KEY];

    if (!enabled) {
        markdownSyntaxEnabled = false;
        if (state !== undefined) {
            state.enabled = false;
            if (prototype.render === state.wrapperRender) {
                restoreMarkdownRender(prototype, state.originalRender);
                delete prototype[MARKDOWN_PATCH_STATE_KEY];
                delete prototype[MARKDOWN_PATCH_KEY];
            }
        }
        return;
    }

    markdownSyntaxEnabled = true;

    if (state !== undefined) {
        state.enabled = true;
        return;
    }

    const originalRender = prototype.render;
    const wrapperRender = function renderWithGlowupSyntax(this: MarkdownInstance, width: number) {
        const restoreSyntaxTheme =
            prototype[MARKDOWN_PATCH_STATE_KEY]?.enabled !== false
                ? prepareSyntaxTheme(this)
                : undefined;
        try {
            return originalRender?.call(this, width) ?? [];
        } finally {
            restoreSyntaxTheme?.();
        }
    };
    prototype.render = wrapperRender;
    prototype[MARKDOWN_PATCH_STATE_KEY] = { enabled: true, originalRender, wrapperRender };
    prototype[MARKDOWN_PATCH_KEY] = true;
}

function splitMarkdownCodeLines(code: string): string[] {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function restoreMarkdownRender(
    prototype: MarkdownPrototype,
    originalRender: MarkdownPrototype["render"],
): void {
    if (originalRender === undefined) {
        delete prototype.render;
        return;
    }
    prototype.render = originalRender;
}

function prepareSyntaxTheme(instance: MarkdownInstance): (() => void) | undefined {
    const theme = Reflect.get(instance, "theme");
    if (!isMarkdownTheme(theme)) {
        return undefined;
    }

    if (isThinkingMarkdown(instance)) {
        return suppressSyntaxMarkdownTheme(theme);
    }

    markdownRenderInjections += 1;
    const originalHighlightDescriptor = Object.getOwnPropertyDescriptor(theme, "highlightCode");
    patchSyntaxMarkdownTheme(theme);
    return () => restoreSyntaxMarkdownTheme(theme, originalHighlightDescriptor);
}

function restoreSyntaxMarkdownTheme(
    theme: MarkdownTheme,
    originalHighlightDescriptor: PropertyDescriptor | undefined,
): void {
    try {
        if (originalHighlightDescriptor === undefined) {
            Reflect.deleteProperty(theme, "highlightCode");
            return;
        }
        Reflect.defineProperty(theme, "highlightCode", originalHighlightDescriptor);
    } catch {
        markdownThemePatchFailures += 1;
    }
}

function suppressSyntaxMarkdownTheme(theme: MarkdownTheme): (() => void) | undefined {
    const highlightCode = theme.highlightCode;
    if (highlightCode !== highlightMarkdownCode) {
        return undefined;
    }

    markdownThinkingThemeSuppressions += 1;
    if (!Reflect.deleteProperty(theme, "highlightCode")) {
        markdownThinkingThemeSuppressionFailures += 1;
        return undefined;
    }

    return () => {
        try {
            theme.highlightCode = highlightCode;
        } catch {
            markdownThinkingThemeSuppressionFailures += 1;
        }
    };
}

function patchSyntaxMarkdownTheme(theme: MarkdownTheme): void {
    if (theme.highlightCode === highlightMarkdownCode) {
        markdownThemePatchHits += 1;
        return;
    }

    markdownThemePatchAttempts += 1;
    try {
        theme.highlightCode = highlightMarkdownCode;
    } catch {
        markdownThemePatchFailures += 1;
        return;
    }

    if (theme.highlightCode === highlightMarkdownCode) {
        markdownThemePatches += 1;
        return;
    }
    markdownThemePatchFailures += 1;
}

function isThinkingMarkdown(instance: MarkdownInstance): boolean {
    const defaultTextStyle = Reflect.get(instance, "defaultTextStyle");
    return (
        typeof defaultTextStyle === "object" &&
        defaultTextStyle !== null &&
        Reflect.get(defaultTextStyle, "italic") === true
    );
}

function isMarkdownTheme(value: unknown): value is MarkdownTheme {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "codeBlock") === "function"
    );
}
