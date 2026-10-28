import { randomUUID } from "node:crypto";
import type { DebugLogFields } from "./logger.ts";
import {
    diagnosticCodeHash,
    onRenderDiagnosticsReset,
    recordRenderEvent,
    renderDiagnosticsEnabled,
    utf8Bytes,
} from "./render-events.ts";

/**
 * Optional v1 observations: epoch-scoped IDs and a total sequence, independent of
 * legacy hash deduplication. Completion/adoption means colors are available, not
 * that a native frame was presented. A reset ends observations, not backend work.
 */
type RequestState =
    | "requested"
    | "waiting-ready"
    | "waiting-capacity"
    | "queued"
    | "running"
    | "completed"
    | "cached-adopted"
    | "superseded"
    | "cancelled"
    | "failed"
    | "unsupported";

type TerminalState = Extract<
    RequestState,
    "completed" | "cached-adopted" | "superseded" | "cancelled" | "failed" | "unsupported"
>;

/** Scalar observation only: never retains source, a renderer, or backend work. */
export type HighlightRequest = {
    readonly epoch: string;
    readonly requestId: string;
    readonly ownerId: string | null;
    readonly revision: number;
    readonly generation: number;
    readonly codeHash: string;
    readonly bytes: number;
    readonly language: string | null;
    readonly languageHash: string | undefined;
    readonly observation: "start" | "late";
    state: RequestState;
    terminal: boolean;
    attempt: number;
    jobId?: string;
    jobObservation?: "submission" | "late";
    detach?: () => void;
};

type Owner = {
    readonly id: string;
    revision: number;
    generation: number;
    readonly requests: Map<string, HighlightRequest>;
};

export type HighlightJob = {
    readonly id: string;
    readonly epoch: string;
    readonly proven: boolean;
    state?: "queued" | "running" | "waiting-capacity";
    readonly requests: Set<HighlightRequest>;
};

let epoch: string | undefined;
let seq = 0;
let nextRequest = 0;
let nextOwner = 0;
let nextJob = 0;
let generation = 0;
let owners = new WeakMap<() => void, Owner>();
let jobs = new WeakMap<Promise<string[]>, HighlightJob>();
const pending = new Map<string, HighlightRequest>();
const pendingStates = new Map<RequestState, number>();
let releasedOwners: FinalizationRegistry<{ epoch: string; ownerId: string }> | undefined;

function registerOwner(invalidate: () => void, ownerId: string): void {
    releasedOwners ??= new FinalizationRegistry((released) => {
        if (released.epoch !== epoch) return;

        for (const request of pending.values()) {
            if (request.ownerId === released.ownerId)
                transitionHighlightRequest(request, "cancelled", "owner-released");
        }
    });
    releasedOwners.register(invalidate, { epoch: currentEpoch(), ownerId });
}

function currentEpoch(): string {
    epoch ??= randomUUID();
    return epoch;
}

function fields(request: HighlightRequest): DebugLogFields {
    return {
        schemaVersion: 1,
        epoch: request.epoch,
        requestId: request.requestId,
        ownerId: request.ownerId,
        revision: request.revision,
        generation: request.generation,
        codeHash: request.codeHash,
        bytes: request.bytes,
        language: request.language,
        languageHash: request.languageHash,
        observation: request.observation,
        state: request.state,
        terminal: request.terminal,
        attempt: request.attempt,
        jobId: request.jobId,
        jobObservation: request.jobObservation,
    };
}

/**
 * Ordered syntax_request deltas identify every pending consumer. This constant-size
 * checkpoint validates reconstruction through throughSeq without copying the queue
 * on every admission (readiness/capacity intentions need not fit in the work queue).
 * A complete observation starts at seq 1; a missing sequence is not proof of absence.
 */
function ledger(): void {
    if (!renderDiagnosticsEnabled() || nextRequest === 0) return;

    const throughSeq = seq;
    const count = pending.size;
    const states = Object.fromEntries(
        [...pendingStates].sort(([first], [second]) => first.localeCompare(second)),
    );
    const sequence = ++seq;

    recordRenderEvent("syntax_request_ledger", () => ({
        schemaVersion: 1,
        epoch: currentEpoch(),
        seq: sequence,
        throughSeq,
        scope: "observed-requests",
        pendingCount: count,
        pendingByState: states,
    }));
}

