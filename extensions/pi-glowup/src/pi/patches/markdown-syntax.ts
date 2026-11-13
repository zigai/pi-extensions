import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
    highlightSyntaxCode,
    observeSyntaxHighlightSource,
    syntaxHighlightingVersion,
} from "../../rendering/syntax/highlighter.ts";
import Type from "typebox";
import { Compile } from "typebox/compile";
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
    readonly paddingX?: unknown;
    readonly options?: unknown;
    invalidate?: () => void;
    readonly defaultTextStyle?: { readonly italic?: boolean };
};

type MarkdownRender = (this: MarkdownInstance, width: number) => string[];
type MarkdownSetText = (this: MarkdownInstance, text: string) => void;
type MarkdownInvalidate = (this: MarkdownInstance) => void;

type RenderedWidth = {
    readonly width: number;
    readonly source: string;
    readonly lines: string[];
};

// Rendered lines for the two most recent widths. `stale` marks a setText call since
// the last render: Pi reads streaming state through its transform at that point.
type MarkdownLineCache = {
    text: string | undefined;
    stale: boolean;
    entries: RenderedWidth[];
};

type MarkdownPatchState = {
    enabled: boolean;
    readonly lineCaches: WeakMap<MarkdownInstance, MarkdownLineCache> | undefined;
    readonly originalRender: MarkdownPrototype["render"];
    readonly wrapperRender: MarkdownRender;
    readonly originalSetText: MarkdownSetText | undefined;
    readonly wrapperSetText: MarkdownSetText | undefined;
    readonly originalInvalidate: MarkdownInvalidate | undefined;
    readonly wrapperInvalidate: MarkdownInvalidate | undefined;
};

type MarkdownPrototype = {
    render?: MarkdownRender;
    setText?: MarkdownSetText;
    invalidate?: MarkdownInvalidate;
    [MARKDOWN_PATCH_KEY]?: true;
    [MARKDOWN_PATCH_STATE_KEY]?: MarkdownPatchState;
};

