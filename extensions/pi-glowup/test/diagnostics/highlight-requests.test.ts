import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
    beginHighlightRequest,
    bindHighlightJob,
    cancelHighlightRequests,
    createHighlightJob,
    failHighlightReadiness,
    finishHighlightJob,
    highlightJobState,
    joinHighlightJob,
    observedHighlightJob,
    observeComponentFormat,
    observeHighlightComponentRender,
    observeHighlightRevision,
    transitionHighlightRequest,
    useHighlightRequest,
} from "../../src/diagnostics/highlight-requests.ts";
import type { DebugLogFields } from "../../src/diagnostics/logger.ts";
import {
    configureRenderDiagnostics,
    recordRenderEvent,
    resetRenderDiagnostics,
} from "../../src/diagnostics/render-events.ts";

const events: { event: string; fields: DebugLogFields }[] = [];
const sink = (event: string, fields: () => DebugLogFields): void => {
    events.push({ event, fields: fields() });
};

const transitions = () =>
    events.filter(({ event }) => event === "syntax_request").map(({ fields }) => fields);

const terminal = () => transitions().filter(({ terminal }) => terminal === true);
const code = "let fictional = 12;";

beforeEach(() => {
    events.length = 0;
    configureRenderDiagnostics(sink);
});

afterEach(() => configureRenderDiagnostics(undefined));

it("does not let another consumer's same-hash success erase a failure or a later revision", () => {
    const firstOwner = () => {};
    const secondOwner = () => {};
    observeHighlightRevision(firstOwner);
    observeHighlightRevision(secondOwner);
    const first = beginHighlightRequest(code, "typescript", firstOwner, undefined, false);
    const second = beginHighlightRequest(code, "typescript", secondOwner, undefined, false);
    const firstJob = createHighlightJob(first);
    const secondJob = createHighlightJob(second);
    highlightJobState(firstJob, "queued");
    highlightJobState(secondJob, "queued");
    finishHighlightJob(firstJob, "completed");
    finishHighlightJob(secondJob, "failed", "backend-unavailable");
    observeHighlightRevision(firstOwner);
    const next = beginHighlightRequest(code, "typescript", firstOwner, undefined, false);
    finishHighlightJob(createHighlightJob(next), "failed", "backend-unavailable");
    expect(terminal().map(({ state }) => state)).toEqual(["completed", "failed", "failed"]);
    expect(new Set(terminal().map(({ codeHash }) => codeHash)).size).toBe(1);
    expect(new Set(terminal().map(({ requestId }) => requestId)).size).toBe(3);
    expect(terminal()[0]?.ownerId).toBe(terminal()[2]?.ownerId);
    expect(terminal()[0]?.revision).toBe(1);
    expect(terminal()[2]?.revision).toBe(2);
});

it("shares backend job identity without collapsing consumers or inventing submission attempts", () => {
    const first = beginHighlightRequest(code, "typescript", undefined, undefined, false);
    const second = beginHighlightRequest(code, "typescript", undefined, undefined, false);
    const job = createHighlightJob(first);
    highlightJobState(job, "queued");
    joinHighlightJob(job, second);
    joinHighlightJob(job, second);
    highlightJobState(job, "running");
    finishHighlightJob(job, "completed");
    finishHighlightJob(job, "failed");
    expect(terminal()).toHaveLength(2);
    expect(terminal()[0]?.jobId).toBe(terminal()[1]?.jobId);
    expect(terminal().map(({ attempt }) => attempt)).toEqual([1, 1]);
});

it("preserves initial readiness but terminally supersedes theme generations and cancels shutdown", () => {
    const owner = () => {};
    observeHighlightRevision(owner);
    const waiting = beginHighlightRequest(code, "typescript", owner, undefined, false);
    transitionHighlightRequest(waiting, "waiting-ready");
    cancelHighlightRequests("theme-replaced", true);
    expect(beginHighlightRequest(code, "typescript", owner, undefined, false)).toBe(waiting);
    expect(terminal()).toHaveLength(0);
    cancelHighlightRequests("theme-replaced");
    const next = beginHighlightRequest(code, "typescript", owner, undefined, false);
    expect(next?.ownerId).toBe(waiting?.ownerId);
    expect(next?.generation).not.toBe(waiting?.generation);
    cancelHighlightRequests("shutdown");
    finishHighlightJob(createHighlightJob(waiting), "completed");
    expect(terminal().map(({ state, reason }) => [state, reason])).toEqual([
        ["superseded", "theme-replaced"],
        ["cancelled", "shutdown"],
    ]);
});