function countPending(state: RequestState, delta: number): void {
    const count = (pendingStates.get(state) ?? 0) + delta;
    if (count === 0) pendingStates.delete(state);
    else pendingStates.set(state, count);
}

function publish(request: HighlightRequest, reason?: string): void {
    const snapshot = fields(request);
    const sequence = ++seq;

    recordRenderEvent("syntax_request", () => ({ ...snapshot, seq: sequence, reason }));
    ledger();
}

function live(request: HighlightRequest | undefined): request is HighlightRequest {
    return request !== undefined && request.epoch === epoch && renderDiagnosticsEnabled();
}

export function transitionHighlightRequest(
    request: HighlightRequest | undefined,
    state: RequestState,
    reason?: string,
): void {
    if (!live(request) || request.terminal || request.state === state) return;

    countPending(request.state, -1);
    request.state = state;
    request.terminal =
        state === "completed" ||
        state === "cached-adopted" ||
        state === "superseded" ||
        state === "cancelled" ||
        state === "failed" ||
        state === "unsupported";
    if (request.terminal) {
        pending.delete(request.requestId);
        request.detach?.();
        delete request.detach;
    } else countPending(state, 1);

    publish(request, reason);
}

function ownerFor(invalidate: () => void): Owner {
    let owner = owners.get(invalidate);
    if (owner === undefined) {
        owner = { id: `o${++nextOwner}`, revision: 0, generation, requests: new Map() };
        owners.set(invalidate, owner);
        registerOwner(invalidate, owner.id);
    }

    if (owner.generation !== generation) {
        for (const [key, request] of owner.requests) {
            if (request.terminal) owner.requests.delete(key);
        }

        owner.generation = generation;
    }

    return owner;
}

export function observeHighlightRevision(invalidate: () => void): void {
    if (!renderDiagnosticsEnabled()) return;

    const owner = ownerFor(invalidate);
    for (const request of owner.requests.values())
        transitionHighlightRequest(request, "superseded", "source-replaced");

    owner.requests.clear();
    owner.revision += 1;
}

export function beginHighlightRequest(
    code: string,
    language: string | undefined,
    invalidate: (() => void) | undefined,
    signal: AbortSignal | undefined,
    late: boolean,
    requestedLanguage?: string,
    newIntention = false,
): HighlightRequest | undefined {
    if (!renderDiagnosticsEnabled() || code.length === 0) return undefined;

    let owner: Owner | undefined;
    if (invalidate !== undefined) owner = ownerFor(invalidate);

    const codeHash = diagnosticCodeHash(code);
    const bytes = utf8Bytes(code);
    let languageHash: string | undefined;
    if (language === undefined && requestedLanguage !== undefined)
        languageHash = diagnosticCodeHash(requestedLanguage);

    const key = `${codeHash}\0${bytes}\0${language ?? ""}\0${languageHash ?? ""}`;
    const existing = owner?.requests.get(key);
    if (existing !== undefined && (!existing.terminal || !newIntention)) {
        if (existing.state === "waiting-ready") observeSignal(existing, signal);
        return existing;
    }

    let observation: "start" | "late" = "start";
    if (late || owner?.revision === 0) observation = "late";

    const request: HighlightRequest = {
        epoch: currentEpoch(),
        requestId: `r${++nextRequest}`,
        ownerId: owner?.id ?? null,
        revision: owner?.revision ?? 0,
        generation,
        codeHash,
        bytes,
        language: language ?? null,
        languageHash,
        observation,
        state: "requested",
        terminal: false,
        attempt: 0,
    };

    owner?.requests.set(key, request);
    pending.set(request.requestId, request);
    countPending(request.state, 1);

    let reason: string | undefined;
    if (existing?.terminal === true) reason = "resubmitted";
    publish(request, reason);
    observeSignal(request, signal);

    return request;
}

function observeSignal(request: HighlightRequest, signal: AbortSignal | undefined): void {
    request.detach?.();
    delete request.detach;

    if (request.terminal || signal === undefined) return;

    const abort = (): void => transitionHighlightRequest(request, "cancelled", "signal-aborted");
    signal.addEventListener("abort", abort, { once: true });

    const reference = new WeakRef(signal);

    request.detach = () => reference.deref()?.removeEventListener("abort", abort);

    if (signal.aborted) abort();
}

