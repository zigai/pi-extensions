import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import type { CreateHighlighterFactory, HighlighterGeneric } from "shiki";
import { normalizedCodeLines } from "../../text-boundaries.ts";
import type { DiffSection } from "../diff/text-diff.ts";
import { createSyntaxTokenizer, type TokenizeUnavailableReason } from "./tokenizer.ts";
import {
    diagnosticCodeHash,
    recordRenderError,
    recordRenderEvent,
    renderDiagnosticsEnabled,
    utf8Bytes,
} from "../../diagnostics/render-events.ts";
import {
    beginHighlightRequest,
    bindHighlightJob,
    cancelHighlightRequests,
    createHighlightJob,
    failHighlightReadiness,
    finishHighlightJob,
    highlightJobState,
    joinHighlightJob,
    observedHighlightJob,
    observeHighlightRevision,
    transitionHighlightRequest,
    useHighlightRequest,
    type HighlightRequest,
} from "../../diagnostics/highlight-requests.ts";
import { configureBracketPairColoring } from "./brackets.ts";
import {
    isLoadableSyntaxLanguage,
    normalizeSyntaxLanguage,
    syntaxLanguageInput,
    type SyntaxLanguage,
    PRELOADED_SYNTAX_LANGUAGES,
} from "./language.ts";
import {
    detectProjectSyntaxLanguages,
    type ProjectLanguageDetectionResult,
} from "./project-language-detection.ts";
import {
    loadSyntaxConfig,
    parseSyntaxTheme,
    type LoadedSyntaxTheme,
    type SyntaxConfig,
} from "./theme-loader.ts";

const MAX_CACHEABLE_CODE_BYTES = 8 * 1024;
const MAX_CACHE_BYTES = 512 * 1024;
const CACHE_LIMIT = 100;

export type SyntaxHighlightOptions = {
    readonly cache?: boolean | undefined;
    readonly invalidate?: (() => void) | undefined;
    readonly signal?: AbortSignal;
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
    readonly preloadLanguages: readonly SyntaxLanguage[];
    readonly ignoredConfiguredLanguages: readonly string[];
    readonly projectDetectionEnabled: boolean;
    readonly projectDetection?: SyntaxProjectLanguageDetectionDiagnostics;
};

type SyntaxPreloadSelection = {
    readonly languages: readonly SyntaxLanguage[];
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
          readonly highlighter: HighlighterGeneric<string, string>;
          readonly tokenizer: ReturnType<typeof createSyntaxTokenizer>;
          readonly loadedLanguages: Set<string>;
          readonly dynamicLanguages: Set<string>;
      };

let syntaxState: SyntaxState | undefined;
let pythonTokenizer: ReturnType<typeof createSyntaxTokenizer> | undefined;
let initializationPromise: Promise<SyntaxState> | undefined;
let syntaxGeneration = 0;
let syntaxPreloadDiagnostics: SyntaxPreloadDiagnostics | undefined;
const highlightedCodeCache = new Map<
    string,
    { readonly lines: string[]; readonly bytes: number }
>();

type HighlightedSource = {
    readonly source: string;
    readonly language: string;
    readonly themeName: string;
    readonly lines: string[];
};

type HighlightOwner = {
    readonly source: string | readonly DiffSection[];
    readonly controller: AbortController;
    readonly results: Map<string, HighlightedSource>;
    previousResults: ReadonlyMap<string, HighlightedSource>;
    version: number;
    readonly retryWhenCapacityAvailable: () => void;
    readonly retryWhenReady: (language: SyntaxLanguage) => void;
    readonly readyRequests: Map<SyntaxLanguage, Map<string | undefined, SyntaxHighlightOptions>>;
    readonly capacityRequests: Map<
        string,
        {
            readonly code: string;
            readonly language: string | undefined;
            readonly options: SyntaxHighlightOptions;
            readonly version: number;
        }
    >;
    readonly pending: Map<string, Promise<string[]>>;
};

let bracketPairColoringEnabled = true;
let highlightOwners = new WeakMap<() => void, HighlightOwner>();
const pendingHighlights = new Map<string, Promise<string[]>>();
const highlightControllers = new Set<AbortController>();
const tokenizerDisposals = new Set<Promise<void>>();
const highlightCompletionListeners = new Set<() => void>();
const activeHighlights = new Set<Promise<unknown>>();
const completedUnownedHighlights = new Map<string, WeakRef<string[]>>();
const readinessRetries = new Map<
    SyntaxLanguage,
    Set<WeakRef<(language: SyntaxLanguage) => void>>
>();
const registeredReadinessRetries = new Map<
    SyntaxLanguage,
    WeakSet<(language: SyntaxLanguage) => void>
>();
const languageLoads = new Map<SyntaxLanguage, Promise<boolean>>();

let highlightedCodeCacheBytes = 0;
const syntaxStateListeners = new Set<SyntaxStateListener>();

let syntaxRenderingVersion = 0;
let activeConfigurationKey: string | undefined;

export type SyntaxHighlighterFactory = CreateHighlighterFactory<string, string>;

