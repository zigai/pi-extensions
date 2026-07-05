import { syntaxLanguageFromPath } from "./language.ts";
import { highlightSyntaxCode } from "./highlighter.ts";

export type CodeOutputSyntax = {
    readonly language?: string;
    readonly path?: string;
    readonly cache?: boolean | undefined;
};

const MAX_STRUCTURED_OUTPUT_DETECTION_CHARS = 64 * 1024;

/** Highlights code-like output when a language or path is known; otherwise returns normalized plain lines. */
export function highlightCodeOutput(text: string, syntax: CodeOutputSyntax | undefined): string[] {
    const language = syntax?.language ?? syntaxLanguageFromPath(syntax?.path);
    return highlightSyntaxCode(text, language, { cache: syntax?.cache });
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
