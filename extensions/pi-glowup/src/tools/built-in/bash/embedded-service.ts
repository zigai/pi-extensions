import { createStatementService } from "../../../rendering/streaming/statement-service.ts";
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
    programs: readonly EmbeddedProgram[] | undefined;
    settled: boolean;
    completion: Promise<void>;
};

export function createEmbeddedProgramService() {
    const parser = createStatementService();
    const entries = new Map<string, Entry>();
    const jobs = new Set<Promise<void>>();
    let disposed = false;
    let retainedCharacters = 0;
    let generation = 0;

    function trim(current: Entry): void {
        for (const [source, entry] of entries) {
            if (entries.size <= 300 && retainedCharacters <= 4 * 1024 * 1024) break;
            if (entry === current || !entry.settled) continue;
            entries.delete(source);
            retainedCharacters -= source.length;
        }
    }

    function publish(
        source: string,
        entry: Entry,
        programs: readonly EmbeddedProgram[] | undefined,
    ): void {
        if (disposed || entry.controller.signal.aborted || entries.get(source) !== entry) return;

        entry.programs = programs;
        entry.settled = true;
        trim(entry);

        for (const notify of entry.invalidations) {
            try {
                notify();
            } catch (cause: unknown) {
                recordRenderError("bash.embedded-invalidate", cause);
            }
        }

        entry.invalidations.clear();
    }

    function get(source: string, invalidate?: () => void): readonly EmbeddedProgram[] | undefined {
        if (disposed) return undefined;

        let entry = entries.get(source);
        if (entry === undefined) {
            entry = {
                controller: new AbortController(),
                invalidations: new Set(),
                programs: undefined,
                settled: false,
                completion: Promise.resolve(),
            };
            entries.set(source, entry);
            retainedCharacters += source.length;

            const current = entry;
            const job = parser.extract(source, current.controller.signal).then(
                (programs) => publish(source, current, programs),
                (cause: unknown) => {
                    recordRenderError("bash.embedded-extract", cause);
                    publish(source, current, undefined);
                },
            );

            current.completion = job;
            jobs.add(job);
            void job.then(() => jobs.delete(job));
        }

        if (invalidate !== undefined && !entry.settled) entry.invalidations.add(invalidate);
        return entry.programs;
    }

    async function resolve(
        source: string,
        signal: AbortSignal,
    ): Promise<readonly EmbeddedProgram[] | undefined> {
        get(source);

        const entry = entries.get(source);
        const currentGeneration = generation;

        if (entry === undefined || signal.aborted) return undefined;

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

        for (const entry of entries.values()) entry.controller.abort();
        entries.clear();
        retainedCharacters = 0;
    }

    async function dispose(): Promise<void> {
        if (disposed) return;

        disposed = true;
        clear();
        await parser.dispose();
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
