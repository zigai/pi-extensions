import { createHash } from "node:crypto";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import { tokensToAnsiLines } from "./ansi.ts";
import {
    isBundledSyntaxLanguage,
    normalizeSyntaxLanguage,
    PRELOADED_SYNTAX_LANGUAGES,
} from "./language.ts";
import {
    loadSyntaxConfig,
    loadSyntaxTheme,
    type LoadedSyntaxTheme,
    type SyntaxConfig,
} from "./theme-loader.ts";

const MAX_CODE_BYTES = 40 * 1024;
const MAX_CACHEABLE_CODE_BYTES = 8 * 1024;
const MAX_CACHE_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 2_000;
const TOKENIZE_MAX_LINE_LENGTH = 1_000;
const CACHE_LIMIT = 100;

export type SyntaxHighlightOptions = {
    readonly cache?: boolean | undefined;
};

export type SyntaxHighlightCacheStats = {
    readonly entries: number;
    readonly bytes: number;
};

type SyntaxState =
    | {
          readonly status: "disabled";
          readonly config: SyntaxConfig;
          readonly reason: string;
      }
    | {
          readonly status: "failed";
          readonly config: SyntaxConfig;
          readonly reason: string;
      }
    | {
          readonly status: "ready";
          readonly config: SyntaxConfig;
          readonly theme: LoadedSyntaxTheme;
          readonly highlighter: Highlighter;
          readonly loadedLanguages: Set<string>;
      };

let syntaxState: SyntaxState | undefined;
let initializationPromise: Promise<SyntaxState> | undefined;
let syntaxGeneration = 0;
const highlightedCodeCache = new Map<
    string,
    { readonly lines: string[]; readonly bytes: number }
>();
let highlightedCodeCacheBytes = 0;

export type SyntaxHighlighterFactory = typeof createHighlighter;

export type SyntaxInitializationOptions = {
    readonly createHighlighter?: SyntaxHighlighterFactory;
};

/** Initializes the central Shiki highlighter once during extension startup. */
export async function initializeSyntaxHighlighting(
    env: NodeJS.ProcessEnv = process.env,
    options: SyntaxInitializationOptions = {},
): Promise<SyntaxState> {
    if (initializationPromise) {
        return initializationPromise;
    }

    const generation = syntaxGeneration;
    const createSyntaxHighlighter = options.createHighlighter ?? createHighlighter;
    initializationPromise = initializeSyntaxHighlightingOnce(env, createSyntaxHighlighter).then(
        (state) => {
            if (generation !== syntaxGeneration) {
                disposeReadySyntaxState(state);
                return disposedSyntaxState(state.config);
            }
            syntaxState = state;
            return state;
        },
    );
    return initializationPromise;
}

/** Returns true when syntax highlighting is available for synchronous render calls. */
export function isSyntaxHighlightingReady(): boolean {
    return syntaxState?.status === "ready";
}

/** Highlights code synchronously for render-time callers, falling back to plain lines when unavailable. */
export function highlightSyntaxCode(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions = {},
): string[] {
    const plainLines = splitCodeLines(code);
    const state = syntaxState;
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    const codeByteLength = Buffer.byteLength(code, "utf8");
    if (
        state?.status !== "ready" ||
        normalizedLanguage === undefined ||
        normalizedLanguage === "text" ||
        exceedsHighlightLimits(codeByteLength, plainLines) ||
        !state.loadedLanguages.has(normalizedLanguage)
    ) {
        return plainLines;
    }

    const shouldCache = options.cache !== false && codeByteLength <= MAX_CACHEABLE_CODE_BYTES;
    const cacheKey = shouldCache
        ? highlightedCodeCacheKey(state.theme.name, normalizedLanguage, code, codeByteLength)
        : undefined;
    if (cacheKey !== undefined) {
        const cached = highlightedCodeCache.get(cacheKey);
        if (cached) {
            return cached.lines;
        }
    }

    try {
        const tokenRows = state.highlighter.codeToTokensBase(code, {
            lang: normalizedLanguage,
            theme: state.theme.registration,
            tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
        });
        const highlighted = normalizeHighlightedLineCount(
            tokensToAnsiLines(tokenRows, normalizedLanguage),
            plainLines.length,
        );
        if (cacheKey !== undefined) {
            rememberHighlightedCode(cacheKey, highlighted);
        }
        return highlighted;
    } catch {
        return plainLines;
    }
}

export type LoadedSyntaxHighlighter = {
    readonly highlighter: Highlighter;
    readonly themeName: string;
    readonly language: BundledLanguage | "text";
};

/** Returns the initialized Shiki highlighter only when the language is already loaded. */
export function getLoadedSyntaxHighlighterForLanguage(
    language: string | undefined,
): LoadedSyntaxHighlighter | undefined {
    const state = syntaxState;
    if (state?.status !== "ready") {
        return undefined;
    }

    const normalizedLanguage = normalizeSyntaxLanguage(language) ?? "text";
    if (normalizedLanguage !== "text" && !state.loadedLanguages.has(normalizedLanguage)) {
        return undefined;
    }

    return {
        highlighter: state.highlighter,
        themeName: state.theme.name,
        language: normalizedLanguage,
    };
}

