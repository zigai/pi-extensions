import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { ThemeRegistration } from "shiki";
import Type from "typebox";
import { Value } from "typebox/value";
import {
    isLoadableSyntaxLanguage,
    normalizeSyntaxLanguage,
    type SyntaxLanguage,
} from "./language.ts";
import type { SyntaxHighlightKey, SyntaxHighlightStore } from "./highlight-store.ts";
import type {
    SyntaxWorkerRequest,
    TokenizeInitialization,
    TokenizeResponse,
} from "./tokenize-worker.ts";
import type { DiffHighlightOutput } from "../diff/highlight-runs.ts";
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
const storedLinesSchema = Type.Array(Type.String());
const packedLineSchema = Type.Union([
    Type.Null(),
    Type.Tuple([Type.String(), Type.Array(Type.Integer())]),
]);

const packedCodeSchema = Type.Object({
    colors: Type.Array(Type.String()),
    deletionLines: Type.Array(packedLineSchema),
    additionLines: Type.Array(packedLineSchema),
});

const storedDiffSchema = Type.Object({
    dark: packedCodeSchema,
    light: Type.Union([Type.Null(), packedCodeSchema]),
});

type WorkResult = { readonly lines: string[] } | { readonly diff: DiffHighlightOutput };

type Work = {
    settled: boolean;
    readonly request: SyntaxWorkerRequest;
    readonly bytes: number;
    readonly resolve: (result: WorkResult | undefined) => void;
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

type CapacityRetry = {
    readonly retry: WeakRef<() => void>;
    readonly signal: AbortSignal | undefined;
    readonly isNeeded: WeakRef<() => boolean> | undefined;
    readonly signals: Set<WeakRef<AbortSignal>>;
    readonly watchedSignals: WeakSet<AbortSignal>;
    readonly cancel: () => void;
};

type TokenizeUnavailableListener = (reason: TokenizeUnavailableReason, error?: string) => void;

function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

type TokenizeCancellation = {
    readonly signal?: AbortSignal;
    readonly retryWhenCapacityAvailable?: (() => void) | undefined;
    readonly isCapacityRetryNeeded?: (() => boolean) | undefined;

    /** Explains an undefined result for diagnostics. */
    readonly onUnavailable?: TokenizeUnavailableListener | undefined;

    /** Reports actual queue admission and worker dispatch, never an intention. */
    readonly onState?: ((state: "queued" | "running") => void) | undefined;
};

type CleanupResult = "complete" | "timeout" | "failed";

type RestingWorker =
    | { readonly kind: "idle" }
    | { readonly kind: "cooldown"; readonly retry: ReturnType<typeof setTimeout> }
    | {
          readonly kind: "failed" | "disposed";
          readonly reason: TokenizeUnavailableReason;
          readonly cleanup: CleanupResult;
      };

type WorkerLifecycle =
    | RestingWorker
    | { readonly kind: "starting"; readonly pending: Promise<CleanupResult> }
    | {
          readonly kind: "initializing";
          readonly worker: Worker;
          readonly deadline: ReturnType<typeof setTimeout>;
      }
    | { readonly kind: "ready"; readonly worker: Worker }
    | {
          readonly kind: "running";
          readonly worker: Worker;
          readonly work: Work;
          readonly deadline: ReturnType<typeof setTimeout>;
      }
    | {
          readonly kind: "stopping";
          readonly pending: Promise<CleanupResult>;
          next: RestingWorker;
      };

export function createSyntaxTokenizer(
    theme: ThemeRegistration | undefined,
    options: {
        readonly maxJobs: number;
        readonly maxBytes: number;
        readonly reportWarning: ((message: string) => void) | undefined;
        readonly waitForDisposals: () => Promise<void>;
        readonly createWorker?: ((url: URL) => Worker) | undefined;
        readonly store?: SyntaxHighlightStore | undefined;
    },
) {
    const queue: Work[] = [];

    // Backpressure retains weak renderer handles, never over-budget source jobs.
    const capacityRetries = new Set<CapacityRetry>();
    const registeredRetries = new WeakMap<() => void, CapacityRetry>();
    const capacityWaiters = new Set<() => void>();

    function wakeCapacityWaiters(): void {
        for (const wake of capacityWaiters) wake();
        capacityWaiters.clear();
    }

    function removeCapacityRetry(entry: CapacityRetry): void {
        capacityRetries.delete(entry);
        entry.signal?.removeEventListener("abort", entry.cancel);

        for (const reference of entry.signals)
            reference.deref()?.removeEventListener("abort", entry.cancel);

        const retry = entry.retry.deref();
        if (retry !== undefined) registeredRetries.delete(retry);
    }

    function clearCapacityRetries(): void {
        for (const entry of capacityRetries) removeCapacityRetry(entry);
    }

    let capacityNotificationScheduled = false;

    function scheduleCapacityNotification(): void {
        if (
            isDisposed() ||
            isCoolingDown() ||
            capacityRetries.size === 0 ||
            capacityNotificationScheduled
        )
            return;

        capacityNotificationScheduled = true;
        queueMicrotask(() => {
            capacityNotificationScheduled = false;

            if (isDisposed() || isCoolingDown()) return;

            const retries = [...capacityRetries];
            for (const entry of retries) {
                const retry = entry.retry.deref();
                removeCapacityRetry(entry);

                if (retry === undefined || !capacityRetryNeeded(entry)) continue;
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

    // Worker ownership is exclusive: initialization, one running job, or one cleanup
    // barrier. Admission, byte accounting, and capacity demand remain independent.
    let lifecycle: WorkerLifecycle = { kind: "idle" };
    let nextId = 0;
    let bytes = 0;
    let warnedTimeout = false;
    let contentionDeadline: ReturnType<typeof setTimeout> | undefined;

    function restingState(): RestingWorker | undefined {
        if (lifecycle.kind === "stopping") return lifecycle.next;

        switch (lifecycle.kind) {
            case "idle":
            case "cooldown":
            case "failed":
            case "disposed":
                return lifecycle;
            case "starting":
            case "initializing":
            case "ready":
            case "running":
                return undefined;
            default:
                return lifecycle satisfies never;
        }
    }

    function isDisposed(): boolean {
        return restingState()?.kind === "disposed";
    }

    function isCoolingDown(): boolean {
        return restingState()?.kind === "cooldown";
    }

    function activeWork(): Work | undefined {
        if (lifecycle.kind === "running") return lifecycle.work;
        return undefined;
    }

    function clearDeadline(): void {
        if (lifecycle.kind === "initializing" || lifecycle.kind === "running")
            clearTimeout(lifecycle.deadline);

        if (contentionDeadline !== undefined) clearTimeout(contentionDeadline);
        contentionDeadline = undefined;
    }

    function timeout(work: Work): void {
        if (activeWork() !== work) return;

        const abandoned = work.settled;
        stopWorker({ kind: "idle" });
        finish(work, undefined, "timeout");

        if (!warnedTimeout && !abandoned) {
            warnedTimeout = true;
            options.reportWarning?.(
                "[pi-glowup] Syntax work exceeded its time limit; the request was not completed",
            );
        }

        dispatch();
    }

    function capacityRetryNeeded(entry: CapacityRetry): boolean {
        if (entry.signal?.aborted === true) return false;
        if (entry.isNeeded === undefined) return true;
        return entry.isNeeded.deref()?.() === true;
    }

    function hasWaitingDemand(): boolean {
        for (const entry of capacityRetries) {
            if (entry.retry.deref() === undefined || !capacityRetryNeeded(entry))
                removeCapacityRetry(entry);
        }

        return queue.length > 0 || capacityWaiters.size > 0 || capacityRetries.size > 0;
    }

    function protectQueuedWork(): void {
        const work = activeWork();
        if (work === undefined || contentionDeadline !== undefined) return;

        contentionDeadline = setTimeout(() => {
            contentionDeadline = undefined;

            if (hasWaitingDemand()) timeout(work);
        }, WORKER_CONTENTION_LIMIT_MS);
    }

    function releaseContention(): void {
        if (hasWaitingDemand()) return;
        if (contentionDeadline !== undefined) clearTimeout(contentionDeadline);
        contentionDeadline = undefined;
    }

    function finish(
        work: Work,
        result: WorkResult | undefined,
        reason: TokenizeUnavailableReason = "failed",
        error?: string,
    ): void {
        if (work.settled) return;

        work.settled = true;
        if (result === undefined) work.onUnavailable?.(reason, error);
        bytes -= work.bytes;
        work.signal?.removeEventListener("abort", work.cancel);
        work.resolve(result);
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

    function cleanupUnavailable(reason: "timeout" | "failed"): TokenizeUnavailableReason {
        if (reason === "timeout") return "cleanup-timeout";
        return "cleanup-failed";
    }

    function failCleanup(reason: "timeout" | "failed"): void {
        const resting = restingState();
        if (
            (resting?.kind === "failed" || resting?.kind === "disposed") &&
            resting.cleanup !== "complete"
        )
            return;

        if (resting?.kind === "cooldown") clearTimeout(resting.retry);

        const unavailable = cleanupUnavailable(reason);
        if (resting?.kind === "disposed") {
            lifecycle = { kind: "disposed", reason: resting.reason, cleanup: reason };
        } else {
            lifecycle = { kind: "failed", reason: unavailable, cleanup: reason };
            wakeCapacityWaiters();
            scheduleCapacityNotification();

            for (const work of queue.splice(0)) finish(work, undefined, unavailable);
        }

        options.reportWarning?.(
            "[pi-glowup] Syntax worker cleanup did not complete; restart to retry highlighting",
        );
    }

    function awaitStopped(pending: Promise<CleanupResult>, next: RestingWorker): void {
        const stopping: WorkerLifecycle = { kind: "stopping", pending, next };
        lifecycle = stopping;
        void pending.then((result) => {
            if (lifecycle !== stopping) return;

            if (result !== "complete") {
                failCleanup(result);
                return;
            }

            lifecycle = stopping.next;
            dispatch();
        });
    }

    function stopWorker(next: RestingWorker): void {
        clearDeadline();

        const previous = lifecycle;
        switch (previous.kind) {
            case "starting":
                awaitStopped(previous.pending, next);
                return;
            case "stopping":
                previous.next = next;
                return;
            case "initializing":
            case "ready":
            case "running": {
                previous.worker.unref();

                let pending: Promise<CleanupResult>;
                try {
                    pending = waitForCleanup(previous.worker.terminate());
                } catch {
                    pending = Promise.resolve("failed");
                }

                awaitStopped(pending, next);

                return;
            }
            case "idle":
            case "cooldown":
            case "failed":
            case "disposed":
                lifecycle = next;
        }
    }

    function fail(reason: TokenizeUnavailableReason = "failed"): void {
        const resting = restingState();
        if (resting?.kind === "failed" || resting?.kind === "disposed") return;

        const work = activeWork();

        if (resting?.kind === "cooldown") clearTimeout(resting.retry);
        stopWorker({ kind: "failed", reason, cleanup: "complete" });
        wakeCapacityWaiters();
        scheduleCapacityNotification();

        if (work !== undefined) finish(work, undefined, reason);

        for (const queued of queue.splice(0)) finish(queued, undefined, reason);

        if (reason === "failed")
            options.reportWarning?.(
                "[pi-glowup] Syntax worker failed; reload to retry highlighting",
            );
    }

    function startupTimeout(current: Worker): void {
        if (lifecycle.kind !== "initializing" || lifecycle.worker !== current) return;

        const cooldown: RestingWorker = {
            kind: "cooldown",
            retry: setTimeout(() => {
                if (lifecycle === cooldown) lifecycle = { kind: "idle" };
                else if (lifecycle.kind === "stopping" && lifecycle.next === cooldown)
                    lifecycle.next = { kind: "idle" };
                else return;

                scheduleCapacityNotification();
            }, WORKER_START_LIMIT_MS),
        };

        stopWorker(cooldown);

        for (const work of queue.splice(0)) finish(work, undefined, "startup-timeout");
        wakeCapacityWaiters();
        options.reportWarning?.(
            "[pi-glowup] Syntax worker startup timed out; a later request can retry",
        );
    }

    function ownsWorker(current: Worker): boolean {
        switch (lifecycle.kind) {
            case "initializing":
            case "ready":
            case "running":
                return lifecycle.worker === current;
            case "idle":
            case "starting":
            case "stopping":
            case "cooldown":
            case "failed":
            case "disposed":
                return false;
            default:
                return lifecycle satisfies never;
        }
    }

    function receive(current: Worker, response: TokenizeResponse): void {
        if (!ownsWorker(current)) return;

        if ("type" in response) {
            if (lifecycle.kind !== "initializing") return;

            clearDeadline();
            lifecycle = { kind: "ready", worker: current };
            dispatch();

            return;
        }

        if (lifecycle.kind !== "running" || lifecycle.work.request.id !== response.id) return;

        clearDeadline();

        const completed = lifecycle.work;
        lifecycle = { kind: "ready", worker: current };

        if ("error" in response) {
            finish(completed, undefined, "failed", response.error);
            fail();
        } else {
            finish(completed, response);
            dispatch();
        }
    }

    function initializeWorker(): void {
        const initial = queue[0];
        if (initial === undefined) {
            lifecycle = { kind: "idle" };
            return;
        }

        try {
            const url = workerUrl();
            const current = options.createWorker?.(url) ?? new Worker(url, { execArgv: [] });

            lifecycle = {
                kind: "initializing",
                worker: current,
                deadline: setTimeout(() => startupTimeout(current), WORKER_START_LIMIT_MS),
            };
            current.on("error", () => {
                if (ownsWorker(current)) fail();
            });

            current.on("exit", () => {
                if (ownsWorker(current)) fail();
            });
            current.on("message", (response: TokenizeResponse) => receive(current, response));

            const initialization: TokenizeInitialization = {
                type: "initialize",
                language: initialLanguage(initial.request),
                theme,
            };
            current.postMessage(initialization);
        } catch (cause: unknown) {
            recordRenderError("syntax.worker-start", cause);
            fail();
        }
    }

    function startWorker(): void {
        let pending: Promise<CleanupResult>;
        try {
            pending = waitForCleanup(options.waitForDisposals());
        } catch {
            failCleanup("failed");
            return;
        }

        const starting: WorkerLifecycle = { kind: "starting", pending };
        lifecycle = starting;
        void pending.then((result) => {
            // Disposal can take ownership of this same barrier before it settles.
            if (lifecycle !== starting) return;

            if (result !== "complete") failCleanup(result);
            else initializeWorker();
        });
    }

    function dispatch(): void {
        switch (lifecycle.kind) {
            case "idle":
                if (queue.length > 0) startWorker();
                return;
            case "initializing":
                if (queue.length > 0) lifecycle.worker.ref();
                return;
            case "starting":
            case "stopping":
            case "running":
            case "cooldown":
            case "failed":
            case "disposed":
                return;
            case "ready":
                break;
        }

        const current = lifecycle.worker;
        const work = queue.shift();
        if (work === undefined) {
            current.unref();
            return;
        }

        lifecycle = {
            kind: "running",
            worker: current,
            work,
            deadline: setTimeout(() => timeout(work), WORKER_JOB_LIMIT_MS),
        };

        try {
            current.ref();

            if (hasWaitingDemand()) protectQueuedWork();
            current.postMessage(work.request);
            work.onState?.("running");
        } catch (cause: unknown) {
            recordRenderError("syntax.worker-dispatch", cause);
            fail();
        }
    }

    async function enqueue(
        request: SyntaxWorkerRequest,
        cancellation: TokenizeCancellation,
    ): Promise<WorkResult | undefined> {
        const size = requestBytes(request);
        const resting = restingState();
        if (resting?.kind === "disposed" || resting?.kind === "failed") {
            cancellation.onUnavailable?.(resting.reason, "syntax worker unavailable");
            return undefined;
        }

        if (cancellation.signal?.aborted === true) {
            cancellation.onUnavailable?.("cancelled");
            return undefined;
        }

        if (isCoolingDown()) {
            cancellation.onUnavailable?.("startup-cooldown");
            return undefined;
        }

        // The byte budget bounds concurrent work, not the size of an individual source.
        // An oversized source runs alone rather than waiting for impossible capacity.
        if (
            queue.length + Number(activeWork() !== undefined) >= options.maxJobs ||
            (bytes > 0 && bytes + size > options.maxBytes)
        ) {
            releaseContention();
            cancellation.onUnavailable?.("backpressure");

            if (isAborted(cancellation.signal)) return enqueue(request, cancellation);

            const retry = cancellation.retryWhenCapacityAvailable;
            if (retry !== undefined) {
                let entry = registeredRetries.get(retry);
                if (entry === undefined) {
                    const isNeeded = cancellation.isCapacityRetryNeeded;
                    let signal = cancellation.signal;
                    let needed: WeakRef<() => boolean> | undefined;
                    if (isNeeded !== undefined) {
                        signal = undefined;
                        needed = new WeakRef(isNeeded);
                    }

                    const current: CapacityRetry = {
                        retry: new WeakRef(retry),
                        signal,
                        isNeeded: needed,
                        signals: new Set(),
                        watchedSignals: new WeakSet(),
                        cancel: () => {
                            for (const reference of current.signals) {
                                const watched = reference.deref();
                                if (watched === undefined || watched.aborted)
                                    current.signals.delete(reference);
                            }

                            if (needed === undefined) removeCapacityRetry(current);
                            releaseContention();
                        },
                    };

                    entry = current;
                    registeredRetries.set(retry, entry);
                    capacityRetries.add(entry);
                    signal?.addEventListener("abort", entry.cancel, { once: true });
                }

                const signal = cancellation.signal;

                for (const reference of entry.signals) {
                    if (reference.deref() === undefined) entry.signals.delete(reference);
                }

                if (
                    entry.isNeeded !== undefined &&
                    signal !== undefined &&
                    !entry.watchedSignals.has(signal)
                ) {
                    entry.watchedSignals.add(signal);
                    entry.signals.add(new WeakRef(signal));
                    signal.addEventListener("abort", entry.cancel, { once: true });
                }

                protectQueuedWork();

                return undefined;
            }

            // Explicit async callers have no renderer to redraw when capacity returns.
            await new Promise<void>((resolve) => {
                const wake = (): void => {
                    cancellation.signal?.removeEventListener("abort", wake);
                    capacityWaiters.delete(wake);
                    releaseContention();
                    resolve();
                };

                capacityWaiters.add(wake);
                cancellation.signal?.addEventListener("abort", wake, { once: true });
                protectQueuedWork();
            });

            return enqueue(request, cancellation);
        }

        return new Promise((resolve) => {
            const work: Work = {
                settled: false,
                request,
                bytes: size,
                resolve,
                signal: cancellation.signal,
                onUnavailable: cancellation.onUnavailable,
                onState: cancellation.onState,
                cancel: () => {
                    // Restarting the worker costs more than finishing the job; the
                    // response is dropped, and contention or the job limit still stop it.
                    if (activeWork() === work) {
                        finish(work, undefined, "cancelled");
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

            if (activeWork() !== undefined) protectQueuedWork();
            work.onState?.("queued");
            dispatch();
        });
    }

    let storeFiles: readonly string[] | undefined;
    let themeDigest: string | undefined;

    function storeKey(request: SyntaxWorkerRequest): SyntaxHighlightKey {
        // The worker bundle and Shiki's grammars produce the colors.
        storeFiles ??= [
            fileURLToPath(workerUrl()),
            createRequire(import.meta.url).resolve("shiki"),
        ];

        themeDigest ??= createHash("sha256")
            .update(JSON.stringify(theme ?? null))
            .digest("hex");

        let input: string;
        switch (request.operation) {
            case "highlight":
                input = JSON.stringify([
                    request.operation,
                    themeDigest,
                    request.language,
                    request.brackets,
                    request.code,
                ]);
                break;
            case "diff":
                input = JSON.stringify([request.operation, themeDigest, request.metadata]);
                break;
            case "compact-python":
                input = JSON.stringify([request.operation, request.code]);
                break;
            default:
                return request satisfies never;
        }

        return { input, files: storeFiles };
    }

    function isUnavailable(): boolean {
        const resting = restingState();
        return resting?.kind === "disposed" || resting?.kind === "failed";
    }

    async function run(
        request: SyntaxWorkerRequest,
        cancellation: TokenizeCancellation,
    ): Promise<WorkResult | undefined> {
        const store = options.store;
        if (store === undefined || isUnavailable()) return enqueue(request, cancellation);

        let key: SyntaxHighlightKey;
        try {
            key = storeKey(request);
        } catch (cause: unknown) {
            recordRenderError("syntax.highlight-store", cause);
            return enqueue(request, cancellation);
        }

        const stored = decodeStoredResult(request, await store.read(key));
        if (stored !== undefined && !isUnavailable()) {
            if (isAborted(cancellation.signal)) {
                cancellation.onUnavailable?.("cancelled");
                return undefined;
            }

            return stored;
        }

        const result = await enqueue(request, cancellation);
        const encoded = encodeStoredResult(result);
        if (encoded !== undefined) store.write(key, encoded);

        return result;
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

        const result = await run(
            { operation: "highlight", id: nextId++, code, language, theme, brackets },
            cancellation,
        );
        if (result === undefined || !("lines" in result)) return undefined;

        return result.lines;
    }

    async function highlightDiff(
        metadata: FileDiffMetadata,
        cancellation: TokenizeCancellation = {},
    ): Promise<DiffHighlightOutput | undefined> {
        if (theme === undefined) {
            cancellation.onUnavailable?.("failed", "syntax theme unavailable");
            return undefined;
        }

        const result = await run(
            { operation: "diff", id: nextId++, metadata, theme },
            cancellation,
        );
        if (result === undefined || !("diff" in result)) return undefined;

        return result.diff;
    }

    async function compactPython(
        code: string,
        cancellation: TokenizeCancellation = {},
    ): Promise<string[] | undefined> {
        const result = await run({ operation: "compact-python", id: nextId++, code }, cancellation);
        if (result === undefined || !("lines" in result)) return undefined;

        return result.lines;
    }

    async function dispose(): Promise<void> {
        const resting = restingState();
        const work = activeWork();
        let reason: TokenizeUnavailableReason = "failed";
        let cleanup: CleanupResult = "complete";
        if (resting?.kind === "failed" || resting?.kind === "disposed") {
            reason = resting.reason;
            cleanup = resting.cleanup;
        }

        if (resting?.kind === "cooldown") clearTimeout(resting.retry);
        stopWorker({ kind: "disposed", reason, cleanup });
        clearCapacityRetries();
        wakeCapacityWaiters();

        if (work !== undefined) finish(work, undefined, "cancelled");

        for (const queued of queue.splice(0)) finish(queued, undefined, "cancelled");

        if (lifecycle.kind === "stopping") await lifecycle.pending;

        const settled = restingState();
        if (settled?.kind === "disposed" && settled.cleanup !== "complete")
            throw new Error(`Syntax worker cleanup ${settled.cleanup}`);
    }

    return { tokenize, highlightDiff, compactPython, dispose };
}

function workerUrl(): URL {
    return new URL(import.meta.glowupSyntaxWorker ?? "./tokenize-worker.ts", import.meta.url);
}

function initialLanguage(request: SyntaxWorkerRequest): SyntaxLanguage {
    if (request.operation === "highlight") return request.language;

    if (request.operation === "diff") {
        const language = normalizeSyntaxLanguage(request.metadata.lang);
        if (language !== undefined && language !== "text" && isLoadableSyntaxLanguage(language))
            return language;
    }

    return "python";
}

function requestBytes(request: SyntaxWorkerRequest): number {
    if (request.operation !== "diff") return Buffer.byteLength(request.code, "utf8");

    let size = 0;
    for (const line of request.metadata.deletionLines) size += Buffer.byteLength(line, "utf8");
    for (const line of request.metadata.additionLines) size += Buffer.byteLength(line, "utf8");

    return size;
}

function decodeStoredResult(
    request: SyntaxWorkerRequest,
    stored: string | undefined,
): WorkResult | undefined {
    if (stored === undefined) return undefined;

    let value: unknown;
    try {
        value = JSON.parse(stored);
    } catch {
        return undefined;
    }

    if (request.operation === "diff") {
        if (!Value.Check(storedDiffSchema, value)) return undefined;

        return { diff: { highlight: value, failures: [] } };
    }

    if (!Value.Check(storedLinesSchema, value)) return undefined;

    return { lines: value };
}

function encodeStoredResult(result: WorkResult | undefined): string | undefined {
    if (result === undefined) return undefined;
    if ("lines" in result) return JSON.stringify(result.lines);

    // A plain-text fallback after a failure may be transient; only clean results persist.
    if (result.diff.highlight === undefined || result.diff.failures.length > 0) return undefined;
    return JSON.stringify(result.diff.highlight);
}
