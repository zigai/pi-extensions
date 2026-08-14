import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { AutocompleteItem, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import {
    getTypedArgumentCompletions as resolveTypedArgumentCompletions,
    getTypedAutocompleteSuggestionsAsync as resolveTypedAutocompleteSuggestions,
    type CompletionCapabilities,
    type CompletionDecision,
    type CompletionScheduler,
    type CompletionTaskOwner,
} from "../completions.js";
import type { TypedCommandLookup } from "../registry.js";
import type { ArgumentDefinitions, TypedCompletionItem } from "../types.js";
import type { RegisteredTypedCommand } from "./command-types.js";

class PiCompletionScheduler implements CompletionScheduler {
    constructor(private readonly parentSignal?: AbortSignal) {}

    async run<T>(
        work: (signal: AbortSignal) => Promise<T>,
        timeoutMs: number | undefined,
    ): Promise<T | undefined> {
        if (this.parentSignal?.aborted === true) {
            return undefined;
        }
        const controller = new AbortController();
        const abort = (): void => {
            controller.abort(this.parentSignal?.reason);
        };
        this.parentSignal?.addEventListener("abort", abort, { once: true });

        let timer: NodeJS.Timeout | undefined;
        if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
                controller.abort();
            }, timeoutMs);
        }
        try {
            const aborted = new Promise<undefined>((resolve) => {
                controller.signal.addEventListener("abort", () => resolve(undefined), {
                    once: true,
                });
            });
            return await Promise.race([work(controller.signal), aborted]);
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

class PiCompletionTaskOwner implements CompletionTaskOwner {
    private readonly pending = new Set<Promise<unknown>>();

    own(task: Promise<unknown>): void {
        this.pending.add(task);
        void task.then(
            () => {
                this.pending.delete(task);
            },
            () => {
                this.pending.delete(task);
            },
        );
    }
}

async function completePathItems(query: string, cwd: string): Promise<TypedCompletionItem[]> {
    const raw = query;
    let directoryPart = dirname(raw);
    let filePrefix = basename(raw);
    if (raw.endsWith("/")) {
        directoryPart = raw;
        filePrefix = "";
    }
    let lookupDirectory = join(cwd, directoryPart);
    if (isAbsolute(directoryPart)) {
        lookupDirectory = directoryPart;
    }
    let valuePrefix = "";
    if (raw.endsWith("/")) {
        valuePrefix = raw;
    } else if (directoryPart !== ".") {
        valuePrefix = `${directoryPart}/`;
    }

    const entries = await readdir(lookupDirectory, { withFileTypes: true });
    const matchingEntries = entries
        .filter((entry) => entry.name.startsWith(filePrefix) && !/\p{Cc}/u.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    return Promise.all(
        matchingEntries.map(async (entry) => {
            let isDirectory = entry.isDirectory();
            if (!isDirectory && entry.isSymbolicLink()) {
                try {
                    isDirectory = (await stat(join(lookupDirectory, entry.name))).isDirectory();
                } catch {
                    // Keep broken or inaccessible symbolic links as ordinary path candidates.
                }
            }
            let suffix = "";
            let description = "file";
            if (isDirectory) {
                suffix = "/";
                description = "directory";
            }
            return {
                value: `${valuePrefix}${entry.name}${suffix}`,
                label: `${entry.name}${suffix}`,
                description,
            };
        }),
    );
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
            complete: completePathItems,
        },
        scheduler: new PiCompletionScheduler(signal),
        completionTasks: new PiCompletionTaskOwner(),
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

function toAutocompleteSuggestions(decision: CompletionDecision): AutocompleteSuggestions {
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
    if (items === null) {
        return null;
    }
    return items.map(toAutocompleteItem);
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
    if (decision === undefined) {
        return undefined;
    }
    return toAutocompleteSuggestions(decision);
}
