import {
    type AutocompleteItem,
    type AutocompleteProvider,
    fuzzyFilter,
} from "@earendil-works/pi-tui";

import {
    activeChainSegment,
    formatChain,
    isTriggerBoundary,
    type ActiveChainSegment,
} from "./chain-syntax.ts";
import type { Candidate, Resolution } from "./source-contract.ts";

export type ChainCompletionSource = {
    readonly id: string;
    readonly trigger: string;
    readonly separator?: string;
    readonly completionSuffix: string;
    readonly filtering: "local" | "provider";

    discover(request: {
        readonly query: string;
        readonly path: readonly Candidate[];
        readonly cursor?: string;
        readonly signal?: AbortSignal;
    }): Promise<{ readonly items: readonly Candidate[]; readonly nextCursor?: string }>;

    resolve(segments: readonly string[], signal?: AbortSignal): Promise<Resolution>;
};

export type ChainSelection = {
    readonly sourceId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly path: readonly Candidate[];
    readonly editorText: string;
};

export type ChainAutocompleteOptions = {
    readonly current: AutocompleteProvider;
    readonly sources: readonly ChainCompletionSource[];
    readonly onSelection?: (selection: ChainSelection) => void;

    readonly resolveSelected?: (
        sourceId: string,
        segments: readonly string[],
        start: number,
    ) => readonly Candidate[] | undefined;

    readonly onState?: (sourceId: string, status: "ready" | "unresolved" | "failed") => void;
    readonly onContinue?: () => void;
};

const MAX_CONTINUATION_PATHS = 64;

export type ChainAutocompleteProvider = AutocompleteProvider & {
    reconcile(text: string): void;
    dispose(): void;
};

type ContinuationPath = {
    readonly sourceId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly path: readonly Candidate[];
};

const MAX_PAGE_SCOPES = 32;
const MAX_PAGES_PER_SCOPE = 10;
const MAX_RETAINED_CANDIDATES = 1_000;
const MAX_LOCAL_SUGGESTIONS = 100;

type CompletionAction =
    | {
          readonly kind: "navigate";
          readonly source: ChainCompletionSource;
          readonly active: ActiveChainSegment;
          readonly path: readonly Candidate[];
          readonly candidate: Candidate;
      }
    | {
          readonly kind: "select";
          readonly source: ChainCompletionSource;
          readonly active: ActiveChainSegment;
          readonly path: readonly Candidate[];
      }
    | {
          readonly kind: "more";
          readonly source: ChainCompletionSource;
          readonly active: ActiveChainSegment;
          readonly key: string;
          readonly cursor: string;
      };

type PageState = {
    readonly items: readonly Candidate[];
    readonly pageCount: number;
    readonly requestedCursors: ReadonlySet<string>;
};

function absoluteCursor(lines: readonly string[], cursorLine: number, cursorCol: number): number {
    let offset = 0;
    for (let index = 0; index < cursorLine; index += 1) {
        offset += (lines[index]?.length ?? 0) + 1;
    }

    return offset + cursorCol;
}

function cursorPosition(text: string, offset: number) {
    const before = text.slice(0, offset).split("\n");
    return { line: before.length - 1, col: before[before.length - 1]?.length ?? 0 };
}

function definitionsFor(sources: readonly ChainCompletionSource[]) {
    return sources.map((source) => ({
        id: source.id,
        trigger: source.trigger,
        separator: source.separator,
    }));
}

function sourceFor(
    sources: readonly ChainCompletionSource[],
    sourceId: string,
): ChainCompletionSource | undefined {
    return sources.find((source) => source.id === sourceId);
}

function itemFor(candidate: Candidate): AutocompleteItem {
    const item: AutocompleteItem = { value: candidate.segment, label: candidate.label };
    if (candidate.description !== undefined) item.description = candidate.description;

    return item;
}

function occurrenceKey(sourceId: string, start: number): string {
    return `${sourceId}\u0000${start}`;
}

function pathMatchesSegments(path: readonly Candidate[], segments: readonly string[]): boolean {
    return (
        path.length === segments.length &&
        path.every((candidate, index) => candidate.segment === segments[index])
    );
}

function pageKey(
    source: ChainCompletionSource,
    active: ActiveChainSegment,
    path: readonly Candidate[],
): string {
    return JSON.stringify([
        source.id,
        active.index,
        active.query,
        path.map((candidate) => candidate.id),
    ]);
}

