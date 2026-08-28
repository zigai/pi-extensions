import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BundledLanguage, Highlighter } from "shiki";
import { tokensToAnsiLines } from "./ansi.ts";
import { configureBracketPairColoring } from "./brackets.ts";
import {
    isBundledSyntaxLanguage,
    normalizeSyntaxLanguage,
    PRELOADED_SYNTAX_LANGUAGES,
} from "./language.ts";
import {
    detectProjectSyntaxLanguages,
    type ProjectLanguageDetectionResult,
} from "./project-language-detection.ts";
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
const TOKENIZE_MAX_LINE_LENGTH = MAX_LINE_LENGTH;
const CACHE_LIMIT = 100;

export type SyntaxHighlightOptions = {
    readonly cache?: boolean | undefined;
};

export type SyntaxHighlightCacheStats = {
    readonly entries: number;
    readonly bytes: number;
};

export type SyntaxHighlighterDiagnostics = {
    readonly status: SyntaxStateStatus;
    readonly cacheEntries: number;
    readonly cacheBytes: number;
    readonly configuredPreloadLanguages?: readonly string[];
    readonly preloadLanguages?: readonly string[];
    readonly ignoredPreloadLanguages?: readonly string[];
    readonly projectLanguageDetectionEnabled?: boolean;
    readonly projectLanguageDetectionCwd?: string;
    readonly projectLanguageDetectionScannedFiles?: number;
    readonly projectLanguageDetectionScannedDirectories?: number;
    readonly projectLanguageDetectionReadErrors?: number;
    readonly projectLanguageDetectionStoppedReason?: string;
    readonly detectedProjectLanguages?: readonly string[];
    readonly loadedLanguages?: readonly string[];
    readonly dynamicLanguages?: readonly string[];
};

type SyntaxStateStatus = "disabled" | "failed" | "ready" | "uninitialized";
type SyntaxStateListener = (status: SyntaxStateStatus) => void;

type SyntaxWarningReporter = (message: string) => void;

type SyntaxProjectLanguageDetectionOptions = {
    readonly enabled: boolean;
    readonly cwd?: string;
};

type SyntaxProjectLanguageDetectionDiagnostics = {
    readonly cwd: string;
    readonly result: ProjectLanguageDetectionResult;
};

type SyntaxPreloadDiagnostics = {
    readonly configuredLanguages: readonly string[];
    readonly preloadLanguages: readonly BundledLanguage[];
    readonly ignoredConfiguredLanguages: readonly string[];
    readonly projectDetectionEnabled: boolean;
    readonly projectDetection?: SyntaxProjectLanguageDetectionDiagnostics;
};

type SyntaxPreloadSelection = {
    readonly languages: readonly BundledLanguage[];
    readonly diagnostics: SyntaxPreloadDiagnostics;
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
          readonly dynamicLanguages: Set<string>;
      };

let syntaxState: SyntaxState | undefined;
let initializationPromise: Promise<SyntaxState> | undefined;
let syntaxGeneration = 0;
let syntaxPreloadDiagnostics: SyntaxPreloadDiagnostics | undefined;
const highlightedCodeCache = new Map<
    string,
    { readonly lines: string[]; readonly bytes: number }
>();
let highlightedCodeCacheBytes = 0;
const syntaxStateListeners = new Set<SyntaxStateListener>();
let syntaxRenderingVersion = 0;
let activeConfigurationKey: string | undefined;

export type SyntaxHighlighterFactory = typeof import("shiki").createHighlighter;

export type SyntaxInitializationOptions = {
    readonly createHighlighter?: SyntaxHighlighterFactory;
    readonly preloadLanguages?: readonly string[];
    readonly projectLanguageDetection?: SyntaxProjectLanguageDetectionOptions;
    readonly reportWarning?: SyntaxWarningReporter;
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
    initializationPromise = Promise.all([
        syntaxConfigurationKey(env, options),
        initializeSyntaxHighlightingOnce(env, options),
    ]).then(([configurationKey, state]) => {
        if (generation !== syntaxGeneration) {
            disposeReadySyntaxState(state);
            return disposedSyntaxState(state.config);
        }
        syntaxState = state;
        activeConfigurationKey = configurationKey;
        syntaxRenderingVersion += 1;
        notifySyntaxStateListeners(state.status);
        return state;
    });
    return initializationPromise;
}

/** Builds and atomically swaps the central highlighter while the current one remains usable. */
export async function reinitializeSyntaxHighlighting(
    env: NodeJS.ProcessEnv = process.env,
    options: SyntaxInitializationOptions = {},
): Promise<SyntaxState> {
    const generation = syntaxGeneration + 1;
    syntaxGeneration = generation;
    const previousState = syntaxState;
    const replacement = Promise.all([
        syntaxConfigurationKey(env, options),
        initializeSyntaxHighlightingOnce(env, options),
    ]).then(([configurationKey, state]) => {
        if (generation !== syntaxGeneration) {
            disposeReadySyntaxState(state);
            return disposedSyntaxState(state.config);
        }
        clearSyntaxHighlightCache();
        syntaxState = state;
        activeConfigurationKey = configurationKey;
        disposeReadySyntaxState(previousState);
        syntaxRenderingVersion += 1;
        notifySyntaxStateListeners(state.status);
        return state;
    });
    initializationPromise = replacement;
    return replacement;
}

