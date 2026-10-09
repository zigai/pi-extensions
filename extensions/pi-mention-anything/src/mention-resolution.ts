import type { ContextEvent } from "@earendil-works/pi-coding-agent";

import { isTriggerBoundary, parseMentions } from "./chain-syntax.ts";
import type { Candidate, Resolution } from "./source-contract.ts";

export type MentionSnapshot = {
    readonly sourceId: string;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly path: readonly Candidate[];
};

export type ExpansionSource = {
    readonly id: string;
    readonly trigger: string;
    readonly separator?: string;
    readonly expansionPolicy?: "selected-only" | "selected-or-resolved";
    readonly replacementTemplate?: string;
    readonly resolve: (segments: readonly string[], signal?: AbortSignal) => Promise<Resolution>;

    readonly replacement?: (
        path: readonly Candidate[],
        options: { readonly signal?: AbortSignal },
    ) => string | Promise<string>;
};

export type MentionSelections = {
    reconcile(text: string): void;
    record(snapshot: MentionSnapshot, editorText: string): void;
    snapshot(text: string): readonly MentionSnapshot[];
    clear(): void;
};

/** Snapshots belong to exact editor occurrences. Edits overlapping one discard it. */
export function createMentionSelections(): MentionSelections {
    let previousText = "";
    let snapshots: MentionSnapshot[] = [];
    const reconcile = (text: string): void => {
        if (text === previousText) return;

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
        let changedText = text.slice(prefix, text.length - suffix);
        if (delta < 0) changedText = previousText.slice(prefix, oldEnd);

        const ambiguous = new Set(
            snapshots
                .filter(
                    (snapshot) =>
                        delta !== 0 &&
                        snapshot.end === prefix &&
                        changedText.includes(snapshot.text),
                )
                .map((snapshot) => snapshot.text),
        );

        snapshots = snapshots
            .flatMap((snapshot) => {
                if (ambiguous.has(snapshot.text)) return [];
                if (snapshot.end <= prefix) return [snapshot];

                if (snapshot.start >= oldEnd)
                    return [
                        { ...snapshot, start: snapshot.start + delta, end: snapshot.end + delta },
                    ];

                return [];
            })
            .filter((snapshot) => {
                if (text.slice(snapshot.start, snapshot.end) !== snapshot.text) return false;
                if (!isTriggerBoundary(text, snapshot.start)) return false;

                const adjacent = /^\S*/.exec(text.slice(snapshot.end))?.[0] ?? "";
                return /^[.,;!?)}\]]*$/.test(adjacent);
            });
        previousText = text;
    };

    return {
        reconcile,
        record(snapshot: MentionSnapshot, editorText: string): void {
            reconcile(editorText);
            snapshots = snapshots.filter(
                (existing) => existing.end <= snapshot.start || existing.start >= snapshot.end,
            );
            snapshots.push({ ...snapshot, path: structuredClone(snapshot.path) });
        },
        snapshot(text: string): readonly MentionSnapshot[] {
            reconcile(text);

            return snapshots.map((snapshot) => ({
                ...snapshot,
                path: structuredClone(snapshot.path),
            }));
        },
        clear(): void {
            previousText = "";
            snapshots = [];
        },
    };
}

/** Declarative fields only: no property traversal or provider-data serialization. */
export function renderReplacementTemplate(template: string, path: readonly Candidate[]): string {
    const target = path.at(-1);
    if (target === undefined) throw new Error("Cannot render an empty mention target.");

    const fields = new Map<string, string>([
        ["id", target.id],
        ["label", target.label],
        ["segment", target.segment],
        ["path", path.map((candidate) => candidate.segment).join(":")],
        ["ids", path.map((candidate) => candidate.id).join(":")],
    ]);

    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match: string, field: string) => {
        const value = fields.get(field);
        if (value === undefined)
            throw new Error("Mention replacement template contains an undeclared field.");

        return value;
    });
}

