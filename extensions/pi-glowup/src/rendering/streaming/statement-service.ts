import { Worker } from "node:worker_threads";
import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { MAX_SCRIPT_PREVIEW_ENTRIES } from "../../tools/built-in/bash/preview-store.ts";
import type { StatementRequest, StatementResponse } from "./statement-worker.ts";
import { recordRenderError } from "../../diagnostics/render-events.ts";

declare global {
    interface ImportMeta {
        readonly glowupStatementWorker?: string;
    }
}

type Job = {
    readonly request: StatementRequest;
    readonly signal: AbortSignal;
    readonly resolve: (response: StatementResponse | undefined) => void;
    readonly cancel: () => void;
};

/** One lazy worker per store, bounded queue, explicit failure diagnostics, and no UI-thread parsing. */
export function createStatementService() {
    const queue: Job[] = [];
    let worker: Worker | undefined;
    let active: Job | undefined;
    let nextId = 0;
    let disposed = false;
    let failed = false;
    let stopping: Promise<number> | undefined;

    function finish(job: Job, response: StatementResponse | undefined): void {
        job.signal.removeEventListener("abort", job.cancel);
        job.resolve(response);
    }

    function stop(): void {
        const previous = worker;
        worker = undefined;

        if (previous !== undefined) stopping = previous.terminate();
    }

    function fail(): void {
        if (failed || disposed) return;

        failed = true;

        if (active !== undefined) finish(active, undefined);
        active = undefined;

        for (const job of queue.splice(0)) finish(job, undefined);
        stop();
        reportExtensionDiagnostic(
            "[pi-glowup] Statement parser unavailable (worker or WASM asset failure); unfinished code is held until completion. Reload to retry.",
        );
    }

    function dispatch(): void {
        if (disposed || failed || active !== undefined) return;

        const job = queue.shift();
        if (job === undefined) {
            worker?.unref();
            return;
        }

        active = job;

        try {
            if (worker === undefined) {
                const current = new Worker(
                    new URL(
                        import.meta.glowupStatementWorker ?? "./statement-worker.ts",
                        import.meta.url,
                    ),
                    { execArgv: [] },
                );
                worker = current;
                current.on("error", () => {
                    if (worker === current) fail();
                });

                current.on("exit", () => {
                    if (worker === current) fail();
                });

                current.on("message", (response: StatementResponse) => {
                    if (worker !== current || active?.request.id !== response.id) return;

                    const completed = active;
                    active = undefined;

                    if ("error" in response) {
                        finish(completed, undefined);
                        fail();
                    } else {
                        finish(completed, response);
                        dispatch();
                    }
                });
            }

            worker.ref();
            worker.postMessage(job.request);
        } catch (cause: unknown) {
            recordRenderError("statement.worker-dispatch", cause);
            fail();
        }
    }

    return {
        async parse(
            source: string,
            language: string,
            complete: boolean,
            signal: AbortSignal,
        ): Promise<StatementResponse | undefined> {
            if (disposed || failed || signal.aborted) return Promise.resolve(undefined);

            if (queue.length >= MAX_SCRIPT_PREVIEW_ENTRIES) {
                reportExtensionDiagnostic(
                    "[pi-glowup] Statement parser capacity exceeded; unfinished code is held until completion.",
                );
                return Promise.resolve(undefined);
            }

            return new Promise((resolve) => {
                const job: Job = {
                    request: { id: ++nextId, source, language, complete },
                    signal,
                    resolve,
                    cancel: () => {
                        const index = queue.indexOf(job);
                        if (index >= 0) queue.splice(index, 1);

                        // Active parsing cannot be interrupted, but the caller need not wait
                        // for it and its response cannot publish into a newer generation.
                        finish(job, undefined);
                    },
                };

                signal.addEventListener("abort", job.cancel, { once: true });
                queue.push(job);
                dispatch();
            });
        },
        async dispose(): Promise<void> {
            disposed = true;

            if (active !== undefined) finish(active, undefined);
            active = undefined;

            for (const job of queue.splice(0)) finish(job, undefined);
            stop();
            await stopping;
        },
    };
}
