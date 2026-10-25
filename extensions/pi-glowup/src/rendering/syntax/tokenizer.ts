import { Worker } from "node:worker_threads";
import type { BundledLanguage, ThemeRegistration } from "shiki";
import type {
    TokenizeInitialization,
    TokenizeRequest,
    TokenizeResponse,
} from "./tokenize-worker.ts";

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

type TokenizeCancellation = {
    readonly signal?: AbortSignal;
    readonly retryWhenCapacityAvailable?: (() => void) | undefined;
};

export function createSyntaxTokenizer(
    theme: ThemeRegistration | undefined,
    options: {
        readonly maxJobs: number;
        readonly maxBytes: number;
        readonly reportWarning: ((message: string) => void) | undefined;
        readonly waitForDisposals: () => Promise<void>;
    },
) {
    const queue: Work[] = [];
    // Backpressure retains weak renderer handles, never over-budget source jobs.
    const capacityRetries = new Set<WeakRef<() => void>>();
    const registeredRetries = new WeakSet<() => void>();
    let capacityNotificationScheduled = false;

    function scheduleCapacityNotification(): void {
        if (disposed || failed || capacityRetries.size === 0 || capacityNotificationScheduled)
            return;
        capacityNotificationScheduled = true;
        queueMicrotask(() => {
            capacityNotificationScheduled = false;
            if (disposed || failed) return;
            const retries = [...capacityRetries];
            capacityRetries.clear();
            for (const reference of retries) {
                const retry = reference.deref();
                if (retry === undefined) continue;
                registeredRetries.delete(retry);
                try {
                    retry();
                } catch {
                    // A renderer invalidation must not stop the worker or other owners.
                    continue;
                }
            }
        });
    }
    const terminations = new Set<Promise<number>>();
    let active: Work | undefined;
    let worker: Worker | undefined;
    let ready = false;
    let starting: Promise<void> | undefined;
    let nextId = 0;
    let bytes = 0;
    let disposed = false;
    let failed = false;

    function finish(work: Work, lines: string[] | undefined): void {
        bytes -= work.bytes;
        work.signal?.removeEventListener("abort", work.cancel);
        work.resolve(lines);
        scheduleCapacityNotification();
    }

    function stopWorker(): void {
        const previous = worker;
        worker = undefined;
        ready = false;

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
        capacityRetries.clear();

        if (active !== undefined) finish(active, undefined);
        active = undefined;

        for (const work of queue.splice(0)) finish(work, undefined);
        stopWorker();
        options.reportWarning?.("[pi-glowup] Syntax worker failed; reload to retry highlighting");
    }

    async function startWorker(): Promise<void> {
        try {
            await options.waitForDisposals();

            const initial = queue[0];
            if (disposed || failed || initial === undefined) return;

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
                if (worker !== current) return;

                if ("type" in response) {
                    ready = true;
                    dispatch();
                    return;
                }

                if (active?.request.id !== response.id) return;

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

            let language: BundledLanguage = "python";
            if (initial.request.operation === "highlight") language = initial.request.language;

            const initialization: TokenizeInitialization = {
                type: "initialize",
                language,
                theme,
            };
            current.postMessage(initialization);
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

        if (!ready) {
            worker.ref();
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

    async function enqueue(
        request: TokenizeRequest,
        cancellation: TokenizeCancellation,
    ): Promise<string[] | undefined> {
        const size = Buffer.byteLength(request.code, "utf8");
        if (disposed || failed || cancellation.signal?.aborted === true) return undefined;
        if (
            queue.length + Number(active !== undefined) >= options.maxJobs ||
            bytes + size > options.maxBytes
        ) {
            const retry = cancellation.retryWhenCapacityAvailable;
            if (retry !== undefined && !registeredRetries.has(retry)) {
                registeredRetries.add(retry);
                capacityRetries.add(new WeakRef(retry));
            }
            return undefined;
        }

        return new Promise((resolve) => {
            const work: Work = {
                request,
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

    async function tokenize(
        code: string,
        language: BundledLanguage,
        brackets: boolean,
        cancellation: TokenizeCancellation = {},
    ): Promise<string[] | undefined> {
        if (theme === undefined) return undefined;
        return enqueue(
            { operation: "highlight", id: nextId++, code, language, theme, brackets },
            cancellation,
        );
    }

    async function compactPython(
        code: string,
        cancellation: TokenizeCancellation = {},
    ): Promise<string[] | undefined> {
        return enqueue({ operation: "compact-python", id: nextId++, code }, cancellation);
    }

    async function dispose(): Promise<void> {
        disposed = true;
        capacityRetries.clear();

        if (active !== undefined) finish(active, undefined);
        active = undefined;

        for (const work of queue.splice(0)) finish(work, undefined);
        stopWorker();

        const closing: Array<Promise<number | void>> = [...terminations];
        if (starting !== undefined) closing.push(starting);
        await Promise.allSettled(closing);
    }

    return { tokenize, compactPython, dispose };
}
