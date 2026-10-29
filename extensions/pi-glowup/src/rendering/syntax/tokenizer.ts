import { Worker } from "node:worker_threads";
import type { ThemeRegistration } from "shiki";
import type { SyntaxLanguage } from "./language.ts";
import type {
    TokenizeInitialization,
    TokenizeRequest,
    TokenizeResponse,
} from "./tokenize-worker.ts";
import { recordRenderError } from "../../diagnostics/render-events.ts";

declare global {
    interface ImportMeta {
        readonly glowupSyntaxWorker?: string;
    }
}

const WORKER_START_LIMIT_MS = 30_000;
const WORKER_JOB_LIMIT_MS = 60_000;
const WORKER_CONTENTION_LIMIT_MS = 10_000;
const WORKER_CLEANUP_LIMIT_MS = 10_000;

type Work = {
    readonly request: TokenizeRequest;
    readonly bytes: number;
    readonly resolve: (lines: string[] | undefined) => void;
    readonly signal: AbortSignal | undefined;
    readonly cancel: () => void;
    readonly onUnavailable: TokenizeUnavailableListener | undefined;
    readonly onState: TokenizeCancellation["onState"];
};

export type TokenizeUnavailableReason =
    | "backpressure"
    | "failed"
    | "cancelled"
    | "timeout"
    | "startup-timeout"
    | "startup-cooldown"
    | "cleanup-timeout"
    | "cleanup-failed";

type TokenizeUnavailableListener = (reason: TokenizeUnavailableReason, error?: string) => void;

type TokenizeCancellation = {
    readonly signal?: AbortSignal;
    readonly retryWhenCapacityAvailable?: (() => void) | undefined;

    /** Explains an undefined result for diagnostics. */
    readonly onUnavailable?: TokenizeUnavailableListener | undefined;
    /** Reports actual queue admission and worker dispatch, never an intention. */
    readonly onState?: ((state: "queued" | "running") => void) | undefined;
};