function retainPageState(states: Map<string, PageState>, key: string, state: PageState): void {
    states.delete(key);
    states.set(key, state);

    while (states.size > MAX_PAGE_SCOPES) {
        const oldest = states.keys().next().value;
        if (oldest === undefined) break;

        states.delete(oldest);
    }
}

function completionSuffixFor(textAfterMention: string, suffix: string) {
    if (suffix.length === 0) return { text: "", consume: 0 };
    if (textAfterMention.startsWith(suffix)) return { text: suffix, consume: suffix.length };

    if (/^\s/u.test(suffix) && /^\s/u.test(textAfterMention)) {
        const existingWhitespace = /^\s/u.exec(textAfterMention)?.[0] ?? "";
        return { text: suffix, consume: existingWhitespace.length };
    }

    return { text: suffix, consume: 0 };
}

function replaceOwnedSuffix(
    lines: string[],
    action: CompletionAction,
    replacement: string,
    consumeAfter = 0,
) {
    const text = lines.join("\n");
    const start = action.active.chain.start;
    const before = text.slice(0, start);
    const after = text.slice(action.active.ownedEnd + consumeAfter);
    const updated = `${before}${replacement}${after}`;
    const cursorOffset = before.length + replacement.length;
    const cursor = cursorPosition(updated, cursorOffset);
    const mentionStart = start;
    const mentionEnd = cursorOffset;

    return {
        lines: updated.split("\n"),
        cursorLine: cursor.line,
        cursorCol: cursor.col,
        start: mentionStart,
        end: mentionEnd,
        text: updated.slice(mentionStart, mentionEnd),
        editorText: updated,
    };
}

