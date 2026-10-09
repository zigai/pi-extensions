import {
    type AutocompleteItem,
    type AutocompleteProvider,
    type AutocompleteSuggestions,
    fuzzyFilter,
} from "@earendil-works/pi-tui";

import {
    autocompleteTriggerCharacter,
    extractMentionPrefix,
    formatMention,
    type MentionPrefix,
} from "./mention-syntax.ts";
import {
    rankWithSelectionHistory,
    type InitialSuggestions,
    type SelectionHistory,
} from "./initial-suggestions.ts";

type MentionCompletion = ReturnType<AutocompleteProvider["applyCompletion"]>;

type SuggestionOptions = {
    readonly signal: AbortSignal;
    readonly force?: boolean;
    readonly query?: string;
};

export type MentionAutocompleteOptions<T> = {
    readonly current: AutocompleteProvider;
    readonly trigger: string;
    readonly completionSuffix: string;
    readonly initialSuggestions: InitialSuggestions;
    readonly history?: SelectionHistory;
    readonly loadItems: (options: SuggestionOptions) => readonly T[] | Promise<readonly T[]>;
    readonly filtering?: "local" | "provider";
    readonly nameOf: (item: T) => string;
    readonly labelOf?: (item: T) => string;
    readonly descriptionOf?: (item: T) => string | undefined;
    readonly searchTextOf?: (item: T) => string;
    readonly formatValue?: (item: T, trigger: string) => string;

    readonly extractPrefix?: (
        textBeforeCursor: string,
        trigger: string,
    ) => MentionPrefix | undefined;

    readonly initialPriorityOf?: (item: T) => number;
    readonly onSelection?: (item: T) => void;

    readonly transformFallback?: (
        suggestions: AutocompleteSuggestions | null,
    ) => AutocompleteSuggestions | null;
};

function completionSuffixFor(afterCursor: string, completionSuffix: string): string {
    if (completionSuffix.length === 0) return "";
    if (afterCursor.length === 0) return completionSuffix;
    if (/^\s/.test(completionSuffix) && /^\s/.test(afterCursor)) return "";
    return completionSuffix;
}

function lastLineLength(lines: string[]): number {
    const lastLine = lines.at(-1);
    if (lastLine === undefined) return 0;
    return lastLine.length;
}

function applyMentionCompletion(
    lines: string[],
    cursorLine: number,
    beforePrefix: string,
    value: string,
    suffix: string,
    afterCursor: string,
): MentionCompletion {
    const textBeforeCursor = `${beforePrefix}${value}${suffix}`;
    const replacementLines = `${textBeforeCursor}${afterCursor}`.split("\n");
    const cursorLines = textBeforeCursor.split("\n");

    return {
        lines: [...lines.slice(0, cursorLine), ...replacementLines, ...lines.slice(cursorLine + 1)],
        cursorLine: cursorLine + cursorLines.length - 1,
        cursorCol: lastLineLength(cursorLines),
    };
}

function itemDescription<T>(item: T, options: MentionAutocompleteOptions<T>): string | undefined {
    return options.descriptionOf?.(item);
}

function itemSearchText<T>(item: T, options: MentionAutocompleteOptions<T>): string {
    if (options.searchTextOf !== undefined) return options.searchTextOf(item);

    const description = itemDescription(item, options);
    if (description === undefined) return options.nameOf(item);
    return `${options.nameOf(item)} ${description}`;
}

function itemValue<T>(item: T, options: MentionAutocompleteOptions<T>): string {
    if (options.formatValue !== undefined) return options.formatValue(item, options.trigger);
    return formatMention(options.nameOf(item), options.trigger);
}

function itemLabel<T>(item: T, options: MentionAutocompleteOptions<T>): string {
    if (options.labelOf !== undefined) return options.labelOf(item);
    return options.nameOf(item);
}

function toAutocompleteItem<T>(item: T, options: MentionAutocompleteOptions<T>): AutocompleteItem {
    const result: AutocompleteItem = {
        value: itemValue(item, options),
        label: itemLabel(item, options),
    };
    const description = itemDescription(item, options);
    if (description !== undefined) result.description = description;

    return result;
}

async function filterItems<T>(
    items: readonly T[],
    query: string,
    options: MentionAutocompleteOptions<T>,
): Promise<AutocompleteItem[]> {
    if (query.length === 0 || options.filtering === "provider") {
        let ranked = items;
        if (query.length === 0) {
            ranked = await rankWithSelectionHistory(
                items,
                options.nameOf,
                options.initialSuggestions,
                options.history,
                options.initialPriorityOf,
            );
        }

        return ranked.map((item) => toAutocompleteItem(item, options));
    }

    return fuzzyFilter([...items], query, (item) => itemSearchText(item, options)).map((item) =>
        toAutocompleteItem(item, options),
    );
}

export function createMentionAutocompleteProvider<T>(
    options: MentionAutocompleteOptions<T>,
): AutocompleteProvider {
    const { current, trigger, completionSuffix } = options;
    let completionItems = new Map<string, T>();

    const fallback = async (
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        suggestionOptions: SuggestionOptions,
    ): Promise<AutocompleteSuggestions | null> => {
        const suggestions = await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            suggestionOptions,
        );
        if (options.transformFallback === undefined) return suggestions;
        return options.transformFallback(suggestions);
    };

    return {
        triggerCharacters: [autocompleteTriggerCharacter(trigger)],

        async getSuggestions(lines, cursorLine, cursorCol, suggestionOptions) {
            const line = lines[cursorLine] ?? "";
            const beforeCursor = line.slice(0, cursorCol);
            let mention: MentionPrefix | undefined;
            if (options.extractPrefix === undefined) {
                mention = extractMentionPrefix(beforeCursor, trigger);
            } else {
                mention = options.extractPrefix(beforeCursor, trigger);
            }

            if (mention === undefined || suggestionOptions.signal.aborted) {
                return fallback(lines, cursorLine, cursorCol, suggestionOptions);
            }

            const items = await options.loadItems({ ...suggestionOptions, query: mention.query });
            if (suggestionOptions.signal.aborted || items.length === 0) {
                return fallback(lines, cursorLine, cursorCol, suggestionOptions);
            }

            const suggestions = await filterItems(items, mention.query, options);
            if (suggestionOptions.signal.aborted || suggestions.length === 0) {
                return fallback(lines, cursorLine, cursorCol, suggestionOptions);
            }

            completionItems = new Map();
            for (const candidate of items) {
                const label = itemLabel(candidate, options);
                if (!completionItems.has(label)) completionItems.set(label, candidate);
            }

            return { prefix: mention.prefix, items: suggestions };
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            if (!prefix.startsWith(trigger)) {
                return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
            }

            const currentLine = lines[cursorLine] ?? "";
            const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
            const afterCursor = currentLine.slice(cursorCol);
            const suffix = completionSuffixFor(afterCursor, completionSuffix);

            options.history?.recordSelection(item.label);

            const selectedItem = completionItems.get(item.label);
            if (selectedItem !== undefined) options.onSelection?.(selectedItem);
            return applyMentionCompletion(
                lines,
                cursorLine,
                beforePrefix,
                item.value,
                suffix,
                afterCursor,
            );
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
    };
}