/** Creates the shared owner of bundled and externally registered language/theme names. */
export const createSyntaxHighlighter: SyntaxHighlighterFactory = async (options) => {
    const { createBundledHighlighter, bundledLanguages, bundledThemes, createOnigurumaEngine } =
        await import("shiki");

    // Shiki resolves bundled names and rejects missing names itself; registrations can
    // introduce arbitrary names used by synchronous tokenization (including Pierre).
    const createHighlighter = createBundledHighlighter<string, string>({
        langs: bundledLanguages,
        themes: bundledThemes,
        engine: async () => createOnigurumaEngine(import("shiki/wasm")),
    });
    return createHighlighter(options);
};

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

    initializationPromise = prepareSyntaxSource(env, options).then(async (source) => {
        const state = await initializeSyntaxHighlightingOnce(source, options);
        const configurationKey = source.configurationKey;

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
    return replaceSyntaxHighlighting(prepareSyntaxSource(env, options), options);
}

async function replaceSyntaxHighlighting(
    sourcePromise: Promise<SyntaxSource>,
    options: SyntaxInitializationOptions,
): Promise<SyntaxState> {
    const generation = syntaxGeneration + 1;
    syntaxGeneration = generation;

    const previousState = syntaxState;
    const replacement = sourcePromise.then(async (source) => {
        const state = await initializeSyntaxHighlightingOnce(source, options);
        const configurationKey = source.configurationKey;

        if (generation !== syntaxGeneration) {
            disposeReadySyntaxState(state);
            return disposedSyntaxState(state.config);
        }

        clearSyntaxColors("theme-replaced", previousState === undefined);
        languageLoads.clear();
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
export async function refreshSyntaxHighlighting(
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
    const generation = syntaxGeneration;
    const source = await prepareSyntaxSource(env, options);
    if (generation !== syntaxGeneration) {
        return disposedSyntaxState(source.config);
    }

    if (syntaxState !== undefined && activeConfigurationKey === source.configurationKey) {
        return syntaxState;
    }

    return replaceSyntaxHighlighting(Promise.resolve(source), options);
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

    bracketPairColoringEnabled = enabled;
    clearSyntaxHighlightCache();
    syntaxRenderingVersion += 1;
}

/** Subscribes to central highlighter state changes for render-cache invalidation. */
export function onSyntaxHighlightingStateChange(listener: SyntaxStateListener): () => void {
    syntaxStateListeners.add(listener);

    return () => {
        syntaxStateListeners.delete(listener);
    };
}

export function onSyntaxHighlightComplete(listener: () => void): () => void {
    highlightCompletionListeners.add(listener);

    return () => {
        highlightCompletionListeners.delete(listener);
    };
}

export async function settleSyntaxHighlights(): Promise<void> {
    while (activeHighlights.size > 0 || languageLoads.size > 0)
        await Promise.allSettled([...activeHighlights, ...languageLoads.values()]);
}

/** Returns completed colors, retaining unchanged prefixes while owned tokenization is pending. */
export function highlightSyntaxCode(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions = {},
): string[] {
    const state = syntaxState;
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    const invalidate = options.invalidate;
    if (invalidate !== undefined && !highlightOwners.has(invalidate))
        observeSyntaxHighlightSource(code, invalidate);
    const request = diagnoseHighlightRequest(code, normalizedLanguage, options, language);
    if (
        code.length === 0 ||
        state?.status !== "ready" ||
        normalizedLanguage === undefined ||
        normalizedLanguage === "text" ||
        !state.loadedLanguages.has(normalizedLanguage)
    ) {
        diagnoseUnhighlightedRequest(request, normalizedLanguage, options);
        recordUnhighlightedRequest(code, language, normalizedLanguage);
        if (code.length > 0 && options.signal?.aborted !== true)
            scheduleSyntaxLanguageLoad(language, invalidate, code, options);
        return normalizedCodeLines(code);
    }

    const codeByteLength = Buffer.byteLength(code, "utf8");
    const key = highlightedCodeCacheKey(state.theme.name, normalizedLanguage, code, codeByteLength);
    const owned = currentHighlightOwner(invalidate);
    const completed = owned?.results.get(key) ?? owned?.previousResults.get(key);
    if (completed !== undefined) {
        owned?.results.set(key, completed);
        useHighlightRequest(request, "cache");
        recordSyntaxHighlight(code, language, normalizedLanguage, "cached");
        return completed.lines;
    }

    const cached = options.cache === false ? undefined : highlightedCodeCache.get(key);
    if (cached !== undefined) {
        owned?.results.set(
            key,
            highlightedSource(code, normalizedLanguage, state.theme.name, cached.lines),
        );
        useHighlightRequest(request, "cache");
        recordSyntaxHighlight(code, language, normalizedLanguage, "cached");
        return cached.lines;
    }

    const unowned = completedUnownedHighlights.get(key)?.deref();
    if (unowned !== undefined && options.cache !== false) {
        owned?.results.set(
            key,
            highlightedSource(code, normalizedLanguage, state.theme.name, unowned),
        );
        useHighlightRequest(request, "cache");
        recordSyntaxHighlight(code, language, normalizedLanguage, "cached");
        return unowned;
    }

    void highlightSyntaxCodeAsyncObserved(code, normalizedLanguage, options, request);

    return pendingHighlightLines(code, normalizedLanguage, state.theme.name, owned);
}

/** Arranges a redraw once a requested grammar is available, without retaining the component. */
export function scheduleSyntaxLanguageLoad(
    language: string | undefined,
    invalidate: (() => void) | undefined,
    code?: string,
    options: SyntaxHighlightOptions = {},
): void {
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    if (normalizedLanguage === undefined || normalizedLanguage === "text") return;
    if (!isLoadableSyntaxLanguage(normalizedLanguage)) return;
    if (syntaxState?.status === "ready" && syntaxState.loadedLanguages.has(normalizedLanguage))
        return;

    if (invalidate !== undefined) {
        if (!highlightOwners.has(invalidate)) observeSyntaxHighlightSource("", invalidate);
        const owner = highlightOwners.get(invalidate);
        const retry = owner?.retryWhenReady;
        if (owner !== undefined && retry !== undefined) {
            let requests = owner.readyRequests.get(normalizedLanguage);
            if (requests === undefined) {
                requests = new Map();
                owner.readyRequests.set(normalizedLanguage, requests);
            }
            requests.set(code, options);
            let registered = registeredReadinessRetries.get(normalizedLanguage);
            if (registered === undefined) {
                registered = new WeakSet();
                registeredReadinessRetries.set(normalizedLanguage, registered);
            }
            if (!registered.has(retry)) {
                registered.add(retry);
                let retries = readinessRetries.get(normalizedLanguage);
                if (retries === undefined) {
                    retries = new Set();
                    readinessRetries.set(normalizedLanguage, retries);
                }
                retries.add(new WeakRef(retry));
            }
        }
    }

    if (syntaxState?.status === "ready") requestSyntaxLanguageLoad(normalizedLanguage);
}

function requestSyntaxLanguageLoad(language: SyntaxLanguage): void {
    if (languageLoads.has(language)) return;
    void loadSyntaxLanguageIfReady(language).catch((cause: unknown) => {
        recordRenderError("syntax.language-load", cause);
    });
}

function retryReadySyntaxLanguages(): void {
    const state = syntaxState;
    if (state?.status !== "ready") return;
    for (const [language, retries] of readinessRetries) {
        if (!state.loadedLanguages.has(language)) {
            requestSyntaxLanguageLoad(language);
            continue;
        }
        readinessRetries.delete(language);
        registeredReadinessRetries.delete(language);
        for (const reference of retries) reference.deref()?.(language);
    }
}

function notifySyntaxInvalidation(invalidate: () => void): void {
    try {
        invalidate();
    } catch (cause: unknown) {
        recordRenderError("syntax.invalidate", cause);
    }
}

function currentHighlightOwner(invalidate: (() => void) | undefined): HighlightOwner | undefined {
    if (invalidate === undefined) return undefined;
    const owner = highlightOwners.get(invalidate);
    if (owner !== undefined && owner.version !== syntaxRenderingVersion) {
        owner.results.clear();
        owner.previousResults = new Map();
        owner.pending.clear();
        owner.capacityRequests.clear();
        owner.version = syntaxRenderingVersion;
    }
    return owner;
}

/** Cancels obsolete work when a renderer observes a different submitted source. */
export function observeSyntaxHighlightSource(
    source: string | readonly DiffSection[],
    invalidate: () => void,
): () => boolean {
    const previous = currentHighlightOwner(invalidate);
    if (previous?.source === source) return () => highlightOwners.get(invalidate) === previous;

    observeHighlightRevision(invalidate);
    previous?.controller.abort();

    let previousResults: ReadonlyMap<string, HighlightedSource> = new Map();
    if (previous !== undefined) {
        if (previous.results.size > 0) {
            previousResults = new Map(previous.results);
        } else {
            previousResults = previous.previousResults;
        }
    }

    previous?.results.clear();

    const owner: HighlightOwner = {
        source,
        controller: new AbortController(),
        results: new Map(),
        previousResults,
        version: syntaxRenderingVersion,
        retryWhenCapacityAvailable: () => {
            // Capacity can return before the rejected request's promise has unwound.
            // Redrawing earlier would just reuse that doomed pending entry.
            const retry = Promise.allSettled(owner.pending.values())
                .then(() => {
                    if (
                        highlightOwners.get(invalidate) !== owner ||
                        owner.controller.signal.aborted
                    )
                        return;
                    const requests = [...owner.capacityRequests.values()];
                    owner.capacityRequests.clear();
                    let adopted = false;
                    for (const request of requests) {
                        if (request.version !== syntaxRenderingVersion) continue;
                        adopted =
                            retrySyntaxHighlight(request.code, request.language, request.options) ||
                            adopted;
                    }
                    if (adopted) notifySyntaxInvalidation(invalidate);
                })
                .finally(() => {
                    activeHighlights.delete(retry);
                });
            activeHighlights.add(retry);
        },
        capacityRequests: new Map(),
        readyRequests: new Map(),
        retryWhenReady: (language) => {
            if (highlightOwners.get(invalidate) !== owner || owner.controller.signal.aborted)
                return;
            const requests = owner.readyRequests.get(language);
            owner.readyRequests.delete(language);
            if (requests === undefined) return;
            let adopted = false;
            for (const [code, options] of requests) {
                if (options.signal?.aborted === true) continue;
                if (code === undefined) adopted = true;
                else
                    adopted =
                        retrySyntaxHighlight(code, language, { ...options, invalidate }) || adopted;
            }
            if (adopted) notifySyntaxInvalidation(invalidate);
        },
        pending: new Map(),
    };
    highlightOwners.set(invalidate, owner);

    return () => highlightOwners.get(invalidate) === owner;
}

// Worker completion already invalidates its owner. A retry can instead adopt an existing
// result synchronously, so its caller must invalidate any lines cached while work was pending.
function retrySyntaxHighlight(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions,
): boolean {
    const state = syntaxState;
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    const owner = currentHighlightOwner(options.invalidate);
    let key: string | undefined;
    if (state?.status === "ready" && normalizedLanguage !== undefined)
        key = highlightedCodeCacheKey(
            state.theme.name,
            normalizedLanguage,
            code,
            Buffer.byteLength(code, "utf8"),
        );
    let previous: HighlightedSource | undefined;
    if (key !== undefined) previous = owner?.results.get(key);
    void highlightSyntaxCodeAsync(code, language, options);
    let adopted: HighlightedSource | undefined;
    if (key !== undefined) adopted = owner?.results.get(key);
    const changed = adopted !== undefined && adopted !== previous;
    if (changed)
        useHighlightRequest(
            diagnoseHighlightRequest(code, normalizedLanguage, options),
            "invalidation",
        );
    return changed;
}

export async function compactPythonStructuralBlankRows(
    code: string,
    options: {
        readonly signal?: AbortSignal;
        readonly reportWarning?: SyntaxWarningReporter;
    } = {},
): Promise<string | undefined> {
    if (options.signal?.aborted === true) return undefined;
    if (!/\n[\t ]*\n/u.test(code)) return code;

    const generation = syntaxGeneration;

    pythonTokenizer ??= createSyntaxTokenizer(undefined, {
        maxJobs: CACHE_LIMIT,
        maxBytes: MAX_CACHE_BYTES,
        reportWarning: options.reportWarning,
        async waitForDisposals() {
            await Promise.all(tokenizerDisposals);
        },
    });

    const lines = await pythonTokenizer.compactPython(code, options);
    if (lines === undefined || generation !== syntaxGeneration) return undefined;

    return lines.join("\n");
}

/** Computes complete code colors off the TUI thread, preserving grammar state across all lines. */
export function highlightSyntaxCodeAsync(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions = {},
): Promise<string[]> {
    return highlightSyntaxCodeAsyncObserved(code, language, options);
}

async function highlightSyntaxCodeAsyncObserved(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions,
    observation?: HighlightRequest,
): Promise<string[]> {
    const state = syntaxState;
    const normalizedLanguage = normalizeSyntaxLanguage(language);
    const invalidate = options.invalidate;
    if (invalidate !== undefined && !highlightOwners.has(invalidate))
        observeSyntaxHighlightSource(code, invalidate);
    let request =
        observation ?? diagnoseHighlightRequest(code, normalizedLanguage, options, language);
    const plainLines = normalizedCodeLines(code);
    const size = Buffer.byteLength(code, "utf8");

    if (
        code.length === 0 ||
        state?.status !== "ready" ||
        normalizedLanguage === undefined ||
        normalizedLanguage === "text" ||
        !state.loadedLanguages.has(normalizedLanguage)
    ) {
        diagnoseUnhighlightedRequest(request, normalizedLanguage, options);
        recordUnhighlightedRequest(code, language, normalizedLanguage);
        if (code.length > 0 && options.signal?.aborted !== true)
            scheduleSyntaxLanguageLoad(language, invalidate, code, options);
        return plainLines;
    }

    if (options.signal?.aborted === true) {
        recordSyntaxHighlight(code, language, normalizedLanguage, "cancelled");
        return plainLines;
    }

    const key = highlightedCodeCacheKey(state.theme.name, normalizedLanguage, code, size);
    const shouldCache = options.cache !== false && size <= MAX_CACHEABLE_CODE_BYTES;
    const owner = currentHighlightOwner(invalidate);
    const ownedResult = owner?.results.get(key) ?? owner?.previousResults.get(key);
    if (ownedResult !== undefined) {
        owner?.results.set(key, ownedResult);
        useHighlightRequest(request, "cache");
        recordSyntaxHighlight(code, language, normalizedLanguage, "cached");
        return ownedResult.lines;
    }

    const cached = shouldCache ? highlightedCodeCache.get(key) : undefined;
    if (cached !== undefined) {
        owner?.results.set(
            key,
            highlightedSource(code, normalizedLanguage, state.theme.name, cached.lines),
        );
        useHighlightRequest(request, "cache");
        recordSyntaxHighlight(code, language, normalizedLanguage, "cached");
        return cached.lines;
    }

    const generation = syntaxRenderingVersion;
    const controller = new AbortController();
    const signals = [controller.signal];
    if (owner !== undefined) signals.push(owner.controller.signal);
    if (options.signal !== undefined) signals.push(options.signal);

    const signal = AbortSignal.any(signals);
    const pendingKey = owner === undefined && options.signal === undefined ? key : undefined;
    let pending =
        owner?.pending.get(key) ??
        (pendingKey === undefined ? undefined : pendingHighlights.get(pendingKey));
    if (pending === undefined) {
        highlightControllers.add(controller);
        // A terminal observation cannot describe a new real submission, even when
        // the source revision is unchanged. Cache returns above retain the old ID.
        if (request?.terminal === true)
            request = diagnoseHighlightRequest(code, normalizedLanguage, options, language, true);
        const job = createHighlightJob(request);
        const diagnosticJob = () => observedHighlightJob(pending) ?? job;

        let started = 0;
        if (renderDiagnosticsEnabled()) started = performance.now();

        let unavailable: { reason: TokenizeUnavailableReason; error?: string } | undefined;
        const onUnavailable = (reason: TokenizeUnavailableReason, error?: string): void => {
            unavailable = { reason };
            if (error !== undefined) unavailable.error = error;
            if (reason === "backpressure") {
                highlightJobState(diagnosticJob(), "waiting-capacity");
                owner?.capacityRequests.set(key, { code, language, options, version: generation });
            }
        };

        const record = (outcome: SyntaxHighlightOutcome, error?: string): void =>
            recordSyntaxHighlight(code, language, normalizedLanguage, outcome, started, error);

        pending = state.tokenizer
            .tokenize(plainLines.join("\n"), normalizedLanguage, bracketPairColoringEnabled, {
                signal,
                retryWhenCapacityAvailable: owner?.retryWhenCapacityAvailable,
                onUnavailable,
                onState: (phase) => highlightJobState(diagnosticJob(), phase),
            })
            .then((lines) => {
                if (
                    signal.aborted ||
                    syntaxState !== state ||
                    syntaxRenderingVersion !== generation
                ) {
                    finishHighlightJob(diagnosticJob(), "cancelled", "stale-result");
                    record("cancelled");
                    return plainLines;
                }

                if (lines === undefined) {
                    if (unavailable?.reason !== "backpressure")
                        finishHighlightJob(
                            diagnosticJob(),
                            unavailable?.reason ?? "failed",
                            "backend-unavailable",
                        );
                    record(unavailable?.reason ?? "failed", unavailable?.error);
                    return plainLines;
                }

                record("highlighted");

                const highlighted = normalizeHighlightedLineCount(lines, plainLines.length);
                if (shouldCache) rememberHighlightedCode(key, highlighted);

                if (
                    owner !== undefined &&
                    invalidate !== undefined &&
                    highlightOwners.get(invalidate) === owner
                ) {
                    owner.results.set(
                        key,
                        highlightedSource(code, normalizedLanguage, state.theme.name, highlighted),
                    );

                    finishHighlightJob(diagnosticJob(), "completed", undefined, true);
                    notifySyntaxInvalidation(invalidate);
                } else if (!shouldCache && options.cache !== false) {
                    if (completedUnownedHighlights.size >= CACHE_LIMIT) {
                        const oldest = completedUnownedHighlights.keys().next().value;
                        if (oldest !== undefined) completedUnownedHighlights.delete(oldest);
                    }

                    completedUnownedHighlights.set(key, new WeakRef(highlighted));
                }

                finishHighlightJob(diagnosticJob(), "completed");
                for (const listener of highlightCompletionListeners) listener();

                return highlighted;
            })
            .catch((cause: unknown) => {
                finishHighlightJob(diagnosticJob(), "failed", "backend-error");
                recordRenderError("syntax.highlight", cause);
                record("failed", errorMessage(cause));
                return plainLines;
            })
            .finally(() => {
                highlightControllers.delete(controller);

                if (pending !== undefined) activeHighlights.delete(pending);

                if (pendingKey !== undefined && pendingHighlights.get(pendingKey) === pending)
                    pendingHighlights.delete(pendingKey);

                if (owner !== undefined && owner.pending.get(key) === pending)
                    owner.pending.delete(key);
            });
        bindHighlightJob(pending, job);
        activeHighlights.add(pending);

        if (pendingKey !== undefined) pendingHighlights.set(pendingKey, pending);
        owner?.pending.set(key, pending);
    } else {
        let job = observedHighlightJob(pending);
        if (job === undefined) {
            job = createHighlightJob(request, false);
            bindHighlightJob(pending, job);
        } else joinHighlightJob(job, request);
    }

    return pending;
}

export type LoadedSyntaxHighlighter = {
    readonly highlighter: HighlighterGeneric<string, string>;
    readonly themeName: string;
    readonly language: SyntaxLanguage | "text";
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
    if (!(await loadSyntaxLanguageIfReady(normalizedLanguage))) return undefined;
    if (generation !== syntaxGeneration || syntaxState !== state) return undefined;

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

    if (!isLoadableSyntaxLanguage(normalizedLanguage)) {
        return false;
    }

    const pending = languageLoads.get(normalizedLanguage);
    if (pending !== undefined) return pending;

    const loading = loadSyntaxLanguage(state, normalizedLanguage, generation);
    languageLoads.set(normalizedLanguage, loading);
    try {
        return await loading;
    } finally {
        if (languageLoads.get(normalizedLanguage) === loading)
            languageLoads.delete(normalizedLanguage);
    }
}

async function loadSyntaxLanguage(
    state: Extract<SyntaxState, { status: "ready" }>,
    normalizedLanguage: SyntaxLanguage,
    generation: number,
): Promise<boolean> {
    try {
        await state.highlighter.loadLanguage(syntaxLanguageInput(normalizedLanguage));
    } catch (cause: unknown) {
        if (generation !== syntaxGeneration || syntaxState !== state) return false;
        failHighlightReadiness(normalizedLanguage, "language-load-failed");

        throw cause;
    }

    if (generation !== syntaxGeneration || syntaxState !== state) {
        return false;
    }

    state.loadedLanguages.add(normalizedLanguage);
    state.dynamicLanguages.add(normalizedLanguage);
    notifySyntaxStateListeners(state.status);

    return true;
}

export function clearSyntaxHighlightCache(): void {
    resetSyntaxHighlightCache("cache-clear");
}

function resetSyntaxHighlightCache(reason: string): void {
    clearSyntaxColors(reason);
    highlightOwners = new WeakMap();
    readinessRetries.clear();
    registeredReadinessRetries.clear();
}

/** Installation preserves source identity and readiness waiters; explicit clearing cancels them. */
function clearSyntaxColors(reason = "cache-clear", preserveReady = false): void {
    cancelHighlightRequests(reason, preserveReady);
    syntaxRenderingVersion += 1;

    for (const controller of highlightControllers) controller.abort();
    highlightControllers.clear();
    pendingHighlights.clear();
    completedUnownedHighlights.clear();
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
    let result: SyntaxHighlighterDiagnostics = {
        status: state?.status ?? "uninitialized",
        cacheEntries: highlightedCodeCache.size,
        cacheBytes: highlightedCodeCacheBytes,
    };
    if (diagnostics !== undefined) {
        result = {
            ...result,
            configuredPreloadLanguages: diagnostics.configuredLanguages,
            preloadLanguages: diagnostics.preloadLanguages,
            ignoredPreloadLanguages: diagnostics.ignoredConfiguredLanguages,
            projectLanguageDetectionEnabled: diagnostics.projectDetectionEnabled,
        };
    }

    if (diagnostics?.projectDetection !== undefined) {
        result = {
            ...result,
            projectLanguageDetectionCwd: diagnostics.projectDetection.cwd,
            projectLanguageDetectionScannedFiles: diagnostics.projectDetection.result.scannedFiles,
            projectLanguageDetectionScannedDirectories:
                diagnostics.projectDetection.result.scannedDirectories,
            projectLanguageDetectionReadErrors: diagnostics.projectDetection.result.readErrors,
            detectedProjectLanguages: diagnostics.projectDetection.result.languages,
        };
        if (diagnostics.projectDetection.result.stoppedReason !== undefined) {
            result = {
                ...result,
                projectLanguageDetectionStoppedReason:
                    diagnostics.projectDetection.result.stoppedReason,
            };
        }
    }

    if (state?.status === "ready") {
        result = {
            ...result,
            loadedLanguages: [...state.loadedLanguages].sort(),
            dynamicLanguages: [...state.dynamicLanguages].sort(),
        };
    }

    return result;
}

/** Disposes the central highlighter and resets syntax state for reloads or shutdown. */
export async function disposeSyntaxHighlighting(): Promise<void> {
    resetSyntaxHighlightCache("shutdown");
    languageLoads.clear();
    syntaxGeneration += 1;

    const state = syntaxState;
    syntaxState = undefined;
    initializationPromise = undefined;
    syntaxPreloadDiagnostics = undefined;
    activeConfigurationKey = undefined;

    disposeReadySyntaxState(state);

    if (pythonTokenizer !== undefined) {
        disposeTokenizer(pythonTokenizer);
        pythonTokenizer = undefined;
    }

    await Promise.allSettled(tokenizerDisposals);
    syntaxRenderingVersion += 1;
    notifySyntaxStateListeners("uninitialized");
}

type SyntaxThemeSource =
    | { readonly status: "read"; readonly contents: string }
    | { readonly status: "failed"; readonly cause: unknown };

type SyntaxSource = {
    readonly config: SyntaxConfig;
    readonly theme: SyntaxThemeSource;
    readonly configurationKey: string;
};

async function prepareSyntaxSource(
    env: NodeJS.ProcessEnv,
    options: SyntaxInitializationOptions,
): Promise<SyntaxSource> {
    const config = loadSyntaxConfig(env);
    let theme: SyntaxThemeSource = { status: "read", contents: "" };
    let themeContents = "";
    if (config.enabled) {
        try {
            themeContents = await readFile(config.themePath, "utf8");
            theme = { status: "read", contents: themeContents };
        } catch (cause: unknown) {
            theme = { status: "failed", cause };
            themeContents =
                cause instanceof Error ? `${cause.name}:${cause.message}` : String(cause);
        }
    }

    const configurationKey = createHash("sha256")
        .update(
            JSON.stringify({
                config,
                themeContents,
                preloadLanguages: options.preloadLanguages ?? null,
                projectLanguageDetection: options.projectLanguageDetection ?? null,
            }),
        )
        .digest("hex");

    return { config, theme, configurationKey };
}

function notifySyntaxStateListeners(status: SyntaxStateStatus): void {
    if (status === "ready") retryReadySyntaxLanguages();
    if (status === "disabled" || status === "failed")
        failHighlightReadiness(undefined, "syntax-unavailable");
    for (const listener of syntaxStateListeners) {
        listener(status);
    }
}

function disposeReadySyntaxState(state: SyntaxState | undefined): void {
    if (state?.status === "ready") {
        state.highlighter.dispose();

        disposeTokenizer(state.tokenizer);
    }
}

function disposeTokenizer(tokenizer: ReturnType<typeof createSyntaxTokenizer>): void {
    const disposal = tokenizer.dispose();
    tokenizerDisposals.add(disposal);
    void disposal.finally(() => {
        tokenizerDisposals.delete(disposal);
    });
}

function disposedSyntaxState(config: SyntaxConfig): SyntaxState {
    return { status: "disabled", config, reason: "disposed" };
}

async function initializeSyntaxHighlightingOnce(
    source: SyntaxSource,
    options: SyntaxInitializationOptions,
): Promise<SyntaxState> {
    const { config } = source;
    if (!config.enabled) {
        return { status: "disabled", config, reason: config.reason };
    }

    if (source.theme.status === "failed") {
        const { cause } = source.theme;
        return {
            status: "failed",
            config,
            reason: cause instanceof Error ? cause.message : String(cause),
        };
    }

    try {
        const theme = parseSyntaxTheme(config, source.theme.contents);
        const preloadSelection = selectSyntaxPreloadLanguages(options);
        syntaxPreloadDiagnostics = preloadSelection.diagnostics;

        const factory = options.createHighlighter ?? createSyntaxHighlighter;
        const highlighter = await factory({
            themes: [theme.registration],
            langs: preloadSelection.languages.map(syntaxLanguageInput),
        });

        return {
            status: "ready",
            config,
            theme,
            highlighter,
            tokenizer: createSyntaxTokenizer(theme.registration, {
                maxJobs: CACHE_LIMIT,
                maxBytes: MAX_CACHE_BYTES,
                reportWarning: options.reportWarning,
                async waitForDisposals() {
                    await Promise.all(tokenizerDisposals);
                },
            }),
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
    const preloadLanguages = new Set<SyntaxLanguage>();
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

    let diagnostics: SyntaxPreloadDiagnostics = {
        configuredLanguages,
        preloadLanguages: [...preloadLanguages],
        ignoredConfiguredLanguages,
        projectDetectionEnabled,
    };
    if (projectDetection !== undefined) {
        diagnostics = { ...diagnostics, projectDetection };
    }

    return {
        languages: [...preloadLanguages],
        diagnostics,
    };
}

function formatConfiguredLanguageForWarning(language: string): string {
    const trimmed = language.trim();
    const displayed = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    return JSON.stringify(displayed);
}

type SyntaxHighlightOutcome =
    | "highlighted"
    | "cached"
    | "unsupported-language"
    | "not-ready"
    | "unavailable"
    | "failed"
    | "cancelled"
    | "backpressure";

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

/** Diagnostic identity is independent of backend deduplication and cache keys. */
function diagnoseHighlightRequest(
    code: string,
    language: string | undefined,
    options: SyntaxHighlightOptions,
    requestedLanguage?: string,
    newSubmission = false,
): HighlightRequest | undefined {
    if (!renderDiagnosticsEnabled()) return undefined;
    let pending: Promise<string[]> | undefined;
    const state = syntaxState;
    if (state?.status === "ready" && language !== undefined) {
        const key = highlightedCodeCacheKey(
            state.theme.name,
            language,
            code,
            Buffer.byteLength(code, "utf8"),
        );
        if (options.invalidate !== undefined)
            pending = highlightOwners.get(options.invalidate)?.pending.get(key);
        if (options.invalidate === undefined && options.signal === undefined)
            pending ??= pendingHighlights.get(key);
    }
    let newIntention = newSubmission;
    if (
        options.invalidate !== undefined &&
        options.signal?.aborted !== true &&
        language !== undefined &&
        language !== "text" &&
        isLoadableSyntaxLanguage(language) &&
        (state === undefined || (state.status === "ready" && !state.loadedLanguages.has(language)))
    )
        newIntention = true;
    return beginHighlightRequest(
        code,
        language,
        options.invalidate,
        options.signal,
        pending !== undefined && observedHighlightJob(pending) === undefined,
        requestedLanguage,
        newIntention,
    );
}

function diagnoseUnhighlightedRequest(
    request: HighlightRequest | undefined,
    language: string | undefined,
    options: SyntaxHighlightOptions,
): void {
    if (request === undefined || request.terminal) return;
    if (language === undefined || language === "text" || !isLoadableSyntaxLanguage(language)) {
        transitionHighlightRequest(request, "unsupported", "plain-language");
    } else if (syntaxState?.status === "disabled" || syntaxState?.status === "failed") {
        transitionHighlightRequest(request, "failed", "syntax-unavailable");
    } else if (options.invalidate === undefined) {
        transitionHighlightRequest(request, "cancelled", "no-readiness-owner");
    } else transitionHighlightRequest(request, "waiting-ready");
}

/** Records why a request stayed plain, including transient not-ready states (deduplicated). */
function recordUnhighlightedRequest(
    code: string,
    language: string | undefined,
    normalizedLanguage: string | undefined,
): void {
    if (!renderDiagnosticsEnabled() || code.length === 0) return;

    // Unlabelled and plain-text requests are deliberately plain, not failures.
    if (normalizedLanguage === undefined) {
        if (language !== undefined && language.trim().length > 0)
            recordSyntaxHighlight(code, language, normalizedLanguage, "unsupported-language");

        return;
    }

    if (normalizedLanguage === "text") return;

    const state = syntaxState;
    if (state === undefined) {
        recordSyntaxHighlight(code, language, normalizedLanguage, "not-ready", 0, "uninitialized");
        return;
    }

    if (state.status !== "ready") {
        recordSyntaxHighlight(code, language, normalizedLanguage, "unavailable", 0, state.reason);
        return;
    }

    if (!state.loadedLanguages.has(normalizedLanguage))
        recordSyntaxHighlight(
            code,
            language,
            normalizedLanguage,
            "not-ready",
            0,
            "language not loaded",
        );
}

/** One event per (code, requested language, outcome) and session. */
function recordSyntaxHighlight(
    code: string,
    language: string | undefined,
    resolvedLanguage: string | undefined,
    outcome: SyntaxHighlightOutcome,
    started = 0,
    error?: string,
): void {
    if (!renderDiagnosticsEnabled()) return;

    let ms = 0;
    if (started > 0) ms = Math.round((performance.now() - started) * 10) / 10;

    // A completed highlight is later served from cache on every redraw; one success suffices.
    let dedupeOutcome: string = outcome;
    if (outcome === "highlighted" || outcome === "cached") dedupeOutcome = "success";

    recordRenderEvent(
        "syntax_highlight",
        () => ({
            language: language ?? null,
            resolvedLanguage,
            codeHash: diagnosticCodeHash(code),
            bytes: utf8Bytes(code),
            outcome,
            ms,
            error,
        }),
        () => `${diagnosticCodeHash(code)}\0${language ?? ""}\0${dedupeOutcome}`,
    );
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

function highlightedSource(
    code: string,
    language: string,
    themeName: string,
    lines: string[],
): HighlightedSource {
    return { source: normalizedCodeLines(code).join("\n"), language, themeName, lines };
}

function pendingHighlightLines(
    code: string,
    language: string,
    themeName: string,
    owner: HighlightOwner | undefined,
): string[] {
    const lines = normalizedCodeLines(code);
    if (owner === undefined) return lines;

    let previous: readonly [key: string, source: HighlightedSource] | undefined;
    let retainedCount = 0;
    let retainedLength = 0;
    let appended = "";

    for (const entry of owner.previousResults) {
        const result = entry[1];
        if (result.language !== language || result.themeName !== themeName) continue;
        if (result.lines.map(stripVTControlCharacters).join("\n") !== result.source) continue;

        const previousLines = result.source.split("\n");
        let count = 0;
        let length = 0;
        let suffix = "";

        for (const [index, plain] of previousLines.entries()) {
            const current = lines[index];
            if (current === undefined) break;

            if (current === plain) {
                count += 1;
                length += plain.length + 1;
                continue;
            }

            if (index === previousLines.length - 1 && current.startsWith(plain)) {
                count += 1;
                length += plain.length;
                suffix = current.slice(plain.length);
            }
            break;
        }

        if (length <= retainedLength) continue;

        previous = entry;
        retainedCount = count;
        retainedLength = length;
        appended = suffix;
    }

    if (previous === undefined) return lines;

    const [key, result] = previous;
    owner.results.set(key, result);

    const retained = result.lines.slice(0, retainedCount);
    const last = retained.at(-1);
    if (last !== undefined) retained[retained.length - 1] = last + appended;
    return [...retained, ...lines.slice(retainedCount)];
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

    const previous = highlightedCodeCache.get(cacheKey);
    if (previous !== undefined) {
        highlightedCodeCache.delete(cacheKey);
        highlightedCodeCacheBytes -= previous.bytes;
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