export function useHighlightRequest(
    request: HighlightRequest | undefined,
    reason: "cache" | "invalidation",
): void {
    if (!live(request)) return;
    if (reason === "cache") transitionHighlightRequest(request, "cached-adopted", "cache");

    // A later cache return is a fresh availability fact, not a rewrite of an earlier
    // failed/cancelled terminal. Invalidation publication requires proven availability.
    if (
        reason === "invalidation" &&
        request.state !== "completed" &&
        request.state !== "cached-adopted"
    )
        return;

    const snapshot = fields(request);
    const sequence = ++seq;

    recordRenderEvent("syntax_request_use", () => ({ ...snapshot, seq: sequence, reason }));
}

export function cancelHighlightRequests(reason: string, preserveReady = false): void {
    if (!renderDiagnosticsEnabled()) return;

    const previousGeneration = generation;
    generation += 1;

    const currentGeneration = generation;

    if (nextRequest > 0) {
        const sequence = ++seq;
        const observationEpoch = currentEpoch();

        recordRenderEvent("syntax_generation", () => ({
            schemaVersion: 1,
            epoch: observationEpoch,
            seq: sequence,
            previousGeneration,
            generation: currentGeneration,
            disposition: preserveReady ? "preserve-ready" : "retire",
            reason,
        }));
    }

    for (const request of pending.values()) {
        if (preserveReady && request.state === "waiting-ready") continue;

        let state: TerminalState = "cancelled";
        if (reason === "theme-replaced") state = "superseded";
        transitionHighlightRequest(request, state, reason);
    }

    // Keep callback IDs/revisions stable; ownerFor prunes old results lazily.
    ledger();
}

export function observedHighlightJob(
    promise: Promise<string[]> | undefined,
): HighlightJob | undefined {
    if (!renderDiagnosticsEnabled() || promise === undefined) return undefined;
    return jobs.get(promise);
}

export function createHighlightJob(
    request: HighlightRequest | undefined,
    proven = true,
): HighlightJob | undefined {
    if (!live(request) || request.terminal) return undefined;

    const job: HighlightJob = {
        id: `j${++nextJob}`,
        epoch: currentEpoch(),
        proven,
        requests: new Set(),
    };
    joinHighlightJob(job, request);

    return job;
}

export function joinHighlightJob(
    job: HighlightJob | undefined,
    request: HighlightRequest | undefined,
): void {
    if (
        job === undefined ||
        !live(request) ||
        request.terminal ||
        job.epoch !== epoch ||
        job.requests.has(request)
    )
        return;

    job.requests.add(request);
    request.jobId = job.id;
    request.jobObservation = "late";
    if (job.proven) {
        request.jobObservation = "submission";
        request.attempt += 1;
    }

    if (job.state !== undefined) transitionHighlightRequest(request, job.state);
}

export function bindHighlightJob(promise: Promise<string[]>, job: HighlightJob | undefined): void {
    if (job !== undefined && job.epoch === epoch) jobs.set(promise, job);
}

export function highlightJobState(
    job: HighlightJob | undefined,
    state: "queued" | "running" | "waiting-capacity",
): void {
    if (job === undefined || job.epoch !== epoch) return;

    job.state = state;
    for (const request of job.requests) {
        if (live(request) && !request.terminal && request.state === state)
            publish(request, "retry");
        else transitionHighlightRequest(request, state);
    }
}

export function finishHighlightJob(
    job: HighlightJob | undefined,
    state: TerminalState,
    reason?: string,
    publishInvalidation = false,
): void {
    if (job === undefined || job.epoch !== epoch) return;

    for (const request of job.requests) {
        if (state === "completed" && !job.proven)
            transitionHighlightRequest(request, "completed", "late-result-available");
        else transitionHighlightRequest(request, state, reason);

        if (publishInvalidation) useHighlightRequest(request, "invalidation");
    }

    job.requests.clear();
}

export function failHighlightReadiness(language: string | undefined, reason: string): void {
    if (!renderDiagnosticsEnabled()) return;

    for (const request of pending.values()) {
        if (
            request.state === "waiting-ready" &&
            (language === undefined || request.language === language)
        )
            transitionHighlightRequest(request, "failed", reason);
    }
}

onRenderDiagnosticsReset(() => {
    cancelHighlightRequests("diagnostics-reset");
    owners = new WeakMap();
    releasedOwners = undefined;
    jobs = new WeakMap();
    pending.clear();
    pendingStates.clear();
    epoch = undefined;
    seq = 0;
    nextOwner = 0;
    nextRequest = 0;
    nextJob = 0;
    generation = 0;
});