/** Creates a chain-aware provider while retaining the caller-owned mutable sources array by reference. */
export function createChainAutocompleteProvider(
    options: ChainAutocompleteOptions,
): ChainAutocompleteProvider {
    let actions = new WeakMap<AutocompleteItem, CompletionAction>();
    let activeRequest: AbortController | undefined;
    let requestGeneration = 0;
    let pendingPage: { readonly key: string; readonly cursor: string } | undefined;
    const pageStates = new Map<string, PageState>();
    const continuationPaths = new Map<string, ContinuationPath>();
    let composedTriggerCharacters: string[] = [];
    let previousText = "";
    const reconcile = (text: string): void => {
        if (text === previousText) return;

        activeRequest?.abort();
        requestGeneration += 1;

        let prefix = 0;
        while (
            prefix < text.length &&
            prefix < previousText.length &&
            text[prefix] === previousText[prefix]
        )
            prefix += 1;

        let suffix = 0;
        while (
            suffix < text.length - prefix &&
            suffix < previousText.length - prefix &&
            text[text.length - 1 - suffix] === previousText[previousText.length - 1 - suffix]
        )
            suffix += 1;

        const oldEnd = previousText.length - suffix;
        const delta = text.length - previousText.length;
        const retained: ContinuationPath[] = [];
        for (const entry of continuationPaths.values()) {
            let updated = entry;

            if (entry.end <= prefix) {
                const removed = previousText.slice(prefix, oldEnd);
                const inserted = text.slice(prefix, text.length - suffix);
                if (
                    entry.end === prefix &&
                    (removed.includes(entry.text) || inserted.includes(entry.text))
                )
                    continue;
            } else if (entry.start >= oldEnd)
                updated = { ...entry, start: entry.start + delta, end: entry.end + delta };
            else continue;

            if (
                !isTriggerBoundary(text, updated.start) ||
                text.slice(updated.start, updated.end) !== updated.text
            )
                continue;

            retained.push(updated);
        }

        continuationPaths.clear();

        for (const entry of retained)
            continuationPaths.set(occurrenceKey(entry.sourceId, entry.start), entry);

        previousText = text;
    };

    const provider: ChainAutocompleteProvider = {
        reconcile,
        dispose() {
            activeRequest?.abort();
            requestGeneration += 1;
            continuationPaths.clear();
            pageStates.clear();
            actions = new WeakMap();
        },
        get triggerCharacters() {
            return [
                ...new Set([
                    ...composedTriggerCharacters,
                    ...options.sources.map((source) => Array.from(source.trigger)[0] ?? ""),
                ]),
            ].filter((character) => character.length > 0);
        },

        set triggerCharacters(characters: string[] | undefined) {
            composedTriggerCharacters = characters ?? [];
        },

        async getSuggestions(lines, cursorLine, cursorCol, suggestionOptions) {
            const text = lines.join("\n");
            reconcile(text);

            const cursor = absoluteCursor(lines, cursorLine, cursorCol);
            const active = activeChainSegment(text, definitionsFor(options.sources), cursor);
            if (active === undefined) {
                return options.current.getSuggestions(
                    lines,
                    cursorLine,
                    cursorCol,
                    suggestionOptions,
                );
            }

            const source = sourceFor(options.sources, active.chain.sourceId);
            if (source === undefined || suggestionOptions.signal.aborted) return null;

            activeRequest?.abort();

            const request = new AbortController();
            let completionPrefix = active.query;
            if (completionPrefix.startsWith("/")) completionPrefix = "";
            activeRequest = request;

            const generation = ++requestGeneration;
            const abort = () => request.abort();
            suggestionOptions.signal.addEventListener("abort", abort, { once: true });

            try {
                let path: readonly Candidate[] = [];
                if (active.path.length > 0) {
                    const occurrence = occurrenceKey(source.id, active.chain.start);
                    const continued = continuationPaths.get(occurrence);
                    if (
                        continued !== undefined &&
                        pathMatchesSegments(continued.path, active.path)
                    ) {
                        path = continued.path;
                    } else {
                        continuationPaths.delete(occurrence);

                        const selected = options.resolveSelected?.(
                            source.id,
                            active.path,
                            active.chain.start,
                        );
                        if (selected !== undefined && pathMatchesSegments(selected, active.path)) {
                            path = selected;
                        } else {
                            const resolution = await source.resolve(active.path, request.signal);

                            if (request.signal.aborted || generation !== requestGeneration)
                                return null;

                            if (resolution.status === "unresolved") {
                                options.onState?.(source.id, "unresolved");
                                return { prefix: completionPrefix, items: [] };
                            }

                            path = resolution.path;
                        }
                    }
                }

                if (request.signal.aborted || generation !== requestGeneration) return null;

                const key = pageKey(source, active, path);
                let cursorForRequest: string | undefined;
                if (pendingPage?.key === key) cursorForRequest = pendingPage.cursor;
                pendingPage = undefined;

                const response = await source.discover({
                    query: active.query,
                    path,
                    cursor: cursorForRequest,
                    signal: request.signal,
                });

                request.signal.throwIfAborted();
                if (generation !== requestGeneration) return null;

                let existingPage: PageState | undefined;
                if (cursorForRequest !== undefined) existingPage = pageStates.get(key);

                const requestedCursors = new Set(existingPage?.requestedCursors);
                if (cursorForRequest !== undefined) requestedCursors.add(cursorForRequest);

                const retained: Candidate[] = [];
                const retainedIds = new Set<string>();
                let received = response.items.filter(
                    (candidate) => candidate.selectable || candidate.navigable,
                );
                if (source.filtering === "local" && active.query.length > 0) {
                    received = fuzzyFilter(
                        received,
                        active.query,
                        (candidate) =>
                            candidate.searchText ??
                            `${candidate.label} ${candidate.description ?? ""}`,
                    );
                }

                for (const candidate of existingPage?.items ?? []) {
                    if (retainedIds.has(candidate.id)) continue;
                    retainedIds.add(candidate.id);
                    retained.push(candidate);

                    if (retained.length === MAX_RETAINED_CANDIDATES) break;
                }

                if (retained.length < MAX_RETAINED_CANDIDATES) {
                    for (const candidate of received) {
                        if (retainedIds.has(candidate.id)) continue;
                        retainedIds.add(candidate.id);
                        retained.push(candidate);

                        if (retained.length === MAX_RETAINED_CANDIDATES) break;
                    }
                }

                let pageCount = 1;
                if (cursorForRequest !== undefined) {
                    pageCount = (existingPage?.pageCount ?? 0) + 1;
                }

                retainPageState(pageStates, key, {
                    items: retained,
                    pageCount,
                    requestedCursors,
                });

                let candidates = retained;
                if (source.filtering === "local") {
                    candidates = candidates.slice(0, MAX_LOCAL_SUGGESTIONS);
                }

                actions = new WeakMap();

                const items: AutocompleteItem[] = [];
                const parent = path.at(-1);
                if (parent?.selectable === true && parent.navigable) {
                    const useParent: AutocompleteItem = {
                        value: parent.segment,
                        label: `Use ${parent.label}`,
                        description: "Use this target",
                    };
                    actions.set(useParent, { kind: "select", source, active, path });
                    items.push(useParent);
                }

                for (const candidate of candidates) {
                    const item = itemFor(candidate);
                    if (candidate.navigable) {
                        actions.set(item, { kind: "navigate", source, active, path, candidate });
                    } else if (candidate.selectable) {
                        actions.set(item, {
                            kind: "select",
                            source,
                            active,
                            path: [...path, candidate],
                        });
                    }

                    items.push(item);
                }

                if (
                    response.nextCursor !== undefined &&
                    pageCount < MAX_PAGES_PER_SCOPE &&
                    retained.length < MAX_RETAINED_CANDIDATES &&
                    !requestedCursors.has(response.nextCursor)
                ) {
                    const more: AutocompleteItem = {
                        value: "",
                        label: "More…",
                        description: "Load more results",
                    };
                    actions.set(more, {
                        kind: "more",
                        source,
                        active,
                        key,
                        cursor: response.nextCursor,
                    });

                    items.push(more);
                }

                options.onState?.(source.id, "ready");

                return { prefix: completionPrefix, items };
            } catch {
                if (request.signal.aborted) return null;

                options.onState?.(source.id, "failed");

                return { prefix: completionPrefix, items: [] };
            } finally {
                suggestionOptions.signal.removeEventListener("abort", abort);
            }
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            const action = actions.get(item);
            if (action === undefined) {
                return options.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            }

            if (action.kind === "more") {
                pendingPage = { key: action.key, cursor: action.cursor };
                options.onContinue?.();
                return { lines, cursorLine, cursorCol };
            }

            const separator = action.source.separator ?? ":";
            if (action.kind === "navigate") {
                const replacement = `${formatChain(
                    [...action.path, action.candidate].map((candidate) => candidate.segment),
                    action.active.chain.trigger,
                    separator,
                )}${separator}`;
                const result = replaceOwnedSuffix(lines, action, replacement);
                const continuedPath = [...action.path, action.candidate];

                reconcile(result.editorText);
                continuationPaths.set(occurrenceKey(action.source.id, result.start), {
                    sourceId: action.source.id,
                    start: result.start,
                    end: result.end,
                    text: result.text,
                    path: structuredClone(continuedPath),
                });

                if (continuationPaths.size > MAX_CONTINUATION_PATHS) {
                    const oldest = continuationPaths.keys().next().value;
                    if (oldest !== undefined) continuationPaths.delete(oldest);
                }

                options.onContinue?.();

                return {
                    lines: result.lines,
                    cursorLine: result.cursorLine,
                    cursorCol: result.cursorCol,
                };
            }

            const segments = action.path.map((candidate) => candidate.segment);
            let mention = formatChain(segments, action.active.chain.trigger, separator);
            const target = action.path.at(-1);
            if (target?.insertionText !== undefined) mention = target.insertionText;

            const text = lines.join("\n");
            const suffix = completionSuffixFor(
                text.slice(action.active.ownedEnd),
                action.source.completionSuffix,
            );
            const replacement = `${mention}${suffix.text}`;
            const result = replaceOwnedSuffix(lines, action, replacement, suffix.consume);
            continuationPaths.delete(occurrenceKey(action.source.id, result.start));
            options.onSelection?.({
                sourceId: action.source.id,
                start: result.start,
                end: result.end - suffix.text.length,
                text: result.text.slice(0, result.text.length - suffix.text.length),
                path: action.path,
                editorText: result.editorText,
            });

            return {
                lines: result.lines,
                cursorLine: result.cursorLine,
                cursorCol: result.cursorCol,
            };
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            const text = lines.join("\n");
            const cursor = absoluteCursor(lines, cursorLine, cursorCol);
            if (activeChainSegment(text, definitionsFor(options.sources), cursor) !== undefined)
                return false;

            return (
                options.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
            );
        },
    };

    return provider;
}