export async function expandMentionText(
    text: string,
    sources: readonly ExpansionSource[],
    options: {
        readonly snapshots?: readonly MentionSnapshot[];
        readonly signal?: AbortSignal;
        readonly onUnresolved?: (sourceId: string) => void;
    } = {},
): Promise<string> {
    const selectedSpans = (options.snapshots ?? []).filter(
        (snapshot) =>
            text.slice(snapshot.start, snapshot.end) === snapshot.text &&
            sources.some((source) => source.id === snapshot.sourceId),
    );
    const spans = [
        ...parseMentions(text, sources).filter(
            (span) =>
                !selectedSpans.some(
                    (snapshot) => snapshot.start < span.end && snapshot.end > span.start,
                ),
        ),
        ...selectedSpans.map((snapshot) => ({
            ...snapshot,
            complete: true,
            segments: snapshot.path.map((candidate) => candidate.segment),
        })),
    ].sort((left, right) => left.start - right.start);
    let result = "";
    let offset = 0;

    // Bounded sequential resolution avoids command bursts in a large pasted prompt.
    for (const span of spans) {
        options.signal?.throwIfAborted();
        result += text.slice(offset, span.start);
        offset = span.end;

        const literal = text.slice(span.start, span.end);
        const source = sources.find((candidate) => candidate.id === span.sourceId);
        if (!span.complete || source === undefined) {
            result += literal;
            continue;
        }

        const selected = options.snapshots?.find(
            (snapshot) =>
                snapshot.sourceId === source.id &&
                snapshot.start === span.start &&
                snapshot.end === span.end &&
                snapshot.text === literal,
        );
        let resolution: Resolution;
        if (selected !== undefined) resolution = { status: "resolved", path: selected.path };
        else if (source.expansionPolicy === "selected-only") {
            result += literal;
            continue;
        } else {
            try {
                resolution = await source.resolve(span.segments, options.signal);
            } catch {
                options.signal?.throwIfAborted();
                result += literal;
                options.onUnresolved?.(source.id);
                continue;
            }
        }

        if (resolution.status !== "resolved") {
            result += literal;
            options.onUnresolved?.(source.id);
            continue;
        }

        const target = resolution.path.at(-1);
        if (target === undefined || !target.selectable) {
            result += literal;
            options.onUnresolved?.(source.id);
            continue;
        }

        try {
            let replacement = resolution.replacement ?? target.replacement ?? target.segment;
            if (source.replacement !== undefined) {
                replacement = await source.replacement(resolution.path, { signal: options.signal });
            } else if (source.replacementTemplate !== undefined) {
                replacement = renderReplacementTemplate(
                    source.replacementTemplate,
                    resolution.path,
                );
            }

            result += replacement;
        } catch {
            options.signal?.throwIfAborted();
            result += literal;
            options.onUnresolved?.(source.id);
        }
    }

    return result + text.slice(offset);
}

/** One pass over original user blocks. Memoized submissions survive context rebuilds/retries. */
export type MentionExpansion = {
    messages(
        messages: ContextEvent["messages"],
        sources: readonly ExpansionSource[],
        options?: {
            readonly signal?: AbortSignal;
            readonly snapshots?: readonly MentionSnapshot[];
            readonly onUnresolved?: (sourceId: string) => void;
        },
    ): Promise<ContextEvent["messages"]>;

    clear(): void;
};

export function createMentionExpansion(): MentionExpansion {
    const submissions = new Map<string, string>();
    const processed = new WeakSet<ContextEvent["messages"]>();
    const remember = (key: string, value: string): void => {
        submissions.set(key, value);
    };

    return {
        async messages(
            messages: ContextEvent["messages"],
            sources: readonly ExpansionSource[],
            options: {
                readonly signal?: AbortSignal;
                readonly snapshots?: readonly MentionSnapshot[];
                readonly onUnresolved?: (sourceId: string) => void;
            } = {},
        ): Promise<ContextEvent["messages"]> {
            if (processed.has(messages)) return messages;

            let changed = false;
            const activeKeys = new Set<string>();
            const expanded: ContextEvent["messages"] = [];
            let latestUser = -1;
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                if (messages[index]?.role !== "user") continue;
                latestUser = index;
                break;
            }

            for (const [messageIndex, message] of messages.entries()) {
                if (message.role !== "user") {
                    expanded.push(message);
                    continue;
                }

                let firstTextBlock = 0;
                if (Array.isArray(message.content)) {
                    firstTextBlock = message.content.findIndex((block) => block.type === "text");
                }

                const expandBlock = async (text: string, block: number): Promise<string> => {
                    const key = JSON.stringify([message.timestamp, block, text]);
                    activeKeys.add(key);

                    const cached = submissions.get(key);
                    if (cached !== undefined) {
                        activeKeys.add(JSON.stringify([message.timestamp, block, cached]));
                        return cached;
                    }

                    let snapshots: readonly MentionSnapshot[] | undefined;
                    if (messageIndex === latestUser && block === firstTextBlock) {
                        snapshots = options.snapshots;
                    }

                    const value = await expandMentionText(text, sources, {
                        ...options,
                        snapshots,
                    });
                    remember(key, value);

                    // A subsequent context handler must not reinterpret generated text.
                    const generatedKey = JSON.stringify([message.timestamp, block, value]);
                    remember(generatedKey, value);
                    activeKeys.add(generatedKey);

                    return value;
                };
                if (!Array.isArray(message.content)) {
                    const content = await expandBlock(message.content, 0);
                    changed ||= content !== message.content;

                    if (content === message.content) expanded.push(message);
                    else expanded.push({ ...message, content });
                } else {
                    let blockChanged = false;
                    const content: typeof message.content = [];
                    for (const [index, block] of message.content.entries()) {
                        if (block.type !== "text") {
                            content.push(block);
                            continue;
                        }

                        const text = await expandBlock(block.text, index);
                        blockChanged ||= text !== block.text;

                        if (text === block.text) content.push(block);
                        else content.push({ ...block, text });
                    }

                    changed ||= blockChanged;

                    if (blockChanged) expanded.push({ ...message, content });
                    else expanded.push(message);
                }
            }

            // Keep all active-context resolutions; only the historical tail is bounded.
            let historical = submissions.size - activeKeys.size;
            for (const key of submissions.keys()) {
                if (historical <= 512) break;
                if (activeKeys.has(key)) continue;
                submissions.delete(key);
                historical -= 1;
            }

            let result = messages;
            if (changed) result = expanded;
            processed.add(result);

            return result;
        },
        clear(): void {
            submissions.clear();
        },
    };
}