/** Returns the initialized Shiki highlighter after ensuring a language is loaded for async callers. */
export async function getSyntaxHighlighterForLanguage(
    language: string | undefined,
): Promise<LoadedSyntaxHighlighter | undefined> {
    const generation = syntaxGeneration;
    const loaded = getLoadedSyntaxHighlighterForLanguage(language);
    if (loaded) {
        return loaded;
    }

    const state = syntaxState ?? (await initializeSyntaxHighlighting());
    if (generation !== syntaxGeneration || state.status !== "ready") {
        return undefined;
    }

    const normalizedLanguage = normalizeSyntaxLanguage(language) ?? "text";
    if (normalizedLanguage !== "text" && !state.loadedLanguages.has(normalizedLanguage)) {
        if (!isBundledSyntaxLanguage(normalizedLanguage)) {
            return undefined;
        }
        await state.highlighter.loadLanguage(normalizedLanguage);
        if (generation !== syntaxGeneration) {
            return undefined;
        }
        state.loadedLanguages.add(normalizedLanguage);
    }

    return {
        highlighter: state.highlighter,
        themeName: state.theme.name,
        language: normalizedLanguage,
    };
}

export function currentSyntaxThemeName(): string | undefined {
    return syntaxState?.status === "ready" ? syntaxState.theme.name : undefined;
}

export function clearSyntaxHighlightCache(): void {
    highlightedCodeCache.clear();
    highlightedCodeCacheBytes = 0;
}

/** Returns bounded syntax-highlight cache usage for tests and diagnostics. */
export function syntaxHighlightCacheStats(): SyntaxHighlightCacheStats {
    return {
        entries: highlightedCodeCache.size,
        bytes: highlightedCodeCacheBytes,
    };
}

/** Disposes the central highlighter and resets syntax state for reloads or shutdown. */
export async function disposeSyntaxHighlighting(): Promise<void> {
    clearSyntaxHighlightCache();
    syntaxGeneration += 1;

    const state = syntaxState;
    syntaxState = undefined;
    initializationPromise = undefined;

    disposeReadySyntaxState(state);
}

function disposeReadySyntaxState(state: SyntaxState | undefined): void {
    if (state?.status === "ready") {
        state.highlighter.dispose();
    }
}

function disposedSyntaxState(config: SyntaxConfig): SyntaxState {
    return { status: "disabled", config, reason: "disposed" };
}

async function initializeSyntaxHighlightingOnce(
    env: NodeJS.ProcessEnv,
    createSyntaxHighlighter: SyntaxHighlighterFactory,
): Promise<SyntaxState> {
    const config = loadSyntaxConfig(env);
    if (!config.enabled) {
        return { status: "disabled", config, reason: config.reason };
    }

    try {
        const theme = await loadSyntaxTheme(config);
        if (!theme) {
            return { status: "disabled", config, reason: "syntax theme disabled" };
        }

        const highlighter = await createSyntaxHighlighter({
            themes: [theme.registration],
            langs: [...PRELOADED_SYNTAX_LANGUAGES],
        });

        return {
            status: "ready",
            config,
            theme,
            highlighter,
            loadedLanguages: new Set(highlighter.getLoadedLanguages()),
        };
    } catch (cause: unknown) {
        return {
            status: "failed",
            config,
            reason: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

function splitCodeLines(code: string): string[] {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function exceedsHighlightLimits(codeByteLength: number, lines: ReadonlyArray<string>): boolean {
    if (codeByteLength > MAX_CODE_BYTES) {
        return true;
    }
    return lines.some((line) => line.length > MAX_LINE_LENGTH);
}

function normalizeHighlightedLineCount(lines: string[], expectedCount: number): string[] {
    if (lines.length === expectedCount) {
        return lines;
    }
    if (lines.length > expectedCount) {
        return lines.slice(0, expectedCount);
    }
    return [...lines, ...Array.from({ length: expectedCount - lines.length }, () => "")];
}

function highlightedCodeCacheKey(
    themeName: string,
    language: string,
    code: string,
    codeByteLength: number,
): string {
    const digest = createHash("sha256").update(code).digest("base64url");
    return `${themeName}\0${language}\0${codeByteLength}\0${digest}`;
}

function cachedLineBytes(lines: ReadonlyArray<string>): number {
    let bytes = 0;
    for (const line of lines) {
        bytes += Buffer.byteLength(line, "utf8");
    }
    return bytes;
}

function deleteOldestHighlightedCode(): boolean {
    const oldestKey = highlightedCodeCache.keys().next().value;
    if (oldestKey === undefined) {
        return false;
    }
    const oldest = highlightedCodeCache.get(oldestKey);
    if (oldest !== undefined) {
        highlightedCodeCacheBytes = Math.max(0, highlightedCodeCacheBytes - oldest.bytes);
    }
    highlightedCodeCache.delete(oldestKey);
    return true;
}

function rememberHighlightedCode(cacheKey: string, lines: string[]): void {
    const bytes = cachedLineBytes(lines);
    if (bytes > MAX_CACHE_BYTES) {
        return;
    }
    while (
        highlightedCodeCache.size >= CACHE_LIMIT ||
        highlightedCodeCacheBytes + bytes > MAX_CACHE_BYTES
    ) {
        if (!deleteOldestHighlightedCode()) {
            break;
        }
    }
    highlightedCodeCache.set(cacheKey, { lines, bytes });
    highlightedCodeCacheBytes += bytes;
}
