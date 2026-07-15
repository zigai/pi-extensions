import { readdir } from "node:fs/promises";
import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import {
    getTypedArgumentCompletions as resolveTypedArgumentCompletions,
    getTypedAutocompleteSuggestionsAsync as resolveTypedAutocompleteSuggestions,
    type CompletionCapabilities,
    type CompletionDecision,
    type CompletionScheduler,
} from "../completions.js";
import type { TypedCommandLookup } from "../registry.js";
import type {
    ArgumentDefinitions,
    RegisteredTypedCommand,
    TypedCompletionItem,
} from "../types.js";

class PiCompletionScheduler implements CompletionScheduler {
    constructor(private readonly parentSignal?: AbortSignal) {}

    async run<T>(
        work: (signal: AbortSignal) => Promise<T>,
        timeoutMs: number | undefined,
    ): Promise<T | undefined> {
        const controller = new AbortController();
        const abort = (): void => {
            controller.abort(this.parentSignal?.reason);
        };
        if (this.parentSignal?.aborted === true) {
            abort();
        } else {
            this.parentSignal?.addEventListener("abort", abort, { once: true });
        }

        let timer: NodeJS.Timeout | undefined;
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
                controller.abort();
            }, timeoutMs);
        }
        try {
            return await Promise.race([
                work(controller.signal),
                new Promise<undefined>((resolve) => {
                    controller.signal.addEventListener("abort", () => resolve(undefined), {
                        once: true,
                    });
                }),
            ]);
        } catch {
            return undefined;
        } finally {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            this.parentSignal?.removeEventListener("abort", abort);
        }
    }
}

/** Compose completion decisions with Pi/Node filesystem, cancellation, and registry adapters. */
export function createPiCompletionCapabilities(
    cwd: string,
    commands: TypedCommandLookup,
    signal?: AbortSignal,
): CompletionCapabilities {
    return {
        cwd,
        commands,
        paths: {
            async list(directory) {
                const entries = await readdir(directory, { withFileTypes: true });
                return entries.map((entry) => ({
                    name: entry.name,
                    directory: entry.isDirectory(),
                }));
            },
        },
        scheduler: new PiCompletionScheduler(signal),
    };
}

function toAutocompleteItem(item: TypedCompletionItem): AutocompleteItem {
    const result: AutocompleteItem = {
        value: item.value,
        label: item.label ?? item.value,
    };
    if (item.description !== undefined) {
        result.description = item.description;
    }
    return result;
}

function toAutocompleteSuggestions(
    decision: CompletionDecision,
): AutocompleteSuggestions {
    return {
        items: decision.items.map(toAutocompleteItem),
        prefix: decision.prefix,
    };
}

/** Pi command-hook projection for library-owned completion results. */
export async function getTypedArgumentCompletions<TDefinitions extends ArgumentDefinitions>(
    command: RegisteredTypedCommand<TDefinitions>,
    argumentPrefix: string,
    capabilities: CompletionCapabilities,
): Promise<AutocompleteItem[] | null> {
    const items = await resolveTypedArgumentCompletions(command, argumentPrefix, capabilities);
    return items === null ? null : items.map(toAutocompleteItem);
}

/** Pi editor projection for library-owned completion decisions. */
export async function getTypedAutocompleteSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    capabilities: CompletionCapabilities,
): Promise<AutocompleteSuggestions | undefined> {
    const decision = await resolveTypedAutocompleteSuggestions(
        lines,
        cursorLine,
        cursorCol,
        capabilities,
    );
    return decision === undefined ? undefined : toAutocompleteSuggestions(decision);
}
