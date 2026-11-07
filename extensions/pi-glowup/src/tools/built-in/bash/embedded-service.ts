import {
    createStatementService,
    MAX_STATEMENT_SOURCE_BYTES,
} from "../../../rendering/streaming/statement-service.ts";
import type { EmbeddedProgram } from "./embedded-programs.ts";
import { recordRenderError } from "../../../diagnostics/render-events.ts";

function aborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

export type EmbeddedProgramLookup = ((
    source: string,
    invalidate?: () => void,
) => readonly EmbeddedProgram[] | undefined) & {
    readonly isCurrent?: (source: string, programs: readonly EmbeddedProgram[]) => boolean;
};

type Entry = {
    readonly controller: AbortController;
    readonly invalidations: Set<() => void>;
    readonly bytes: number;
    readonly completion: Promise<void>;
    readonly complete: () => void;
    programs: readonly EmbeddedProgram[] | undefined;
    settled: boolean;
};

export function createEmbeddedProgramService(parser = createStatementService()) {
    const entries = new Map<string, Entry>();
    const jobs = new Set<Promise<void>>();
    let active: Entry | undefined;
    let disposed = false;
    let retainedBytes = 0;
    let generation = 0;

    function remove(source: string, entry: Entry): void {
        entries.delete(source);

        // An active worker still owns its source until its response arrives. Do not
        // cancel it and immediately submit another job against that same capacity.
        if (entry !== active) retainedBytes -= entry.bytes;
        entry.invalidations.clear();
        entry.complete();
    }

    function publish(
        source: string,
        entry: Entry,
        programs: readonly EmbeddedProgram[] | undefined,
    ): void {
        if (disposed || entries.get(source) !== entry) return;

        entry.programs = programs;
        entry.settled = true;
        for (const notify of entry.invalidations) {
            try {
                notify();
            } catch (cause: unknown) {
                recordRenderError("bash.embedded-invalidate", cause);
            }
        }

        entry.invalidations.clear();
    }

    function pump(): void {
        if (disposed || active !== undefined) return;

        for (const [source, entry] of entries) {
            if (entry.settled) continue;
            active = entry;

            // Serialize admission, not extraction semantics. Pending demand is bounded
            // here, so the parser's capacity rejection cannot become a cached result.
            const job = parser
                .extract(source, entry.controller.signal)
                .then(
                    (programs) => publish(source, entry, programs),
                    (cause: unknown) => {
                        recordRenderError("bash.embedded-extract", cause);
                        publish(source, entry, undefined);
                    },
                )
                .finally(() => {
                    if (entries.get(source) !== entry) retainedBytes -= entry.bytes;
                    active = undefined;
                    entry.complete();
                    jobs.delete(job);

                    // Keep a single oversized demanded source valid, as before; byte
                    // budgets bound competing demand, never truncate a script.
                    for (const [olderSource, older] of entries) {
                        if (entries.size <= 1 || retainedBytes <= 2 * MAX_STATEMENT_SOURCE_BYTES)
                            break;

                        remove(olderSource, older);
                    }

                    pump();
                });

            jobs.add(job);

            return;
        }
    }

    function get(source: string, invalidate?: () => void): readonly EmbeddedProgram[] | undefined {
        if (disposed) return undefined;

        let entry = entries.get(source);
        if (entry === undefined) {
            const bytes = Buffer.byteLength(source, "utf8");

            for (const [previousSource, previous] of entries) {
                if (entries.size < 300 && retainedBytes + bytes <= 2 * MAX_STATEMENT_SOURCE_BYTES)
                    break;

                if (previous === active) continue;
                remove(previousSource, previous);
            }

            let complete: () => void = () => {};
            const completion = new Promise<void>((resolve) => {
                complete = resolve;
            });

            entry = {
                controller: new AbortController(),
                invalidations: new Set(),
                bytes,
                programs: undefined,
                settled: false,
                completion,
                complete,
            };
            entries.set(source, entry);
            retainedBytes += bytes;
        }

        // Repeated demand refreshes recency too; a hot pending preview must not
        // be evicted merely because its first request was old.
        entries.delete(source);
        entries.set(source, entry);

        if (invalidate !== undefined && !entry.settled) entry.invalidations.add(invalidate);
        pump();

        return entry.programs;
    }

    async function resolve(
        source: string,
        signal: AbortSignal,
    ): Promise<readonly EmbeddedProgram[] | undefined> {
        if (signal.aborted) return undefined;

        get(source);

        const entry = entries.get(source);
        const currentGeneration = generation;

        if (entry === undefined) return undefined;

        let abort: () => void = () => {};
        const cancelled = new Promise<void>((resolve) => {
            abort = resolve;
        });

        signal.addEventListener("abort", abort, { once: true });

        try {
            await Promise.race([entry.completion, cancelled]);
        } finally {
            signal.removeEventListener("abort", abort);
        }

        if (aborted(signal) || disposed || generation !== currentGeneration) return undefined;
        return entry.programs;
    }

    function clear(): void {
        generation++;

        for (const [source, entry] of entries) remove(source, entry);
    }

    async function dispose(): Promise<void> {
        if (disposed) return;

        disposed = true;
        clear();
        await parser.dispose();
        await settled();
    }

    async function settled(): Promise<void> {
        while (jobs.size > 0) await Promise.all(jobs);
    }

    return {
        get,
        resolve,
        clear,
        dispose,
        settled,
        isCurrent: (source: string, programs: readonly EmbeddedProgram[]) =>
            entries.get(source)?.programs === programs,
    };
}