/** Rebuilds syntax state only when environment, theme contents, or preload inputs changed. */
export function refreshSyntaxHighlighting(
    env: NodeJS.ProcessEnv = process.env,
    options: SyntaxInitializationOptions = {},
): Promise<SyntaxState> {
    const refresh = refreshSyntaxHighlightingOnce(env, options);
    initializationPromise = refresh;
    return refresh;
}

async function refreshSyntaxHighlightingOnce(
    env: NodeJS.ProcessEnv,
    options: SyntaxInitializationOptions,
): Promise<SyntaxState> {
    const configurationKey = await syntaxConfigurationKey(env, options);
    if (syntaxState !== undefined && activeConfigurationKey === configurationKey) {
        return syntaxState;
    }
    return reinitializeSyntaxHighlighting(env, options);
}

/** Returns true when syntax highlighting is available for synchronous render calls. */
export function isSyntaxHighlightingReady(): boolean {
    return syntaxState?.status === "ready";
}

/** Returns a monotonic version for render caches that embed syntax colors. */
export function syntaxHighlightingVersion(): number {
    return syntaxRenderingVersion;
}

/** Updates bracket-pair coloring and invalidates syntax-bearing render caches when it changes. */
export function configureSyntaxBracketPairColoring(enabled: boolean): void {
    if (!configureBracketPairColoring(enabled)) {
        return;
    }
    clearSyntaxHighlightCache();
    syntaxRenderingVersion += 1;
}

/** Subscribes to central highlighter state changes for render-cache invalidation. */
export function onSyntaxHighlightingStateChange(listener: SyntaxStateListener): () => void {
    syntaxStateListeners.add(listener);
    return () => syntaxStateListeners.delete(listener);
}

