import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
    highlightSyntaxCode,
    observeSyntaxHighlightSource,
    syntaxHighlightingVersion,
} from "../../rendering/syntax/highlighter.ts";
import { normalizedCodeLines } from "../../text-boundaries.ts";
import { scheduleCodeOutputSyntaxLoad } from "../../rendering/syntax/code-component.ts";

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

type MarkdownInstance = {
    readonly theme?: MarkdownTheme;
    readonly text?: string;
    invalidate?: () => void;
    readonly defaultTextStyle?: { readonly italic?: boolean };
};

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

const markdownOwners = new WeakMap<
    MarkdownInstance,
    { readonly invalidate: () => void; version: number }
>();
let activeMarkdownInvalidation: (() => void) | undefined;
let activeMarkdownSource: (() => boolean) | undefined;

function highlightMarkdownCode(code: string, lang?: string): string[] {
    if (!markdownSyntaxEnabled) return normalizedCodeLines(code);

    scheduleCodeOutputSyntaxLoad(
        { ...(lang !== undefined && { language: lang }) },
        activeMarkdownInvalidation,
        code,
        activeMarkdownSource,
    );

    return highlightSyntaxCode(code, lang, { invalidate: activeMarkdownInvalidation });
}

/** Returns Markdown syntax patch counters for debug diagnostics. */
export function markdownSyntaxPatchStats(
    // SAFETY: The patch contract models the optional render method and symbol-owned state added to Markdown.prototype.
    prototype: MarkdownPrototype = Markdown.prototype,
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

/** Enables or disables the Markdown syntax prototype patch. */
export function configureMarkdownSyntaxPatch(
    enabled: boolean,
    // SAFETY: The patch contract models the optional render method and symbol-owned state added to Markdown.prototype.
    prototype: MarkdownPrototype = Markdown.prototype,
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
        let owner = markdownOwners.get(this);
        if (owner === undefined) {
            owner = {
                invalidate: () => {
                    this.invalidate?.();
                },
                version: syntaxHighlightingVersion(),
            };
            markdownOwners.set(this, owner);
        }

        const version = syntaxHighlightingVersion();
        if (owner.version !== version) {
            owner.version = version;
            owner.invalidate();
        }

        let current: (() => boolean) | undefined;
        if (this.text !== undefined)
            current = observeSyntaxHighlightSource(this.text, owner.invalidate);

        const previousInvalidation = activeMarkdownInvalidation;
        const previousSource = activeMarkdownSource;
        activeMarkdownInvalidation = owner.invalidate;
        activeMarkdownSource = current;

        const restoreSyntaxTheme =
            prototype[MARKDOWN_PATCH_STATE_KEY]?.enabled !== false
                ? prepareSyntaxTheme(this)
                : undefined;

        try {
            return originalRender?.call(this, width) ?? [];
        } finally {
            activeMarkdownInvalidation = previousInvalidation;
            activeMarkdownSource = previousSource;
            restoreSyntaxTheme?.();
        }
    };

    prototype.render = wrapperRender;
    prototype[MARKDOWN_PATCH_STATE_KEY] = { enabled: true, originalRender, wrapperRender };
    prototype[MARKDOWN_PATCH_KEY] = true;
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
    const theme = instance.theme;
    if (theme === undefined) {
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
    return instance.defaultTextStyle?.italic === true;
}