it("distinguishes initial preservation from later retirement in the ordered evidence", () => {
    const owner = () => {};
    observeHighlightRevision(owner);
    const waiting = beginHighlightRequest(code, "typescript", owner, undefined, false);
    transitionHighlightRequest(waiting, "waiting-ready");
    const active = beginHighlightRequest(
        "const active = 2;",
        "typescript",
        owner,
        undefined,
        false,
    );
    transitionHighlightRequest(active, "waiting-ready");
    transitionHighlightRequest(active, "queued");
    cancelHighlightRequests("theme-replaced", true);
    finishHighlightJob(createHighlightJob(waiting), "failed");
    const later = beginHighlightRequest("const next = 1;", "typescript", owner, undefined, false);
    cancelHighlightRequests("theme-replaced");
    cancelHighlightRequests("cache-clear");

    const changes = events.filter(({ event }) => event === "syntax_generation");
    expect(changes.map(({ fields }) => fields)).toMatchObject([
        { previousGeneration: 0, generation: 1, disposition: "preserve-ready" },
        { previousGeneration: 1, generation: 2, disposition: "retire" },
        { previousGeneration: 2, generation: 3, disposition: "retire" },
    ]);

    expect(Number(changes[0]?.fields.seq)).toBeGreaterThan(
        Number(transitions().find(({ state }) => state === "waiting-ready")?.seq),
    );

    expect(Number(changes[0]?.fields.seq)).toBeLessThan(
        Number(transitions().find(({ state }) => state === "failed")?.seq),
    );

    expect(later?.generation).toBe(1);
    expect(terminal().map(({ state }) => state)).toEqual(["superseded", "failed", "superseded"]);

    expect(Number(changes[0]?.fields.seq)).toBeLessThan(Number(terminal()[0]?.seq));
    expect(Number(changes[1]?.fields.seq)).toBeLessThan(Number(terminal()[2]?.seq));
    expect(events.at(-1)?.fields).toMatchObject({ pendingCount: 0 });
    expect(Number(events.at(-1)?.fields.seq)).toBe(Number(changes[2]?.fields.seq) + 1);
});

it("records a formatter selection only inside its owner's actual component render", () => {
    const owner = () => {};
    const source = "const value=1;";
    const output = "const value = 1;";
    const sourceHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const outputHash = createHash("sha256").update(output).digest("hex").slice(0, 16);
    observeHighlightRevision(owner);
    observeComponentFormat(owner, { state: "ready", source, output });
    expect(events).toEqual([]);
    const component = {
        render: () => {
            observeComponentFormat(owner, { state: "ready", source, output });
            return [output];
        },
        invalidate() {},
    };

    expect(observeHighlightComponentRender(component, owner, 80)).toEqual([output]);
    const rendered = events.find(({ event }) => event === "syntax_component_render")?.fields;
    expect(rendered?.formats).toMatchObject([
        { ownerId: rendered?.ownerId, revision: 1, state: "ready", sourceHash, outputHash },
    ]);

    expect(rendered?.requests).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(source);
    expect(JSON.stringify(events)).not.toContain(output);
});