export function createSyntaxTokenizer(
    theme: ThemeRegistration | undefined,
    options: {
        readonly maxJobs: number;
        readonly maxBytes: number;
        readonly reportWarning: ((message: string) => void) | undefined;
        readonly waitForDisposals: () => Promise<void>;
        readonly createWorker?: ((url: URL) => Worker) | undefined;
    },
) {
    const queue: Work[] = [];
    // Backpressure retains weak renderer handles, never over-budget source jobs.
    const capacityRetries = new Set<WeakRef<() => void>>();
    const registeredRetries = new WeakSet<() => void>();
    const capacityWaiters = new Set<() => void>();

    function wakeCapacityWaiters(): void {
        for (const wake of capacityWaiters) wake();
        capacityWaiters.clear();
    }

    function clearCapacityRetries(): void {
        for (const reference of capacityRetries) {
            const retry = reference.deref();
            if (retry !== undefined) registeredRetries.delete(retry);
        }

        capacityRetries.clear();
    }

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
                } catch (cause: unknown) {
                    // A renderer invalidation must not stop the worker or other owners.
                    recordRenderError("syntax.capacity-retry", cause);
                    continue;
                }
            }
        });
    }
    const terminations = new Set<Promise<"complete" | "timeout" | "failed">>();
    let active: Work | undefined;
    let worker: Worker | undefined;
    let ready = false;
    let starting: Promise<void> | undefined;
    let nextId = 0;
    let bytes = 0;
    let disposed = false;
    let failed = false;
    let failureReason: TokenizeUnavailableReason = "failed";
    let cleanupFailure: "timeout" | "failed" | undefined;
    let startupPaused = false;
    let startupRetry: ReturnType<typeof setTimeout> | undefined;
    let warnedTimeout = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let contentionDeadline: ReturnType<typeof setTimeout> | undefined;

    function clearDeadline(): void {
        if (deadline !== undefined) clearTimeout(deadline);
        if (contentionDeadline !== undefined) clearTimeout(contentionDeadline);
        deadline = undefined;
        contentionDeadline = undefined;
    }

    function timeout(work: Work): void {
        if (active !== work) return;

        active = undefined;
        stopWorker();
        finish(work, undefined, "timeout");

        if (!warnedTimeout) {
            warnedTimeout = true;
            options.reportWarning?.(
                "[pi-glowup] Syntax work exceeded its time limit; the request was not completed",
            );
        }

        dispatch();
    }

    function protectQueuedWork(): void {
        const work = active;
        if (work === undefined || contentionDeadline !== undefined) return;

        contentionDeadline = setTimeout(() => timeout(work), WORKER_CONTENTION_LIMIT_MS);
    }

    function releaseContention(): void {
        if (queue.length > 0) return;
        if (contentionDeadline !== undefined) clearTimeout(contentionDeadline);
        contentionDeadline = undefined;
    }

    function finish(
        work: Work,
        lines: string[] | undefined,
        reason: TokenizeUnavailableReason = "failed",
        error?: string,
    ): void {
        if (lines === undefined) work.onUnavailable?.(reason, error);
        bytes -= work.bytes;
        work.signal?.removeEventListener("abort", work.cancel);
        work.resolve(lines);
        wakeCapacityWaiters();
        scheduleCapacityNotification();
    }

    async function waitForCleanup(
        pending: Promise<unknown>,
    ): Promise<"complete" | "timeout" | "failed"> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), WORKER_CLEANUP_LIMIT_MS);

            void pending.then(
                () => {
                    clearTimeout(timer);
                    resolve("complete");
                },
                () => {
                    clearTimeout(timer);
                    resolve("failed");
                },
            );
        });
    }

    function failCleanup(reason: "timeout" | "failed"): void {
        if (cleanupFailure !== undefined) return;

        cleanupFailure = reason;

        let unavailable: TokenizeUnavailableReason = "cleanup-failed";
        if (reason === "timeout") unavailable = "cleanup-timeout";

        if (failed) failureReason = unavailable;
        else fail(unavailable);

        options.reportWarning?.(
            "[pi-glowup] Syntax worker cleanup did not complete; restart to retry highlighting",
        );
    }

    function stopWorker(): void {
        clearDeadline();

        const previous = worker;
        worker = undefined;
        ready = false;

        if (previous === undefined) return;

        previous.unref();

        let termination: Promise<"complete" | "timeout" | "failed">;
        try {
            termination = waitForCleanup(previous.terminate());
        } catch {
            failCleanup("failed");
            return;
        }

        terminations.add(termination);
        void termination.then((result) => {
            terminations.delete(termination);

            if (result === "complete") dispatch();
            else failCleanup(result);
        });
    }

    function fail(reason: TokenizeUnavailableReason = "failed"): void {
        if (failed || disposed) return;

        failed = true;
        failureReason = reason;
        clearCapacityRetries();
        wakeCapacityWaiters();

        if (active !== undefined) finish(active, undefined, reason);
        active = undefined;

        for (const work of queue.splice(0)) finish(work, undefined, reason);
        stopWorker();

        if (reason === "failed")
            options.reportWarning?.(
                "[pi-glowup] Syntax worker failed; reload to retry highlighting",
            );
    }

    async function startWorker(): Promise<void> {
        try {
            let previous: Promise<void>;
            try {
                previous = options.waitForDisposals();
            } catch {
                failCleanup("failed");
                return;
            }

            const prior = await waitForCleanup(previous);
            if (prior !== "complete") {
                failCleanup(prior);
                return;
            }

            const initial = queue[0];
            if (disposed || failed || initial === undefined) return;

            const url = new URL(
                import.meta.glowupSyntaxWorker ?? "./tokenize-worker.ts",
                import.meta.url,
            );
            const current = options.createWorker?.(url) ?? new Worker(url, { execArgv: [] });
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
                    if (ready) return;

                    clearDeadline();
                    ready = true;
                    dispatch();

                    return;
                }

                if (active?.request.id !== response.id) return;

                clearDeadline();

                const completed = active;
                active = undefined;

                if ("error" in response) {
                    finish(completed, undefined, "failed", response.error);
                    fail();
                } else {
                    finish(completed, response.lines);
                    dispatch();
                }
            });

            let language: SyntaxLanguage = "python";
            if (initial.request.operation === "highlight") language = initial.request.language;

            const initialization: TokenizeInitialization = {
                type: "initialize",
                language,
                theme,
            };

            deadline = setTimeout(() => {
                if (worker !== current || ready) return;

                startupPaused = true;
                startupRetry = setTimeout(() => {
                    startupPaused = false;
                    startupRetry = undefined;
                }, WORKER_START_LIMIT_MS);
                clearCapacityRetries();
                stopWorker();

                for (const work of queue.splice(0)) finish(work, undefined, "startup-timeout");
                wakeCapacityWaiters();
                options.reportWarning?.(
                    "[pi-glowup] Syntax worker startup timed out; a later request can retry",
                );
            }, WORKER_START_LIMIT_MS);
            current.postMessage(initialization);
        } catch (cause: unknown) {
            recordRenderError("syntax.worker-start", cause);
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
            deadline = setTimeout(() => timeout(work), WORKER_JOB_LIMIT_MS);

            if (queue.length > 0) protectQueuedWork();
            worker.postMessage(work.request);
            work.onState?.("running");
        } catch (cause: unknown) {
            recordRenderError("syntax.worker-dispatch", cause);
            fail();
        }
    }

    async function enqueue(
        request: TokenizeRequest,
        cancellation: TokenizeCancellation,
    ): Promise<string[] | undefined> {
        const size = Buffer.byteLength(request.code, "utf8");

        if (disposed || failed) {
            cancellation.onUnavailable?.(failureReason, "syntax worker unavailable");
            return undefined;
        }

        if (cancellation.signal?.aborted === true) {
            cancellation.onUnavailable?.("cancelled");
            return undefined;
        }

        if (startupPaused) {
            cancellation.onUnavailable?.("startup-cooldown");
            return undefined;
        }

        // The byte budget bounds concurrent work, not the size of an individual source.
        // An oversized source runs alone rather than waiting for impossible capacity.
        if (
            queue.length + Number(active !== undefined) >= options.maxJobs ||
            (bytes > 0 && bytes + size > options.maxBytes)
        ) {
            cancellation.onUnavailable?.("backpressure");

            const retry = cancellation.retryWhenCapacityAvailable;
            if (retry !== undefined) {
                if (!registeredRetries.has(retry)) {
                    registeredRetries.add(retry);
                    capacityRetries.add(new WeakRef(retry));
                }
                return undefined;
            }

            // Explicit async callers have no renderer to redraw when capacity returns.
            await new Promise<void>((resolve) => {
                const wake = (): void => {
                    cancellation.signal?.removeEventListener("abort", wake);
                    capacityWaiters.delete(wake);
                    resolve();
                };
                capacityWaiters.add(wake);
                cancellation.signal?.addEventListener("abort", wake, { once: true });
            });
            return enqueue(request, cancellation);
        }

        return new Promise((resolve) => {
            const work: Work = {
                request,
                bytes: size,
                resolve,
                signal: cancellation.signal,
                onUnavailable: cancellation.onUnavailable,
                onState: cancellation.onState,
                cancel: () => {
                    if (active === work) {
                        active = undefined;
                        stopWorker();
                        finish(work, undefined, "cancelled");
                        dispatch();
                        return;
                    }

                    const index = queue.indexOf(work);
                    if (index >= 0) {
                        queue.splice(index, 1);
                        releaseContention();
                        finish(work, undefined, "cancelled");
                    }
                },
            };

            bytes += size;
            cancellation.signal?.addEventListener("abort", work.cancel, { once: true });
            queue.push(work);

            if (active !== undefined) protectQueuedWork();
            work.onState?.("queued");
            dispatch();
        });
    }

    async function tokenize(
        code: string,
        language: SyntaxLanguage,
        brackets: boolean,
        cancellation: TokenizeCancellation = {},
    ): Promise<string[] | undefined> {
        if (theme === undefined) {
            cancellation.onUnavailable?.("failed", "syntax theme unavailable");
            return undefined;
        }

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

        if (startupRetry !== undefined) clearTimeout(startupRetry);
        clearCapacityRetries();
        wakeCapacityWaiters();

        if (active !== undefined) finish(active, undefined, "cancelled");
        active = undefined;

        for (const work of queue.splice(0)) finish(work, undefined, "cancelled");
        stopWorker();

        const closing: Array<Promise<unknown>> = [...terminations];
        if (starting !== undefined) closing.push(starting);
        await Promise.all(closing);

        if (cleanupFailure !== undefined)
            throw new Error(`Syntax worker cleanup ${cleanupFailure}`);
    }

    return { tokenize, compactPython, dispose };
}
