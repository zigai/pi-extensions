import { normalizeSyntaxLanguage, syntaxLanguageFromFile } from "./language.ts";
import {
    getLoadedSyntaxHighlighterForLanguage,
    highlightSyntaxCode,
    highlightSyntaxCodeAsync,
    observeSyntaxHighlightSource,
    loadSyntaxLanguageIfReady,
    onSyntaxHighlightingStateChange,
} from "./highlighter.ts";
import { recordRenderError } from "../../diagnostics/render-events.ts";

export type CodeOutputSyntax = {
    readonly language?: string;
    readonly path?: string;
    readonly cache?: boolean | undefined;
    readonly invalidate?: (() => void) | undefined;
};

const MAX_STRUCTURED_OUTPUT_DETECTION_CHARS = 64 * 1024;
const pendingCodeOutputSyntaxLoads = new Map<string, Set<() => void>>();
const activeCodeOutputSyntaxLoads = new Map<string, Promise<boolean>>();

onSyntaxHighlightingStateChange((status) => {
    if (status === "ready") {
        for (const language of pendingCodeOutputSyntaxLoads.keys()) {
            requestPendingCodeOutputSyntaxLoad(language);
        }

        return;
    }

    pendingCodeOutputSyntaxLoads.clear();
    activeCodeOutputSyntaxLoads.clear();
});

/** Highlights code-like output when a language or path is known; otherwise returns normalized plain lines. */
export function highlightCodeOutput(text: string, syntax: CodeOutputSyntax | undefined): string[] {
    const language = syntax?.language ?? syntaxLanguageFromFile(syntax?.path, text);
    return highlightSyntaxCode(text, language, {
        cache: syntax?.cache,
        invalidate: syntax?.invalidate,
    });
}

/** Schedules async loading for path/language hints so later sync renders can highlight them. */
export function scheduleCodeOutputSyntaxLoad(
    syntax: CodeOutputSyntax | undefined,
    invalidate: (() => void) | undefined,
    content?: string,
    current?: () => boolean,
): void {
    if (invalidate === undefined) {
        return;
    }

    let isCurrent = current;
    if (isCurrent === undefined && content !== undefined)
        isCurrent = observeSyntaxHighlightSource(content, invalidate);

    const language = syntax?.language ?? syntaxLanguageFromFile(syntax?.path, content);
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    if (normalizedLanguage === undefined || normalizedLanguage === "text") {
        return;
    }

    const refresh = (): void => {
        if (isCurrent !== undefined && !isCurrent()) return;

        if (content === undefined) {
            invalidate();
            return;
        }

        void highlightSyntaxCodeAsync(content, normalizedLanguage, {
            invalidate,
            cache: syntax?.cache,
        });
    };
    if (getLoadedSyntaxHighlighterForLanguage(normalizedLanguage) !== undefined) {
        if (content !== undefined) refresh();
        return;
    }

    const pendingInvalidations = pendingCodeOutputSyntaxLoads.get(normalizedLanguage);
    if (pendingInvalidations !== undefined) {
        pendingInvalidations.add(refresh);
        requestPendingCodeOutputSyntaxLoad(normalizedLanguage);
        return;
    }

    const invalidations = new Set([refresh]);
    pendingCodeOutputSyntaxLoads.set(normalizedLanguage, invalidations);
    requestPendingCodeOutputSyntaxLoad(normalizedLanguage);
}

function requestPendingCodeOutputSyntaxLoad(language: string): void {
    if (activeCodeOutputSyntaxLoads.has(language)) {
        return;
    }

    const invalidations = pendingCodeOutputSyntaxLoads.get(language);
    if (invalidations === undefined) {
        return;
    }

    const loaded = getLoadedSyntaxHighlighterForLanguage(language);
    if (loaded !== undefined) {
        pendingCodeOutputSyntaxLoads.delete(language);

        for (const invalidate of invalidations) {
            invalidate();
        }

        return;
    }

    const loading = loadSyntaxLanguageIfReady(language);
    activeCodeOutputSyntaxLoads.set(language, loading);
    void loading
        .then((loaded) => {
            if (loaded && pendingCodeOutputSyntaxLoads.get(language) === invalidations) {
                pendingCodeOutputSyntaxLoads.delete(language);

                for (const invalidatePendingPreview of invalidations) {
                    invalidatePendingPreview();
                }
            }
        })
        .catch((cause: unknown) => {
            recordRenderError("syntax.language-load", cause);

            if (pendingCodeOutputSyntaxLoads.get(language) === invalidations)
                pendingCodeOutputSyntaxLoads.delete(language);
        })
        .finally(() => {
            if (activeCodeOutputSyntaxLoads.get(language) === loading)
                activeCodeOutputSyntaxLoads.delete(language);
        });
}

/** Detects small structured third-party output that is safe and useful to syntax-highlight. */
export function detectStructuredOutputLanguage(text: string | undefined): string | undefined {
    if (text === undefined || text.length > MAX_STRUCTURED_OUTPUT_DETECTION_CHARS) {
        return undefined;
    }

    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return undefined;
    }

    if (looksLikeJson(trimmed)) {
        return "json";
    }

    if (looksLikeXml(trimmed)) {
        return trimmed.startsWith("<html") || trimmed.includes("<body") ? "html" : "xml";
    }

    if (looksLikeShellSnippet(trimmed)) {
        return "bash";
    }

    return undefined;
}

function looksLikeJson(text: string): boolean {
    if (
        !(
            (text.startsWith("{") && text.endsWith("}")) ||
            (text.startsWith("[") && text.endsWith("]"))
        )
    ) {
        return false;
    }

    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

function looksLikeXml(text: string): boolean {
    return /^<\??[A-Za-z][\s\S]*>$/.test(text) && /<\/?[A-Za-z][^>]*>/.test(text);
}

function looksLikeShellSnippet(text: string): boolean {
    const firstLine = text.split("\n", 1)[0] ?? "";
    return /^\s*(?:[$#]\s+)?(?:npm|pnpm|yarn|bun|node|python|python3|git|rg|grep|find|sed|awk|curl|mkdir|rm|cp|mv|cat|ls|cd)(?=$|[\t ]+(?![\t ]|ERR!(?:\s|$)|error\b))/u.test(
        firstLine,
    );
}
