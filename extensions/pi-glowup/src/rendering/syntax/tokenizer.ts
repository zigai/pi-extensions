import { Worker } from "node:worker_threads";
import type { BundledLanguage, ThemeRegistration } from "shiki";
import type { TokenizeRequest, TokenizeResponse } from "./tokenize-worker.ts";

declare global {
    interface ImportMeta {
        readonly glowupSyntaxWorker?: string;
    }
}

type Work = {
    readonly request: TokenizeRequest;
    readonly bytes: number;
    readonly resolve: (lines: string[] | undefined) => void;
    readonly signal: AbortSignal | undefined;
    readonly cancel: () => void;
};

export function createSyntaxTokenizer(
    theme: ThemeRegistration,
    options: {
        readonly maxJobs: number;
        readonly maxBytes: number;
        readonly reportWarning: ((message: string) => void) | undefined;
        readonly waitForDisposals: () => Promise<void>;
    },
) {
    const queue: Work[] = [];
    const terminations = new Set<Promise<number>>();
    let active: Work | undefined;
    let worker: Worker | undefined;
    let starting: Promise<void> | undefined;
    let nextId = 0;
    let bytes = 0;
    let disposed = false;
    let failed = false;

    function finish(work: Work, lines: string[] | undefined): void {
        bytes -= work.bytes;
        work.signal?.removeEventListener("abort", work.cancel);
        work.resolve(lines);
    }

    function stopWorker(): void {
        const previous = worker;
        worker = undefined;

        if (previous === undefined) return;

        const termination = previous.terminate();
        terminations.add(termination);
        void termination
            .then(() => {
                terminations.delete(termination);
                dispatch();
            })
            .catch(() => {
                terminations.delete(termination);
                fail();
            });
    }

    function fail(): void {
        if (failed || disposed) return;

        failed = true;

        if (active !== undefined) finish(active, undefined);
        active = undefined;

        for (const work of queue.splice(0)) finish(work, undefined);
        stopWorker();
        options.reportWarning?.("[pi-glowup] Syntax worker failed; reload to retry highlighting");
    }

    async function startWorker(): Promise<void> {
        try {
            await options.waitForDisposals();

            if (disposed || failed || queue.length === 0) return;

            const current = new Worker(
                new URL(import.meta.glowupSyntaxWorker ?? "./tokenize-worker.ts", import.meta.url),
                { execArgv: [] },
            );
            worker = current;
            current.on("error", () => {
                if (worker === current) fail();
            });

            current.on("exit", () => {
                if (worker === current) fail();
            });

            current.on("message", (response: TokenizeResponse) => {
                if (worker !== current || active?.request.id !== response.id) return;

                const completed = active;
                active = undefined;

                if ("error" in response) {
                    finish(completed, undefined);
                    fail();
                } else {
                    finish(completed, response.lines);
                    dispatch();
                }
            });
        } catch {
            fail();
        }
    }

    function dispatch(): void {
        if (
            disposed ||
            failed ||
            active !== undefined ||
            terminations.size > 0 ||
            starting !== undefined
        )
            return;

        if (queue.length === 0) {
            worker?.unref();
            return;
        }

        if (worker === undefined) {
            const start = startWorker();
            starting = start;
            void start.then(
                () => {
                    if (starting === start) starting = undefined;
                    dispatch();
                },
                () => {
                    if (starting === start) starting = undefined;
                    fail();
                },
            );

            return;
        }

        const work = queue.shift();
        if (work === undefined) return;

        active = work;

        try {
            worker.ref();
            worker.postMessage(work.request);
        } catch {
            fail();
        }
    }

    async function tokenize(
        code: string,
        language: BundledLanguage,
        brackets: boolean,
        cancellation: { readonly signal?: AbortSignal } = {},
    ): Promise<string[] | undefined> {
        const size = Buffer.byteLength(code, "utf8");
        if (
            disposed ||
            failed ||
            cancellation.signal?.aborted === true ||
            queue.length + Number(active !== undefined) >= options.maxJobs ||
            bytes + size > options.maxBytes
        )
            return undefined;

        return new Promise((resolve) => {
            const work: Work = {
                request: { id: nextId++, code, language, theme, brackets },
                bytes: size,
                resolve,
                signal: cancellation.signal,
                cancel: () => {
                    if (active === work) {
                        active = undefined;
                        finish(work, undefined);
                        stopWorker();
                        dispatch();
                        return;
                    }

                    const index = queue.indexOf(work);
                    if (index >= 0) {
                        queue.splice(index, 1);
                        finish(work, undefined);
                    }
                },
            };

            bytes += size;
            cancellation.signal?.addEventListener("abort", work.cancel, { once: true });
            queue.push(work);
            dispatch();
        });
    }

    async function dispose(): Promise<void> {
        disposed = true;

        if (active !== undefined) finish(active, undefined);
        active = undefined;

        for (const work of queue.splice(0)) finish(work, undefined);
        stopWorker();

        const closing: Array<Promise<number | void>> = [...terminations];
        if (starting !== undefined) closing.push(starting);
        await Promise.allSettled(closing);
    }

    return { tokenize, dispose };
}