it("keeps a foreign pending formatter distinct without inventing output", () => {
    const owner = () => {};
    const foreign = () => {};
    const source = "const pending=1;";
    observeHighlightRevision(owner);
    observeHighlightRevision(foreign);
    const request = beginHighlightRequest(source, "typescript", foreign, undefined, false);
    const component = {
        render: () => {
            observeComponentFormat(foreign, { state: "pending", source });
            return [source];
        },
        invalidate() {},
    };

    observeHighlightComponentRender(component, owner, 80);
    const rendered = events.find(({ event }) => event === "syntax_component_render")?.fields;
    expect(rendered?.ownerId).not.toBe(request?.ownerId);
    expect(rendered?.formats).toEqual([
        {
            ownerId: request?.ownerId,
            revision: 1,
            state: "pending",
            sourceHash: createHash("sha256").update(source).digest("hex").slice(0, 16),
        },
    ]);
});

it("retains the actual request owner through nested component renders", () => {
    const outer = () => {};
    const inner = () => {};
    observeHighlightRevision(outer);
    observeHighlightRevision(inner);
    const body = {
        render: () => {
            beginHighlightRequest(code, "typescript", inner, undefined, false);
            return [code];
        },
        invalidate() {},
    };
    const container = {
        render: () => observeHighlightComponentRender(body, inner, 80),
        invalidate() {},
    };

    expect(observeHighlightComponentRender(container, outer, 80)).toEqual([code]);
    const renders = events.filter(({ event }) => event === "syntax_component_render");
    const request = transitions().find(({ state }) => state === "requested");
    expect(renders).toHaveLength(2);
    expect(renders[0]?.fields.ownerId).toBe(request?.ownerId);
    expect(renders[1]?.fields.ownerId).not.toBe(request?.ownerId);
    expect(renders[0]?.fields.requests).toMatchObject([
        { requestId: request?.requestId, ownerId: request?.ownerId },
    ]);

    expect(renders[1]?.fields.requests).toMatchObject([
        { requestId: request?.requestId, ownerId: request?.ownerId },
    ]);
});

it("does not attribute a render across a diagnostics reset to the new epoch", () => {
    const owner = () => {};
    observeHighlightRevision(owner);
    const first = beginHighlightRequest(code, "typescript", owner, undefined, false);
    const component = {
        render: () => {
            configureRenderDiagnostics(undefined);
            configureRenderDiagnostics(sink);
            observeHighlightRevision(owner);
            beginHighlightRequest(code, "typescript", owner, undefined, false);

            return [code];
        },
        invalidate() {},
    };

    expect(observeHighlightComponentRender(component, owner, 80)).toEqual([code]);
    expect(events.filter(({ event }) => event === "syntax_component_render")).toEqual([]);
    const next = beginHighlightRequest(code, "typescript", owner, undefined, false);
    expect(next?.epoch).not.toBe(first?.epoch);
});

it("keeps cached adoption terminal and use publication ordered after availability", () => {
    const owner = () => {};
    observeHighlightRevision(owner);
    const request = beginHighlightRequest(code, "typescript", owner, undefined, false);
    useHighlightRequest(request, "cache");
    useHighlightRequest(request, "cache");
    useHighlightRequest(request, "invalidation");
    expect(terminal()).toHaveLength(1);
    expect(terminal()[0]).toMatchObject({ state: "cached-adopted", attempt: 0 });
    const terminalSeq = Number(terminal()[0]?.seq);
    for (const entry of events.filter(({ event }) => event === "syntax_request_use"))
        expect(Number(entry.fields.seq)).toBeGreaterThan(terminalSeq);
});

it("closes failed language waits and ignores later backend or abort notifications", () => {
    const controller = new AbortController();
    const request = beginHighlightRequest(code, "typescript", () => {}, controller.signal, false);
    transitionHighlightRequest(request, "waiting-ready");
    failHighlightReadiness("python", "language-load-failed");
    expect(terminal()).toHaveLength(0);
    failHighlightReadiness("typescript", "language-load-failed");
    controller.abort();
    transitionHighlightRequest(request, "completed");
    expect(terminal()).toHaveLength(1);
    expect(terminal()[0]).toMatchObject({ state: "failed", reason: "language-load-failed" });
});