type MarkdownOwner = {
    readonly invalidate: () => void;
    version: number;
    highlighted: boolean;
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

const MAX_CACHED_WIDTHS = 2;

const markdownSourceValidator = Compile(
    Type.Object({
        text: Type.String(),
        paddingX: Type.Number(),
        options: Type.Object({
            transform: Type.Optional(Type.Function([Type.String(), Type.Number()], Type.Unknown())),
        }),
    }),
);
const transformedSourceValidator = Compile(Type.String());
const markdownOwners = new WeakMap<MarkdownInstance, MarkdownOwner>();
let activeMarkdownOwner: MarkdownOwner | undefined;
let activeMarkdownInvalidation: (() => void) | undefined;
let activeMarkdownSource: (() => boolean) | undefined;

function highlightMarkdownCode(code: string, lang?: string): string[] {
    if (activeMarkdownOwner !== undefined) activeMarkdownOwner.highlighted = true;

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

            if (ownsMarkdownMethods(prototype, state)) {
                restoreMarkdownMethod(prototype, "render", state.originalRender);

                if (state.wrapperSetText !== undefined)
                    restoreMarkdownMethod(prototype, "setText", state.originalSetText);

                if (state.wrapperInvalidate !== undefined)
                    restoreMarkdownMethod(prototype, "invalidate", state.originalInvalidate);

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
    const originalSetText = prototype.setText;
    const originalInvalidate = prototype.invalidate;

    // Cached lines are only safe when every source and theme change is observable.
    let lineCaches: WeakMap<MarkdownInstance, MarkdownLineCache> | undefined;
    if (originalSetText !== undefined && originalInvalidate !== undefined)
        lineCaches = new WeakMap();

    const wrapperRender = function renderWithGlowupSyntax(this: MarkdownInstance, width: number) {
        if (prototype[MARKDOWN_PATCH_STATE_KEY]?.enabled === false)
            return originalRender?.call(this, width) ?? [];

        let owner = markdownOwners.get(this);
        if (owner === undefined) {
            owner = {
                invalidate: () => {
                    this.invalidate?.();
                },
                version: syntaxHighlightingVersion(),
                highlighted: false,
            };
            markdownOwners.set(this, owner);
        }

        const version = syntaxHighlightingVersion();
        if (owner.version !== version) {
            owner.version = version;

            // Only fenced code depends on highlighter state; prose and thinking keep their lines.
            if (owner.highlighted) owner.invalidate();
        }

        const lineCache = lineCaches?.get(this);
        const latest = lineCache?.entries[0];
        if (
            lineCache !== undefined &&
            latest !== undefined &&
            !lineCache.stale &&
            lineCache.text === this.text &&
            latest.width === width
        )
            return latest.lines;

        let source: string | undefined;
        if (lineCaches !== undefined) source = transformedMarkdownSource(this, width);

        if (lineCache !== undefined && source !== undefined) {
            const cached = lineCache.entries.find(
                (entry) => entry.width === width && entry.source === source,
            );
            if (cached !== undefined) {
                lineCache.text = this.text;
                lineCache.stale = false;
                lineCache.entries = [
                    cached,
                    ...lineCache.entries.filter((entry) => entry !== cached),
                ];

                return cached.lines;
            }
        }

        let current: (() => boolean) | undefined;
        if (this.text !== undefined)
            current = observeSyntaxHighlightSource(this.text, owner.invalidate);

        const previousOwner = activeMarkdownOwner;
        const previousInvalidation = activeMarkdownInvalidation;
        const previousSource = activeMarkdownSource;
        activeMarkdownOwner = owner;
        activeMarkdownInvalidation = owner.invalidate;
        activeMarkdownSource = current;

        const restoreSyntaxTheme = prepareSyntaxTheme(this);
        let lines: string[];
        try {
            lines = originalRender?.call(this, width) ?? [];
        } finally {
            activeMarkdownOwner = previousOwner;
            activeMarkdownInvalidation = previousInvalidation;
            activeMarkdownSource = previousSource;
            restoreSyntaxTheme?.();
        }

        if (lineCaches !== undefined && source !== undefined)
            rememberRenderedWidth(lineCaches, this, { width, source, lines });

        return lines;
    };

    let wrapperSetText: MarkdownSetText | undefined;
    if (originalSetText !== undefined) {
        wrapperSetText = function setTextWithGlowupCache(this: MarkdownInstance, text: string) {
            const lineCache = lineCaches?.get(this);
            if (lineCache !== undefined) lineCache.stale = true;

            originalSetText.call(this, text);
        };
        prototype.setText = wrapperSetText;
    }

    let wrapperInvalidate: MarkdownInvalidate | undefined;
    if (originalInvalidate !== undefined) {
        wrapperInvalidate = function invalidateWithGlowupCache(this: MarkdownInstance) {
            lineCaches?.delete(this);
            originalInvalidate.call(this);
        };
        prototype.invalidate = wrapperInvalidate;
    }

    prototype.render = wrapperRender;
    prototype[MARKDOWN_PATCH_STATE_KEY] = {
        enabled: true,
        lineCaches,
        originalRender,
        wrapperRender,
        originalSetText,
        wrapperSetText,
        originalInvalidate,
        wrapperInvalidate,
    };
    prototype[MARKDOWN_PATCH_KEY] = true;
}

function ownsMarkdownMethods(prototype: MarkdownPrototype, state: MarkdownPatchState): boolean {
    return (
        prototype.render === state.wrapperRender &&
        (state.wrapperSetText === undefined || prototype.setText === state.wrapperSetText) &&
        (state.wrapperInvalidate === undefined || prototype.invalidate === state.wrapperInvalidate)
    );
}

// Pi keys its own line cache by raw text and width and resets it on setText, because
// extension transforms may read streaming state. Keying by the transformed source
// keeps that contract while surviving the setText calls of an unchanged message.
function transformedMarkdownSource(instance: MarkdownInstance, width: number): string | undefined {
    if (!markdownSourceValidator.Check(instance)) return undefined;

    const transformed = instance.options.transform?.(
        instance.text,
        Math.max(1, width - instance.paddingX * 2),
    );
    if (transformed === undefined || transformed === null) return instance.text;

    if (!transformedSourceValidator.Check(transformed)) return undefined;

    return transformed;
}

function rememberRenderedWidth(
    lineCaches: WeakMap<MarkdownInstance, MarkdownLineCache>,
    instance: MarkdownInstance,
    rendered: RenderedWidth,
): void {
    // Pi returns an uncached [""] for blank output and [] afterwards; let it keep doing so.
    if (rendered.lines.length === 0 || (rendered.lines.length === 1 && rendered.lines[0] === "")) {
        lineCaches.delete(instance);
        return;
    }

    // Width-dependent sources (formatted code) differ per width, so keep the other
    // width even when the source changed; the cap bounds what a stream can retain.
    const previous = lineCaches.get(instance)?.entries ?? [];
    const entries = [rendered, ...previous.filter((entry) => entry.width !== rendered.width)].slice(
        0,
        MAX_CACHED_WIDTHS,
    );
    lineCaches.set(instance, { text: instance.text, stale: false, entries });
}

function restoreMarkdownMethod<TName extends "render" | "setText" | "invalidate">(
    prototype: MarkdownPrototype,
    name: TName,
    method: MarkdownPrototype[TName],
): void {
    if (method === undefined) {
        delete prototype[name];
        return;
    }

    prototype[name] = method;
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
