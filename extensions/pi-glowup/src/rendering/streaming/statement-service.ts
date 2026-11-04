import { Worker } from "node:worker_threads";
import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { MAX_SCRIPT_PREVIEW_ENTRIES } from "../../tools/built-in/bash/preview-store.ts";
import type { StatementResponse, WorkerRequest, WorkerResponse } from "./statement-worker.ts";
import type { EmbeddedProgram } from "../../tools/built-in/bash/embedded-programs.ts";
import { recordRenderError } from "../../diagnostics/render-events.ts";

declare global {
    interface ImportMeta {
        readonly glowupStatementWorker?: string;
    }
}

/** Competing source budget; an idle worker still accepts one larger source without truncation. */
export const MAX_STATEMENT_SOURCE_BYTES = 4 * 1024 * 1024;

type Job = {
    readonly bytes: number;
    settled: boolean;
    readonly request: WorkerRequest;
    readonly signal: AbortSignal;
    readonly resolve: (response: WorkerResponse | undefined) => void;
    readonly cancel: () => void;
};

type StatementWorker = {
    on(event: "message", listener: (response: WorkerResponse) => void): void;
    on(event: "error" | "exit", listener: () => void): void;
    ref(): void;
    unref(): void;
    postMessage(request: WorkerRequest): void;
    terminate(): Promise<number>;
};

/** One lazy worker per store, bounded queue, explicit failure diagnostics, and no UI-thread parsing. */
export function createStatementService(
    createWorker: () => StatementWorker = () =>
        new Worker(
            new URL(import.meta.glowupStatementWorker ?? "./statement-worker.ts", import.meta.url),
            { execArgv: [] },
        ),
) {
    const queue: Job[] = [];
    let worker: ReturnType<typeof createWorker> | undefined;
    let active: Job | undefined;
    let nextId = 0;
    let disposed = false;
    let failed = false;
    let retainedBytes = 0;
    let stopping: Promise<number> | undefined;

    function finish(job: Job, response: WorkerResponse | undefined): void {
        if (job.settled) return;

        job.settled = true;
        job.signal.removeEventListener("abort", job.cancel);
        job.resolve(response);
    }

    function release(job: Job): void {
        retainedBytes -= job.bytes;
    }

    function admits(source: string): boolean {
        let count = queue.length;
        if (active !== undefined) count++;

        return (
            count < MAX_SCRIPT_PREVIEW_ENTRIES &&
            (count === 0 ||
                retainedBytes + Buffer.byteLength(source, "utf8") <= MAX_STATEMENT_SOURCE_BYTES)
        );
    }

    function stop(): void {
        const previous = worker;
        worker = undefined;

        if (previous !== undefined) stopping = previous.terminate();
    }

    function fail(): void {
        if (failed || disposed) return;

        failed = true;

        if (active !== undefined) {
            release(active);
            finish(active, undefined);
        }

        active = undefined;

        for (const job of queue.splice(0)) {
            release(job);
            finish(job, undefined);
        }

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
                const current = createWorker();
                worker = current;
                current.on("error", () => {
                    if (worker === current) fail();
                });

                current.on("exit", () => {
                    if (worker === current) fail();
                });

                current.on("message", (response: WorkerResponse) => {
                    if (worker !== current || active?.request.id !== response.id) return;

                    const completed = active;
                    active = undefined;
                    release(completed);

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

            if (!admits(source)) {
                reportExtensionDiagnostic(
                    "[pi-glowup] Statement parser capacity exceeded; unfinished code is held until completion.",
                );
                return Promise.resolve(undefined);
            }

            return new Promise((resolve) => {
                const job: Job = {
                    bytes: Buffer.byteLength(source, "utf8"),
                    settled: false,
                    request: { id: ++nextId, source, language, complete },
                    signal,
                    resolve: (response) => {
                        if (response === undefined || !("kind" in response)) resolve(response);
                        else resolve(undefined);
                    },
                    cancel: () => {
                        const index = queue.indexOf(job);
                        if (index >= 0) {
                            queue.splice(index, 1);
                            release(job);
                        }

                        // Active parsing cannot be interrupted, but the caller need not wait
                        // for it and its response cannot publish into a newer generation.
                        finish(job, undefined);
                    },
                };

                signal.addEventListener("abort", job.cancel, { once: true });
                retainedBytes += job.bytes;
                queue.push(job);
                dispatch();
            });
        },
        async extract(source: string, signal: AbortSignal): Promise<EmbeddedProgram[] | undefined> {
            if (disposed || failed || signal.aborted || !admits(source)) return undefined;
            return new Promise((resolve) => {
                const job: Job = {
                    bytes: Buffer.byteLength(source, "utf8"),
                    settled: false,
                    request: { id: ++nextId, kind: "embedded", source },
                    signal,
                    resolve: (response) => {
                        if (response !== undefined && "kind" in response) {
                            resolve(response.programs);
                        } else {
                            if (response !== undefined && "error" in response) {
                                recordRenderError(
                                    "bash.embedded-extraction",
                                    new Error(response.error),
                                );

                                reportExtensionDiagnostic(
                                    "[pi-glowup] Embedded Bash program extraction failed.",
                                );
                            }

                            resolve(undefined);
                        }
                    },
                    cancel: () => {
                        const index = queue.indexOf(job);
                        if (index >= 0) {
                            queue.splice(index, 1);
                            release(job);
                        }

                        finish(job, undefined);
                    },
                };

                signal.addEventListener("abort", job.cancel, { once: true });
                retainedBytes += job.bytes;
                queue.push(job);
                dispatch();
            });
        },
        async dispose(): Promise<void> {
            disposed = true;

            if (active !== undefined) {
                release(active);
                finish(active, undefined);
            }

            active = undefined;

            for (const job of queue.splice(0)) {
                release(job);
                finish(job, undefined);
            }

            stop();
            await stopping;
        },
    };
}