it("closes an outgoing sink, resets epochs and rejects stale jobs and handles", async () => {
    const request = beginHighlightRequest(code, "typescript", undefined, undefined, false);
    const job = createHighlightJob(request);
    const promise = Promise.resolve(["fictional colors"]);
    bindHighlightJob(promise, job);
    configureRenderDiagnostics(() => {});
    expect(terminal()[0]?.reason).toBe("diagnostics-reset");
    expect(events.at(-1)?.fields.pendingCount).toBe(0);
    configureRenderDiagnostics(sink);
    expect(observedHighlightJob(promise)).toBeUndefined();
    const next = beginHighlightRequest(code, "typescript", undefined, undefined, true);
    finishHighlightJob(job, "completed");
    transitionHighlightRequest(request, "completed");
    expect(terminal()).toHaveLength(1);
    finishHighlightJob(createHighlightJob(next, false), "completed");
    expect(terminal()[1]).toMatchObject({
        state: "completed",
        observation: "late",
        reason: "late-result-available",
        jobObservation: "late",
        attempt: 0,
    });

    expect(next?.epoch).not.toBe(request?.epoch);
    await promise;
});

it("has no request/job/owner observations on the disabled path and tolerates repeated resets", () => {
    configureRenderDiagnostics(undefined);
    events.length = 0;
    const owner = () => {};
    observeHighlightRevision(owner);
    const request = beginHighlightRequest(code, "typescript", owner, undefined, false);
    expect(request).toBeUndefined();
    expect(createHighlightJob(request)).toBeUndefined();
    cancelHighlightRequests("shutdown");
    resetRenderDiagnostics();
    resetRenderDiagnostics();
    expect(events).toEqual([]);
});

it("records repeated capacity attempts even when their waiting state does not change", () => {
    const owner = () => {};
    observeHighlightRevision(owner);
    const request = beginHighlightRequest(code, "typescript", owner, undefined, false);
    const first = createHighlightJob(request);
    highlightJobState(first, "waiting-capacity");
    const second = createHighlightJob(request);
    highlightJobState(second, "waiting-capacity");
    const third = createHighlightJob(request);
    highlightJobState(third, "queued");
    finishHighlightJob(third, "completed");
    expect(transitions().map(({ state }) => state)).toEqual([
        "requested",
        "waiting-capacity",
        "waiting-capacity",
        "queued",
        "completed",
    ]);

    expect(transitions()[2]).toMatchObject({ attempt: 2, reason: "retry" });
    expect(terminal()[0]?.attempt).toBe(3);
});

it("distinguishes unsupported labels by hash without recording their contents", () => {
    const owner = () => {};
    observeHighlightRevision(owner);
    const first = beginHighlightRequest(
        code,
        undefined,
        owner,
        undefined,
        false,
        "invented-first-label",
    );
    const second = beginHighlightRequest(
        code,
        undefined,
        owner,
        undefined,
        false,
        "invented-second-label",
    );
    transitionHighlightRequest(first, "unsupported");
    transitionHighlightRequest(second, "unsupported");
    expect(terminal()).toHaveLength(2);
    expect(first?.languageHash).not.toBe(second?.languageHash);
    expect(JSON.stringify(events)).not.toContain("invented-first-label");
});

it("preserves legacy deduplication on sink replacement and clears it on explicit reset or disable", () => {
    const legacy = (): void =>
        recordRenderEvent(
            "legacy-example",
            () => ({ count: 1 }),
            () => "same",
        );
    legacy();
    configureRenderDiagnostics((event, fields) => sink(event, fields));
    legacy();
    expect(events.filter(({ event }) => event === "legacy-example")).toHaveLength(1);
    resetRenderDiagnostics();
    legacy();
    expect(events.filter(({ event }) => event === "legacy-example")).toHaveLength(2);
    configureRenderDiagnostics(undefined);
    configureRenderDiagnostics(sink);
    legacy();
    expect(events.filter(({ event }) => event === "legacy-example")).toHaveLength(3);
});

it("emits no lifecycle checkpoints when no syntax request was observed", () => {
    configureRenderDiagnostics((event, fields) => sink(event, fields));
    resetRenderDiagnostics();
    configureRenderDiagnostics(undefined);
    expect(events).toEqual([]);
});
