import { normalizeSyntaxLanguage, syntaxLanguageFromFile } from "./language.ts";
import {
    getLoadedSyntaxHighlighterForLanguage,
    highlightSyntaxCode,
    loadSyntaxLanguageIfReady,
    onSyntaxHighlightingStateChange,
} from "./highlighter.ts";

export type CodeOutputSyntax = {
    readonly language?: string;
    readonly path?: string;
    readonly cache?: boolean | undefined;
};

const MAX_STRUCTURED_OUTPUT_DETECTION_CHARS = 64 * 1024;
const pendingCodeOutputSyntaxLoads = new Map<string, Set<() => void>>();
const activeCodeOutputSyntaxLoads = new Set<string>();

onSyntaxHighlightingStateChange((status) => {
    if (status === "ready") {
        for (const language of pendingCodeOutputSyntaxLoads.keys()) {
            requestPendingCodeOutputSyntaxLoad(language);
        }

        return;
    }

    if (status === "disabled" || status === "failed") {
        pendingCodeOutputSyntaxLoads.clear();
        activeCodeOutputSyntaxLoads.clear();
    }
});

/** Highlights code-like output when a language or path is known; otherwise returns normalized plain lines. */
export function highlightCodeOutput(text: string, syntax: CodeOutputSyntax | undefined): string[] {
    const language = syntax?.language ?? syntaxLanguageFromFile(syntax?.path, text);
    return highlightSyntaxCode(text, language, { cache: syntax?.cache });
}

/** Schedules async loading for path/language hints so later sync renders can highlight them. */
export function scheduleCodeOutputSyntaxLoad(
    syntax: CodeOutputSyntax | undefined,
    invalidate: (() => void) | undefined,
    content?: string,
): void {
    if (invalidate === undefined) {
        return;
    }

    const language = syntax?.language ?? syntaxLanguageFromFile(syntax?.path, content);
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    if (normalizedLanguage === undefined || normalizedLanguage === "text") {
        return;
    }

    if (getLoadedSyntaxHighlighterForLanguage(normalizedLanguage) !== undefined) {
        return;
    }

    const pendingInvalidations = pendingCodeOutputSyntaxLoads.get(normalizedLanguage);
    if (pendingInvalidations !== undefined) {
        pendingInvalidations.add(invalidate);
        requestPendingCodeOutputSyntaxLoad(normalizedLanguage);
        return;
    }

    const invalidations = new Set([invalidate]);
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

    activeCodeOutputSyntaxLoads.add(language);
    void loadSyntaxLanguageIfReady(language)
        .then((loaded) => {
            if (loaded) {
                pendingCodeOutputSyntaxLoads.delete(language);

                for (const invalidatePendingPreview of invalidations) {
                    invalidatePendingPreview();
                }
            }
        })
        .catch(() => {
            pendingCodeOutputSyntaxLoads.delete(language);
        })
        .finally(() => {
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
    return /^\s*(?:[$#]\s+)?(?:npm|pnpm|yarn|bun|node|python|python3|git|rg|grep|find|sed|awk|curl|mkdir|rm|cp|mv|cat|ls|cd)\b/u.test(
        firstLine,
    );
}