/** Highlights code synchronously for render-time callers, falling back to plain lines when unavailable. */
export function highlightSyntaxCode(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions = {},
): string[] {
    const state = syntaxState;
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    if (
        state?.status !== "ready" ||
        normalizedLanguage === undefined ||
        normalizedLanguage === "text" ||
        !state.loadedLanguages.has(normalizedLanguage)
    ) {
        return splitCodeLines(code);
    }

    const codeByteLength = Buffer.byteLength(code, "utf8");
    if (codeByteLength > MAX_CODE_BYTES) {
        return splitCodeLines(code);
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

    const plainLines = splitCodeLines(code);
    if (plainLines.some((line) => line.length > MAX_LINE_LENGTH)) {
        return plainLines;
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
        state.dynamicLanguages.add(normalizedLanguage);
        notifySyntaxStateListeners(state.status);
    }

    return {
        highlighter: state.highlighter,
        themeName: state.theme.name,
        language: normalizedLanguage,
    };
}

/** Loads an additional bundled language only when the central highlighter is already ready. */
export async function loadSyntaxLanguageIfReady(language: string | undefined): Promise<boolean> {
    const generation = syntaxGeneration;
    const state = syntaxState;
    if (state?.status !== "ready") {
        return false;
    }

    const normalizedLanguage = normalizeSyntaxLanguage(language) ?? "text";
    if (normalizedLanguage === "text") {
        return true;
    }
    if (state.loadedLanguages.has(normalizedLanguage)) {
        return true;
    }
    if (!isBundledSyntaxLanguage(normalizedLanguage)) {
        return false;
    }

    await state.highlighter.loadLanguage(normalizedLanguage);
    if (generation !== syntaxGeneration || syntaxState !== state) {
        return false;
    }
    state.loadedLanguages.add(normalizedLanguage);
    state.dynamicLanguages.add(normalizedLanguage);
    notifySyntaxStateListeners(state.status);
    return true;
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

/** Returns syntax highlighter diagnostics for debug logging. */
export function syntaxHighlighterDiagnostics(): SyntaxHighlighterDiagnostics {
    const state = syntaxState;
    const diagnostics = syntaxPreloadDiagnostics;
    return {
        status: state?.status ?? "uninitialized",
        cacheEntries: highlightedCodeCache.size,
        cacheBytes: highlightedCodeCacheBytes,
        ...(diagnostics === undefined
            ? {}
            : {
                  configuredPreloadLanguages: diagnostics.configuredLanguages,
                  preloadLanguages: diagnostics.preloadLanguages,
                  ignoredPreloadLanguages: diagnostics.ignoredConfiguredLanguages,
                  projectLanguageDetectionEnabled: diagnostics.projectDetectionEnabled,
              }),
        ...(diagnostics?.projectDetection === undefined
            ? {}
            : {
                  projectLanguageDetectionCwd: diagnostics.projectDetection.cwd,
                  projectLanguageDetectionScannedFiles:
                      diagnostics.projectDetection.result.scannedFiles,
                  projectLanguageDetectionScannedDirectories:
                      diagnostics.projectDetection.result.scannedDirectories,
                  projectLanguageDetectionReadErrors:
                      diagnostics.projectDetection.result.readErrors,
                  detectedProjectLanguages: diagnostics.projectDetection.result.languages,
                  ...(diagnostics.projectDetection.result.stoppedReason === undefined
                      ? {}
                      : {
                            projectLanguageDetectionStoppedReason:
                                diagnostics.projectDetection.result.stoppedReason,
                        }),
              }),
        ...(state?.status === "ready"
            ? {
                  loadedLanguages: [...state.loadedLanguages].sort(),
                  dynamicLanguages: [...state.dynamicLanguages].sort(),
              }
            : {}),
    };
}

/** Disposes the central highlighter and resets syntax state for reloads or shutdown. */
export async function disposeSyntaxHighlighting(): Promise<void> {
    clearSyntaxHighlightCache();
    syntaxGeneration += 1;

    const state = syntaxState;
    syntaxState = undefined;
    initializationPromise = undefined;
    syntaxPreloadDiagnostics = undefined;
    activeConfigurationKey = undefined;

    disposeReadySyntaxState(state);
    syntaxRenderingVersion += 1;
    notifySyntaxStateListeners("uninitialized");
}

async function syntaxConfigurationKey(
    env: NodeJS.ProcessEnv,
    options: SyntaxInitializationOptions,
): Promise<string> {
    const config = loadSyntaxConfig(env);
    let themeContents = "";
    if (config.enabled) {
        try {
            themeContents = await readFile(config.themePath, "utf8");
        } catch (cause: unknown) {
            themeContents =
                cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause);
        }
    }
    return createHash("sha256")
        .update(
            JSON.stringify({
                config,
                themeContents,
                preloadLanguages: options.preloadLanguages ?? null,
                projectLanguageDetection: options.projectLanguageDetection ?? null,
            }),
        )
        .digest("hex");
}

function notifySyntaxStateListeners(status: SyntaxStateStatus): void {
    for (const listener of syntaxStateListeners) {
        listener(status);
    }
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
    options: SyntaxInitializationOptions,
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

        const preloadSelection = selectSyntaxPreloadLanguages(options);
        syntaxPreloadDiagnostics = preloadSelection.diagnostics;

        const createSyntaxHighlighter =
            options.createHighlighter ?? (await import("shiki")).createHighlighter;
        const highlighter = await createSyntaxHighlighter({
            themes: [theme.registration],
            langs: [...preloadSelection.languages],
        });

        return {
            status: "ready",
            config,
            theme,
            highlighter,
            loadedLanguages: new Set(highlighter.getLoadedLanguages()),
            dynamicLanguages: new Set(),
        };
    } catch (cause: unknown) {
        return {
            status: "failed",
            config,
            reason: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

function selectSyntaxPreloadLanguages(
    options: SyntaxInitializationOptions,
): SyntaxPreloadSelection {
    const configuredLanguages = [...(options.preloadLanguages ?? PRELOADED_SYNTAX_LANGUAGES)];
    const ignoredConfiguredLanguages: string[] = [];
    const preloadLanguages = new Set<BundledLanguage>();

    for (const configuredLanguage of configuredLanguages) {
        const normalizedLanguage = normalizeSyntaxLanguage(configuredLanguage);
        if (normalizedLanguage === undefined || normalizedLanguage === "text") {
            ignoredConfiguredLanguages.push(configuredLanguage);
            options.reportWarning?.(
                `[pi-glowup] Ignoring unknown syntax preload language ${formatConfiguredLanguageForWarning(configuredLanguage)}`,
            );
            continue;
        }
        preloadLanguages.add(normalizedLanguage);
    }

    const projectDetectionEnabled = options.projectLanguageDetection?.enabled === true;
    const projectDetectionCwd = options.projectLanguageDetection?.cwd;
    const projectDetection =
        projectDetectionEnabled &&
        projectDetectionCwd !== undefined &&
        projectDetectionCwd.length > 0
            ? {
                  cwd: projectDetectionCwd,
                  result: detectProjectSyntaxLanguages(projectDetectionCwd),
              }
            : undefined;

    if (projectDetection !== undefined) {
        for (const language of projectDetection.result.languages) {
            preloadLanguages.add(language);
        }
    }

    return {
        languages: [...preloadLanguages],
        diagnostics: {
            configuredLanguages,
            preloadLanguages: [...preloadLanguages],
            ignoredConfiguredLanguages,
            projectDetectionEnabled,
            ...(projectDetection === undefined ? {} : { projectDetection }),
        },
    };
}

function formatConfiguredLanguageForWarning(language: string): string {
    const trimmed = language.trim();
    const displayed = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    return JSON.stringify(displayed) ?? '""';
}

function splitCodeLines(code: string): string[] {
    const normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
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
