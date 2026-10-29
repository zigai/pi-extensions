import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { Worker } from "node:worker_threads";
import Type from "typebox";
import { Value } from "typebox/value";
import {
    getCapabilities,
    setCapabilities,
    TuiMainScreen,
    type Component,
} from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../support/virtual-terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DebugLogFields } from "../../../src/diagnostics/logger.ts";
import { makeComponent } from "../../../src/rendering/component.ts";
import { createSyntaxComponent } from "../../../src/rendering/syntax/component-owner.ts";
import { renderSyntaxComponent } from "../../../src/rendering/syntax/code-component.ts";
import {
    configureRenderDiagnostics,
    resetRenderDiagnostics,
} from "../../../src/diagnostics/render-events.ts";
import {
    clearSyntaxHighlightCache,
    createSyntaxHighlighter,
    disposeSyntaxHighlighting,
    highlightSyntaxCode,
    highlightSyntaxCodeAsync,
    initializeSyntaxHighlighting,
    observeSyntaxHighlightSource,
    reinitializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../src/rendering/syntax/highlighter.ts";

type Entry = { event: string; fields: DebugLogFields };

const entries: Entry[] = [];
const sink = (event: string, fields: () => DebugLogFields): void => {
    entries.push({ event, fields: fields() });
};

const requests = () =>
    entries.filter((entry) => entry.event === "syntax_request").map((entry) => entry.fields);

const terminals = () => requests().filter((fields) => fields.terminal === true);
const source = "const invented = 7;";
const owner = () => {};

const sequenceSchema = Type.Object({ epoch: Type.String(), seq: Type.Number() });
const transitionSchema = Type.Object({
    requestId: Type.String(),
    state: Type.String(),
    terminal: Type.Boolean(),
});

/** Reconstruct the per-consumer pending ledger at every ordered checkpoint. */
function verifyCheckpoints(): void {
    const epochs = new Map<
        string,
        { seq: number; pending: Map<string, string>; terminal: Set<string> }
    >();
    for (const entry of entries.filter(
        ({ event }) =>
            event.startsWith("syntax_request") ||
            event === "syntax_generation" ||
            event === "syntax_component_render",
    )) {
        const { epoch: key, seq } = Value.Parse(sequenceSchema, entry.fields);

        let state = epochs.get(key);
        if (state === undefined) {
            state = { seq: 0, pending: new Map(), terminal: new Set() };
            epochs.set(key, state);
        }

        expect(seq).toBe(state.seq + 1);
        state.seq += 1;
        if (entry.event === "syntax_request") {
            const {
                requestId,
                state: requestState,
                terminal,
            } = Value.Parse(transitionSchema, entry.fields);
            expect(state.terminal.has(requestId)).toBe(false);

            if (requestState === "requested") expect(state.pending.has(requestId)).toBe(false);
            else expect(state.pending.has(requestId)).toBe(true);

            if (terminal) {
                state.pending.delete(requestId);
                state.terminal.add(requestId);
            } else state.pending.set(requestId, requestState);
        } else if (entry.event === "syntax_request_ledger") {
            const counts: Record<string, number> = {};
            for (const value of state.pending.values()) counts[value] = (counts[value] ?? 0) + 1;
            expect(entry.fields.throughSeq).toBe(state.seq - 1);
            expect(entry.fields.pendingCount).toBe(state.pending.size);
            expect(entry.fields.pendingByState).toEqual(counts);
        }
    }
}

describe("optional syntax request events", () => {
    beforeEach(() => {
        entries.length = 0;
        configureRenderDiagnostics(sink);
    });

    afterEach(async () => {
        await disposeSyntaxHighlighting();
        await settleSyntaxHighlights();
        configureRenderDiagnostics(undefined);
        verifyCheckpoints();
    });

    it("coalesces readiness and repeated renders through queue, completion and cache use", async () => {
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        expect(requests().map((fields) => fields.state)).toEqual(["requested", "waiting-ready"]);
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        await settleSyntaxHighlights();
        expect(
            highlightSyntaxCode(source, "typescript", { invalidate: owner }).join("\n"),
        ).toContain("\u001b[");

        expect(new Set(requests().map((fields) => fields.requestId)).size).toBe(1);
        expect(terminals().map((fields) => fields.state)).toEqual(["completed"]);
        expect(requests().map((fields) => fields.state)).toEqual([
            "requested",
            "waiting-ready",
            "queued",
            "running",
            "completed",
        ]);

        expect(entries.some((entry) => entry.event === "syntax_request_use")).toBe(true);
    });

    it("reports a timeout without retrying the same owner and preserves other work", async () => {
        const warnings: string[] = [];
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["typescript"],
                reportWarning: (message) => {
                    warnings.push(message);
                },
            },
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let markRunning: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            markRunning = resolve;
        });
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "running") markRunning();
        });
        const slowOwner = () => {};
        const shortOwner = () => {};
        const slow = "const slow = 1;";
        const short = "const short = 2;";
        try {
            const pending = highlightSyntaxCodeAsync(slow, "typescript", { invalidate: slowOwner });
            await running;
            const queued = highlightSyntaxCodeAsync(short, "typescript", {
                invalidate: shortOwner,
            });
            vi.advanceTimersToNextTimer();
            expect(await pending).toEqual([slow]);
            expect((await queued).join("\n")).toContain("\u001b[");
            expect(terminals().find((fields) => fields.reason === "worker-timeout")?.state).toBe(
                "failed",
            );

            expect(warnings).toEqual([expect.stringContaining("exceeded its time limit")]);

            const submitted = requests().filter((fields) => fields.state === "running").length;
            expect(
                await highlightSyntaxCodeAsync(slow, "typescript", { invalidate: slowOwner }),
            ).toEqual([slow]);

            expect(requests().filter((fields) => fields.state === "running")).toHaveLength(
                submitted,
            );

            const anotherOwner = () => {};
            expect(
                (
                    await highlightSyntaxCodeAsync(slow, "typescript", { invalidate: anotherOwner })
                ).join("\n"),
            ).toContain("\u001b[");

            expect(
                (
                    await highlightSyntaxCodeAsync(slow, "typescript", { invalidate: slowOwner })
                ).join("\n"),
            ).toContain("\u001b[");

            observeSyntaxHighlightSource("const current = 3;", slowOwner);
            expect(
                (
                    await highlightSyntaxCodeAsync("const current = 3;", "typescript", {
                        invalidate: slowOwner,
                    })
                ).join("\n"),
            ).toContain("\u001b[");
        } finally {
            vi.useRealTimers();
        }
    });

    it("resumes an owned request waiting behind an oversized source", async () => {
        const slow = `const slow = "${"x".repeat(512 * 1024)}";`;
        let markRunning: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            markRunning = resolve;
        });
        let markCompleted: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            markCompleted = resolve;
        });
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["javascript"],
                reportWarning: () => {},
                createWorker: () =>
                    new Worker(
                        `const { parentPort } = require("node:worker_threads");
                parentPort.on("message", (request) => {
                    if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                    else if (request.code.length < 1024)
                        parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                });`,
                        { eval: true },
                    ),
            },
        );
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (
                event === "syntax_request" &&
                current.state === "running" &&
                current.bytes === Buffer.byteLength(slow)
            )
                markRunning();

            if (event === "syntax_request" && current.state === "completed") markCompleted();
        });

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const short = "const short = 2;";
        const slowOwner = () => {};
        const shortOwner = () => {};
        const obsolete = new AbortController();
        try {
            highlightSyntaxCode(slow, "javascript", { invalidate: slowOwner });
            await running;
            highlightSyntaxCode("const obsolete = 1;", "javascript", {
                invalidate: shortOwner,
                signal: obsolete.signal,
            });

            expect(highlightSyntaxCode(short, "javascript", { invalidate: shortOwner })).toEqual([
                short,
            ]);

            obsolete.abort();
            await vi.advanceTimersByTimeAsync(10_001);
            await completed;
            const result = highlightSyntaxCode(short, "javascript", { invalidate: shortOwner });
            expect(result.map(stripVTControlCharacters)).toEqual([short]);
            expect(result.join("\n")).toContain("\u001b[");
            expect(terminals().some((fields) => fields.reason === "worker-timeout")).toBe(true);
            expect(requests().some((fields) => fields.state === "waiting-capacity")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("starts a fresh contention interval for a new owner after cancellation", async () => {
        const slow = `const value = "${"x".repeat(512 * 1024)}";`;
        let markRunning: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            markRunning = resolve;
        });
        let markCompleted: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            markCompleted = resolve;
        });
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["javascript"],
                reportWarning: () => {},
                createWorker: () =>
                    new Worker(
                        `const { parentPort } = require("node:worker_threads");
                parentPort.on("message", (request) => {
                    if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                    else if (request.code.length < 1024)
                        parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                });`,
                        { eval: true },
                    ),
            },
        );
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (
                event === "syntax_request" &&
                current.state === "running" &&
                current.bytes === Buffer.byteLength(slow)
            )
                markRunning();

            if (event === "syntax_request" && current.state === "completed") markCompleted();
        });

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const slowOwner = () => {};
        const firstOwner = () => {};
        const secondOwner = () => {};
        const cancelled = new AbortController();
        const short = "const second = 2;";
        try {
            highlightSyntaxCode(slow, "javascript", { invalidate: slowOwner });
            await running;
            highlightSyntaxCode("const first = 1;", "javascript", {
                invalidate: firstOwner,
                signal: cancelled.signal,
            });
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            cancelled.abort();
            await vi.advanceTimersByTimeAsync(9_000);
            highlightSyntaxCode(short, "javascript", { invalidate: secondOwner });
            await vi.advanceTimersByTimeAsync(1_000);
            expect(terminals().some((fields) => fields.reason === "worker-timeout")).toBe(false);
            await vi.advanceTimersByTimeAsync(9_000);
            await completed;
            const result = highlightSyntaxCode(short, "javascript", { invalidate: secondOwner });
            expect(result.map(stripVTControlCharacters)).toEqual([short]);
            expect(result.join("\n")).toContain("\u001b[");
            expect(terminals().some((fields) => fields.reason === "worker-timeout")).toBe(true);
        } finally {
            cancelled.abort();
            vi.useRealTimers();
        }
    });

    it("does not resubmit timed-out unowned renders but permits an explicit retry", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let markRunning: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            markRunning = resolve;
        });
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "running") markRunning();
        });
        try {
            expect(highlightSyntaxCode(source, "typescript")).toEqual([source]);
            await running;
            vi.advanceTimersToNextTimer();
            await settleSyntaxHighlights();
            const submitted = requests().filter((fields) => fields.state === "running").length;
            expect(highlightSyntaxCode(source, "typescript")).toEqual([source]);
            await settleSyntaxHighlights();
            expect(requests().filter((fields) => fields.state === "running")).toHaveLength(
                submitted,
            );

            expect((await highlightSyntaxCodeAsync(source, "typescript")).join("\n")).toContain(
                "\u001b[",
            );

            expect(highlightSyntaxCode(source, "typescript").join("\n")).toContain("\u001b[");
        } finally {
            vi.useRealTimers();
        }
    });

    it("reports startup timeout without automatically resubmitting the owner", async () => {
        let markOnline: () => void = () => {};
        const online = new Promise<void>((resolve) => {
            markOnline = resolve;
        });
        let markExit: () => void = () => {};
        const exited = new Promise<void>((resolve) => {
            markExit = resolve;
        });
        let workers = 0;
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["typescript"],
                createWorker: () => {
                    workers += 1;
                    if (workers > 1)
                        return new Worker(
                            `const { parentPort } = require("node:worker_threads");
                            parentPort.on("message", (request) => {
                                if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                                else parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                            });`,
                            { eval: true },
                        );

                    const current = new Worker(
                        'require("node:worker_threads").parentPort.on("message", () => {});',
                        { eval: true },
                    );
                    current.once("online", markOnline);
                    current.once("exit", markExit);

                    return current;
                },
            },
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const invalidate = () => {};
        try {
            highlightSyntaxCode(source, "typescript", { invalidate });
            await online;
            vi.advanceTimersToNextTimer();
            await settleSyntaxHighlights();
            expect(terminals().map((fields) => fields.reason)).toEqual(["worker-startup-timeout"]);
            expect(highlightSyntaxCode(source, "typescript", { invalidate })).toEqual([source]);
            await settleSyntaxHighlights();
            expect(terminals().map((fields) => fields.reason)).toEqual([
                "worker-startup-timeout",
                "worker-startup-cooldown",
            ]);

            expect(workers).toBe(1);
            await exited;
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
            vi.advanceTimersToNextTimer();
            const recovered = await highlightSyntaxCodeAsync(source, "typescript", { invalidate });
            expect(recovered.join("\n")).toContain("\u001b[");
            expect(recovered.map(stripVTControlCharacters)).toEqual([source]);

            expect(workers).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not spend the automatic timeout budget on explicit requests", async () => {
        const warnings: string[] = [];
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["javascript"],
                reportWarning: (message) => {
                    warnings.push(message);
                },
                createWorker: () =>
                    new Worker(
                        `const { parentPort } = require("node:worker_threads");
                parentPort.on("message", (request) => {
                    if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                    else if (request.code === "const healthy = 1;")
                        parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                });`,
                        { eval: true },
                    ),
            },
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let markRunning: () => void = () => {};
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "running") markRunning();
        });
        try {
            for (let index = 0; index < 101; index += 1) {
                const running = new Promise<void>((resolve) => {
                    markRunning = resolve;
                });
                const pending = highlightSyntaxCodeAsync(
                    `const explicit${index} = ${index};`,
                    "javascript",
                );
                await running;
                vi.advanceTimersToNextTimer();
                await pending;
            }

            expect(
                warnings.some((message) => message.includes("unowned syntax highlighting")),
            ).toBe(false);
            const healthy = "const healthy = 1;";
            highlightSyntaxCode(healthy, "javascript");
            await settleSyntaxHighlights();
            expect(highlightSyntaxCode(healthy, "javascript").join("\n")).toContain("\u001b[");
        } finally {
            vi.useRealTimers();
        }
    });

    it("records an automatic timeout when it joins an explicit job", async () => {
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["javascript"],
                reportWarning: () => {},
                createWorker: () =>
                    new Worker(
                        `const { parentPort } = require("node:worker_threads");
                parentPort.on("message", (request) => {
                    if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                });`,
                        { eval: true },
                    ),
            },
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let markRunning: () => void = () => {};
        const running = new Promise<void>((resolve) => {
            markRunning = resolve;
        });
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "running") markRunning();
        });
        const code = "const shared = 1;";
        try {
            const explicit = highlightSyntaxCodeAsync(code, "javascript");
            await running;
            highlightSyntaxCode(code, "javascript");
            vi.advanceTimersToNextTimer();
            await explicit;
            await settleSyntaxHighlights();
            const count = requests().filter((fields) => fields.state === "running").length;
            expect(highlightSyntaxCode(code, "javascript")).toEqual([code]);
            await settleSyntaxHighlights();
            expect(requests().filter((fields) => fields.state === "running")).toHaveLength(count);
            expect(terminals().some((fields) => fields.reason === "worker-timeout")).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps automatic timeout history after an explicit success", async () => {
        const warnings: string[] = [];
        let permitFirst = false;
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["javascript"],
                reportWarning: (message) => {
                    warnings.push(message);
                },
                createWorker: () =>
                    new Worker(
                        `const { parentPort } = require("node:worker_threads");
                const permitFirst = ${permitFirst};
                parentPort.on("message", (request) => {
                    if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                    else if (permitFirst && request.code === "const item0 = 0;")
                        parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                });`,
                        { eval: true },
                    ),
            },
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let markRunning: () => void = () => {};
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "running") markRunning();
        });
        try {
            for (let index = 0; index < 100; index += 1) {
                const running = new Promise<void>((resolve) => {
                    markRunning = resolve;
                });
                highlightSyntaxCode(`const item${index} = ${index};`, "javascript");
                await running;
                vi.advanceTimersToNextTimer();
                await settleSyntaxHighlights();
            }

            permitFirst = true;
            expect(
                (
                    await highlightSyntaxCodeAsync("const item0 = 0;", "javascript", {
                        cache: false,
                    })
                ).join("\n"),
            ).toContain("\u001b[");
            const running = new Promise<void>((resolve) => {
                markRunning = resolve;
            });
            highlightSyntaxCode("const item100 = 100;", "javascript");
            await running;
            vi.advanceTimersToNextTimer();
            await settleSyntaxHighlights();
            expect(warnings).toContainEqual(
                expect.stringContaining("unowned syntax highlighting is suspended"),
            );

            highlightSyntaxCode("const unseen = 1;", "javascript");
            expect(
                terminals().some((fields) => fields.reason === "unowned-retry-budget-exhausted"),
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("recovers a backpressured owner after worker startup times out", async () => {
        let markOnline: () => void = () => {};
        const online = new Promise<void>((resolve) => {
            markOnline = resolve;
        });
        let markExit: () => void = () => {};
        const exited = new Promise<void>((resolve) => {
            markExit = resolve;
        });
        let markCompleted: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            markCompleted = resolve;
        });
        let workers = 0;
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["javascript"],
                reportWarning: () => {},
                createWorker: () => {
                    workers += 1;
                    let workerCode = `const { parentPort } = require("node:worker_threads");
                    parentPort.on("message", (request) => {
                        if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                        else parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                    });`;
                    if (workers === 1)
                        workerCode =
                            'require("node:worker_threads").parentPort.on("message", () => {});';

                    const current = new Worker(workerCode, { eval: true });
                    if (workers === 1) {
                        current.once("online", markOnline);
                        current.once("exit", markExit);
                    }

                    return current;
                },
            },
        );
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "completed") markCompleted();
        });

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const slow = `const slow = "${"x".repeat(512 * 1024)}";`;
        const short = "const waiting = 1;";
        const slowOwner = () => {};
        const shortOwner = () => {};
        try {
            highlightSyntaxCode(slow, "javascript", { invalidate: slowOwner });
            await online;
            highlightSyntaxCode(short, "javascript", { invalidate: shortOwner });
            await vi.advanceTimersToNextTimerAsync();
            await exited;
            expect(workers).toBe(1);
            expect(terminals().some((fields) => fields.reason === "worker-startup-timeout")).toBe(
                true,
            );
            await vi.advanceTimersToNextTimerAsync();
            await completed;
            const lines = highlightSyntaxCode(short, "javascript", { invalidate: shortOwner });
            expect(lines.map(stripVTControlCharacters)).toEqual([short]);
            expect(lines.join("\n")).toContain("\u001b[");
            expect(workers).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("visibly suspends automatic unowned work after the bounded timeout budget", async () => {
        const warnings: string[] = [];
        await initializeSyntaxHighlighting(
            {},
            {
                preloadLanguages: ["typescript"],
                reportWarning: (message) => {
                    warnings.push(message);
                },
                createWorker: () =>
                    new Worker(
                        `const { parentPort } = require("node:worker_threads");
                        parentPort.on("message", (request) => {
                            if (request.type === "initialize") parentPort.postMessage({ type: "ready" });
                            else if (request.code === "const healthy = 1;")
                                parentPort.postMessage({ id: request.id, lines: ["\\x1b[31m" + request.code + "\\x1b[39m"] });
                        });`,
                        { eval: true },
                    ),
            },
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let markRunning: () => void = () => {};
        configureRenderDiagnostics((event, fields) => {
            const current = fields();
            sink(event, () => current);

            if (event === "syntax_request" && current.state === "running") markRunning();
        });
        try {
            for (let index = 0; index < 101; index += 1) {
                const running = new Promise<void>((resolve) => {
                    markRunning = resolve;
                });
                highlightSyntaxCode(`const item${index} = ${index};`, "typescript");
                await running;
                vi.advanceTimersToNextTimer();
                await settleSyntaxHighlights();
            }

            const submitted = requests().filter((fields) => fields.state === "running").length;
            expect(submitted).toBe(101);
            expect(highlightSyntaxCode("const item0 = 0;", "typescript")).toEqual([
                "const item0 = 0;",
            ]);

            expect(highlightSyntaxCode("const unseen = 1;", "typescript")).toEqual([
                "const unseen = 1;",
            ]);

            expect(
                terminals().some((fields) => fields.reason === "unowned-retry-budget-exhausted"),
            ).toBe(true);
            await settleSyntaxHighlights();
            expect(requests().filter((fields) => fields.state === "running")).toHaveLength(
                submitted,
            );

            expect(warnings).toContainEqual(
                expect.stringContaining("unowned syntax highlighting is suspended"),
            );

            const explicit = await highlightSyntaxCodeAsync("const healthy = 1;", "typescript");
            expect(explicit.join("\n")).toContain("\u001b[");
            expect(explicit.map(stripVTControlCharacters)).toEqual(["const healthy = 1;"]);

            const owned = await highlightSyntaxCodeAsync("const healthy = 1;", "typescript", {
                invalidate: () => {},
                cache: false,
            });
            expect(owned.join("\n")).toContain("\u001b[");
            expect(owned.map(stripVTControlCharacters)).toEqual(["const healthy = 1;"]);

            clearSyntaxHighlightCache();
            expect(highlightSyntaxCode("const healthy = 1;", "typescript")).toEqual([
                "const healthy = 1;",
            ]);
            await settleSyntaxHighlights();
            const recovered = highlightSyntaxCode("const healthy = 1;", "typescript");
            expect(recovered.join("\n")).toContain("\u001b[");
            expect(recovered.map(stripVTControlCharacters)).toEqual(["const healthy = 1;"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("retains request identity across real capacity rejection and reentrant retry", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const capacity = new AbortController();
        const occupied = highlightSyntaxCodeAsync("const occupied = 1;", "typescript", {
            signal: capacity.signal,
        });

        for (let index = 0; index < 99; index += 1)
            highlightSyntaxCode(`const filler = ${index};`, "typescript");

        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        const requested = requests().find((fields) => fields.ownerId !== null);
        expect(requested).toBeDefined();
        capacity.abort();
        await occupied;
        await settleSyntaxHighlights();
        const states = requests().filter((fields) => fields.requestId === requested?.requestId);
        expect(states.map((fields) => fields.state)).toEqual([
            "requested",
            "waiting-capacity",
            "queued",
            "running",
            "completed",
        ]);

        expect(states.at(-1)?.attempt).toBe(2);
        expect(states.at(-1)?.jobId).not.toBe(states[1]?.jobId);
    });

    it("terminally closes pre-ready aborts, source supersession and cache clearing", () => {
        const abort = new AbortController();
        highlightSyntaxCode(source, "typescript", { invalidate: owner, signal: abort.signal });
        abort.abort();
        observeSyntaxHighlightSource("second", owner);
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        observeSyntaxHighlightSource("third", owner);
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        clearSyntaxHighlightCache();
        expect(terminals().map((fields) => fields.state)).toEqual([
            "cancelled",
            "superseded",
            "cancelled",
        ]);

        expect(entries.at(-1)?.fields.pendingCount).toBe(0);
    });

    it("retires replaced logical component sources even when an earlier source returns", () => {
        const firstSource = "const alpha = 1;";
        const secondSource = "const beta = 2;";

        const component = (previous: Parameters<typeof createSyntaxComponent>[0], code: string) =>
            createSyntaxComponent(
                previous,
                owner,
                (invalidate) => ({
                    render: () => highlightSyntaxCode(code, "typescript", { invalidate }),
                    invalidate() {},
                }),
                code,
            );

        const first = component(undefined, firstSource);
        first.render(80);
        const second = component(first, secondSource);
        second.render(80);
        const third = component(second, firstSource);
        third.render(80);

        const starts = requests().filter(({ state }) => state === "requested");
        expect(starts.map(({ revision }) => revision)).toEqual([1, 2, 3]);
        expect(new Set(starts.map(({ ownerId }) => ownerId)).size).toBe(1);
        expect(terminals().map(({ state }) => state)).toEqual(["superseded", "superseded"]);
        expect(new Set(starts.map(({ requestId }) => requestId)).size).toBe(3);
    });

    it("cancels replaced component work and invalidates only the current source", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        let invalidations = 0;
        const invalidateHost = () => {
            invalidations += 1;
        };

        const component = (previous: Parameters<typeof createSyntaxComponent>[0], code: string) =>
            createSyntaxComponent(
                previous,
                invalidateHost,
                (invalidate) => ({
                    render: () => highlightSyntaxCode(code, "typescript", { invalidate }),
                    invalidate() {},
                }),
                code,
            );
        const first = component(undefined, "const alpha = 1;");
        first.render(80);
        const second = component(first, "const beta = 2;");
        second.render(80);
        const current = component(second, "const alpha = 1;");
        current.render(80);
        await settleSyntaxHighlights();

        expect(terminals().map(({ state }) => state)).toEqual([
            "superseded",
            "superseded",
            "completed",
        ]);

        expect(invalidations).toBe(1);
        const lines = current.render(80);
        expect(lines.join("\n")).toContain("\u001b[");
        expect(lines.map(stripVTControlCharacters)).toEqual(["const alpha = 1;"]);
    });

    it("never completes a superseded queued source or reuses its terminal for a new revision", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        observeSyntaxHighlightSource("replacement", owner);
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        await settleSyntaxHighlights();
        expect(terminals().map((fields) => fields.state)).toEqual(["superseded", "completed"]);
        expect(terminals()[0]?.ownerId).toBe(terminals()[1]?.ownerId);
        expect(terminals()[0]?.revision).toBe(1);
        expect(terminals()[1]?.revision).toBe(2);
    });

    it("reports cache adoption separately for another consumer", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        await highlightSyntaxCodeAsync(source, "typescript");
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        expect(terminals().map((fields) => fields.state)).toEqual(["completed", "cached-adopted"]);
        expect(terminals()[0]?.ownerId).toBeNull();
    });

    it("keeps shared unowned submissions distinct and ordered", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        await Promise.all([
            highlightSyntaxCodeAsync(source, "typescript"),
            highlightSyntaxCodeAsync(source, "typescript"),
        ]);
        expect(terminals()).toHaveLength(2);
        expect(new Set(terminals().map((fields) => fields.requestId)).size).toBe(2);
        expect(new Set(terminals().map((fields) => fields.jobId)).size).toBe(1);
        const sequences = entries
            .filter((entry) => entry.event.startsWith("syntax_request"))
            .map((entry) => entry.fields.seq);
        expect(sequences).toEqual([...sequences].sort((a, b) => Number(a) - Number(b)));

        for (const terminal of terminals())
            expect(
                requests().find((fields) => fields.requestId === terminal.requestId)?.state,
            ).toBe("requested");
    });

    it("closes the old sink on reset and labels midflight observations unproven", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        const oldEpoch = requests()[0]?.epoch;
        resetRenderDiagnostics();
        expect(terminals()).toHaveLength(1);
        expect(terminals()[0]?.reason).toBe("diagnostics-reset");
        configureRenderDiagnostics(undefined);
        configureRenderDiagnostics(sink);
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        expect(requests().at(-1)).toMatchObject({ observation: "late" });
        expect(requests().at(-1)?.epoch).not.toBe(oldEpoch);
        await settleSyntaxHighlights();
        expect(terminals().at(-1)).toMatchObject({
            state: "completed",
            reason: "late-result-available",
            jobObservation: "late",
            attempt: 0,
        });

        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        expect(
            entries
                .filter(({ event }) => event === "syntax_request_use")
                .map(({ fields }) => fields.reason),
        ).toEqual(["invalidation", "cache"]);

        expect(terminals()).toHaveLength(2);
    });

    it("keeps real colors and invalidations identical with diagnostics on or off", async () => {
        const results: unknown[] = [];
        for (const enabled of [false, true]) {
            await disposeSyntaxHighlighting();
            let diagnosticSink: typeof sink | undefined;
            if (enabled) diagnosticSink = sink;
            configureRenderDiagnostics(diagnosticSink);
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
            let invalidations = 0;
            const invalidate = () => {
                invalidations += 1;
            };

            const before = highlightSyntaxCode(source, "typescript", { invalidate });
            await settleSyntaxHighlights();
            const after = highlightSyntaxCode(source, "typescript", { invalidate });
            results.push({ before, after, invalidations });
            expect(after.join("\n")).toContain("\u001b[");
            expect(after.map(stripVTControlCharacters)).toEqual([source]);
        }

        expect(results[0]).toEqual(results[1]);
        expect(
            JSON.stringify(entries.filter((entry) => entry.event.startsWith("syntax_request"))),
        ).not.toContain(source);
    });

    it("replaces theme-era readiness with a new generation without completing the old intention", async () => {
        let release: (() => void) | undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const highlighter = await createSyntaxHighlighter({ themes: [], langs: ["typescript"] });
        const load = highlighter.loadLanguage.bind(highlighter);
        highlighter.loadLanguage = async (...languages) => {
            await blocked;
            await load(...languages);
        };
        await initializeSyntaxHighlighting({}, { createHighlighter: async () => highlighter });
        highlightSyntaxCode("print(12)", "python", { invalidate: owner });
        const old = requests()[0];
        await reinitializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        release?.();
        await settleSyntaxHighlights();
        expect(terminals().filter(({ requestId }) => requestId === old?.requestId)).toEqual([
            expect.objectContaining({ state: "superseded", reason: "theme-replaced" }),
        ]);

        expect(terminals().at(-1)?.state).toBe("completed");
        expect(terminals().at(-1)?.generation).not.toBe(old?.generation);
    });

    it("closes language-load failure and unsupported or unowned pre-ready calls", async () => {
        await highlightSyntaxCodeAsync(source, "typescript");
        highlightSyntaxCode(source, "imaginary-grammar", { invalidate: owner });
        const highlighter = await createSyntaxHighlighter({ themes: [], langs: [] });
        highlighter.loadLanguage = async () => {
            throw new Error("invented language failure");
        };
        await initializeSyntaxHighlighting({}, { createHighlighter: async () => highlighter });
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        await settleSyntaxHighlights();
        expect(terminals().map(({ state }) => state)).toEqual([
            "cancelled",
            "unsupported",
            "failed",
        ]);

        expect(terminals().at(-1)?.reason).toBe("language-load-failed");
    });

    it("tracks the latest pre-ready signal without reviving cancelled observations", async () => {
        const first = new AbortController();
        const current = new AbortController();
        highlightSyntaxCode(source, "typescript", { invalidate: owner, signal: first.signal });
        highlightSyntaxCode(source, "typescript", { invalidate: owner, signal: current.signal });
        first.abort();
        expect(terminals()).toHaveLength(0);
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        await settleSyntaxHighlights();
        current.abort();
        expect(terminals().map(({ state }) => state)).toEqual(["completed"]);
    });

    it("presents the current source in color after queued component replacements", async () => {
        const capabilities = getCapabilities();
        setCapabilities({ ...capabilities, trueColor: true });
        const terminal = new VirtualTerminal(60, 8);
        const tui = new TuiMainScreen(terminal);
        let current: Component | undefined;
        const update = (code: string): void => {
            current = createSyntaxComponent(
                current,
                () => tui.requestRender(),
                (invalidate) => {
                    const body: Component = {
                        render: () => highlightSyntaxCode(code, "typescript", { invalidate }),
                        invalidate() {},
                    };

                    return {
                        render: (width) => renderSyntaxComponent(body, invalidate, width),
                        invalidate: () => body.invalidate(),
                    };
                },
                code,
            );
        };
        try {
            update("const alpha = 1;");
            tui.addChild({
                render: (width) => current?.render(width) ?? [],
                invalidate: () => current?.invalidate(),
            });
            tui.start();
            await terminal.settle();
            update("const beta = 2;");
            tui.requestRender();
            await terminal.settle();
            update("const alpha = 1;");
            tui.requestRender();
            await terminal.settle();
            expect(
                requests()
                    .filter(({ state }) => state === "requested")
                    .map(({ revision }) => revision),
            ).toEqual([1, 2, 3]);
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
            await settleSyntaxHighlights();
            await terminal.settle();
            expect(
                terminal
                    .requireRowContaining("const alpha = 1;")
                    .cells.some((cell) => !cell.isForegroundDefault),
            ).toBe(true);

            expect(terminals().map(({ state }) => state)).toEqual([
                "superseded",
                "superseded",
                "completed",
            ]);
            const rendered = entries
                .filter(({ event }) => event === "syntax_component_render")
                .at(-1);
            const currentRequest = terminals().at(-1);
            expect(rendered?.fields).toMatchObject({
                ownerId: currentRequest?.ownerId,
                revision: currentRequest?.revision,
                width: 60,
                requests: [{ requestId: currentRequest?.requestId, state: "completed" }],
            });
        } finally {
            tui.stop();
            await terminal.settle(0);
            terminal.dispose();
            setCapabilities(capabilities);
        }
    });

    it("binds component render observations to the requests and returned lines", async () => {
        const code = "const visible = 9;";
        let invalidations = 0;
        const component = createSyntaxComponent(
            undefined,
            () => {
                invalidations += 1;
            },
            (invalidate) => {
                const body: Component = {
                    render: () => highlightSyntaxCode(code, "typescript", { invalidate }),
                    invalidate() {},
                };

                return {
                    render: (width) => renderSyntaxComponent(body, invalidate, width),
                    invalidate: () => body.invalidate(),
                };
            },
            code,
        );
        expect(component.render(60)).toEqual([code]);
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        await settleSyntaxHighlights();
        expect(invalidations).toBe(1);
        expect(component.render(60).join("\n")).toContain("\u001b[");

        const observations = entries.filter(({ event }) => event === "syntax_component_render");
        const request = requests().find(({ state }) => state === "requested");
        const lineHash = createHash("sha256").update(code).digest("hex").slice(0, 16);
        expect(observations.map(({ fields }) => fields)).toMatchObject([
            {
                ownerId: request?.ownerId,
                revision: 1,
                width: 60,
                lineHashes: [lineHash],
                requests: [{ requestId: request?.requestId, state: "waiting-ready" }],
            },
            {
                ownerId: request?.ownerId,
                revision: 1,
                width: 60,
                lineHashes: [lineHash],
                requests: [{ requestId: request?.requestId, state: "completed" }],
            },
        ]);
    });

    it("keeps a different owner's request distinct in the component observation", () => {
        const foreign = () => {};
        const code = "const shared = 8;";
        const component = createSyntaxComponent(
            undefined,
            owner,
            (invalidate) => {
                const body: Component = {
                    render: () => highlightSyntaxCode(code, "typescript", { invalidate: foreign }),
                    invalidate() {},
                };

                return {
                    render: (width) => renderSyntaxComponent(body, invalidate, width),
                    invalidate: () => body.invalidate(),
                };
            },
            code,
        );
        component.render(60);
        const rendered = entries.find(({ event }) => event === "syntax_component_render")?.fields;
        const request = requests().find(({ state }) => state === "requested");
        expect(rendered?.ownerId).not.toBe(request?.ownerId);
        expect(rendered?.requests).toMatchObject([
            { requestId: request?.requestId, ownerId: request?.ownerId, state: "waiting-ready" },
        ]);
    });

    it("does not claim request observations when a component returns cached lines", () => {
        const code = "const cached = 3;";
        const component = createSyntaxComponent(
            undefined,
            owner,
            (invalidate) => {
                const body = makeComponent(() =>
                    highlightSyntaxCode(code, "typescript", { invalidate }),
                );

                return {
                    render: (width) => renderSyntaxComponent(body, invalidate, width),
                    invalidate: () => body.invalidate(),
                };
            },
            code,
        );
        expect(component.render(60)).toEqual([code]);
        expect(component.render(60)).toEqual([code]);
        const observations = entries.filter(({ event }) => event === "syntax_component_render");
        expect(observations).toHaveLength(2);
        expect(observations[0]?.fields.requests).toHaveLength(1);
        expect(observations[1]?.fields.requests).toEqual([]);
        configureRenderDiagnostics(undefined);
        entries.length = 0;
        expect(component.render(60)).toEqual([code]);
        expect(entries).toEqual([]);
    });

    it("keeps actual native TUI frames identical with optional diagnostics off and on", async () => {
        const capabilities = getCapabilities();
        const frames: unknown[] = [];
        setCapabilities({ ...capabilities, trueColor: true });
        try {
            for (const enabled of [false, true]) {
                await disposeSyntaxHighlighting();
                let diagnosticSink: typeof sink | undefined;
                if (enabled) diagnosticSink = sink;
                configureRenderDiagnostics(diagnosticSink);
                const terminal = new VirtualTerminal(60, 8);
                const tui = new TuiMainScreen(terminal);
                const invalidate = () => tui.requestRender();
                tui.addChild({
                    render: () => [
                        "BEFORE_INVENTED",
                        ...highlightSyntaxCode(source, "typescript", { invalidate }),
                        "AFTER_INVENTED",
                    ],
                    invalidate() {},
                });
                try {
                    tui.start();
                    await terminal.settle();
                    const before = terminal.interpretedRows();
                    expect(
                        terminal
                            .requireRowContaining(source)
                            .cells.every((cell) => cell.isForegroundDefault),
                    ).toBe(true);
                    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
                    await settleSyntaxHighlights();
                    await terminal.settle();
                    const after = terminal.interpretedRows();
                    expect(
                        terminal
                            .requireRowContaining(source)
                            .cells.some((cell) => !cell.isForegroundDefault),
                    ).toBe(true);

                    terminal.assertUniqueTranscriptMarkers(
                        "BEFORE_INVENTED",
                        source,
                        "AFTER_INVENTED",
                    );
                    terminal.assertRowsFitWidth();
                    frames.push({ before, after });
                } finally {
                    tui.stop();
                    await terminal.settle(0);
                    terminal.dispose();
                }
            }

            expect(frames[0]).toEqual(frames[1]);
        } finally {
            setCapabilities(capabilities);
        }
    });

    it.each(["fresh", "absent"] as const)(
        "observes a new same-revision submission after external abort with %s signal",
        async (signalMode) => {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
            const abort = new AbortController();
            const cancelled = highlightSyntaxCodeAsync(source, "typescript", {
                invalidate: owner,
                signal: abort.signal,
            });
            abort.abort();
            expect(await cancelled).toEqual([source]);
            const old = terminals()[0];
            let signal: AbortSignal | undefined;
            if (signalMode === "fresh") signal = new AbortController().signal;

            const options = { invalidate: owner };
            let retried: Promise<string[]>;
            if (signal === undefined)
                retried = highlightSyntaxCodeAsync(source, "typescript", options);
            else retried = highlightSyntaxCodeAsync(source, "typescript", { ...options, signal });

            expect(
                entries.filter(({ event }) => event === "syntax_request_ledger").at(-1)?.fields
                    .pendingCount,
            ).toBe(1);

            expect(requests().filter(({ state }) => state === "requested")).toHaveLength(2);
            const result = await retried;
            expect(result.join("\n")).toContain("\u001b[");
            expect(terminals().map(({ state }) => state)).toEqual(["cancelled", "completed"]);
            const current = terminals()[1];
            expect(current?.requestId).not.toBe(old?.requestId);
            expect(current?.ownerId).toBe(old?.ownerId);
            expect(current?.revision).toBe(old?.revision);
            expect(current?.generation).toBe(old?.generation);
            expect(current?.attempt).toBe(1);
            expect(current?.jobId).not.toBe(old?.jobId);
            expect(
                requests()
                    .filter(({ requestId }) => requestId === current?.requestId)
                    .map(({ state }) => state),
            ).toEqual(["requested", "queued", "running", "completed"]);
        },
    );

    it("observes each failed same-revision resubmission to an unavailable real backend", async () => {
        const state = await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        if (state.status !== "ready") throw new Error("invented backend was not initialized");

        await state.tokenizer.dispose();
        expect(await highlightSyntaxCodeAsync(source, "typescript", { invalidate: owner })).toEqual(
            [source],
        );
        const retried = highlightSyntaxCodeAsync(source, "typescript", { invalidate: owner });
        expect(
            entries.filter(({ event }) => event === "syntax_request_ledger").at(-1)?.fields
                .pendingCount,
        ).toBe(1);

        expect(await retried).toEqual([source]);
        expect(terminals().map(({ state }) => state)).toEqual(["failed", "failed"]);
        expect(new Set(terminals().map(({ requestId }) => requestId)).size).toBe(2);
        expect(new Set(terminals().map(({ ownerId }) => ownerId)).size).toBe(1);
        expect(new Set(terminals().map(({ revision }) => revision)).size).toBe(1);
        expect(terminals().map(({ attempt }) => attempt)).toEqual([1, 1]);
    });

    it("observes a renewed same-revision readiness intention after external cancellation", async () => {
        const abort = new AbortController();
        highlightSyntaxCode(source, "typescript", { invalidate: owner, signal: abort.signal });
        abort.abort();
        highlightSyntaxCode(source, "typescript", { invalidate: owner });
        const intended = requests().at(-1);
        expect(intended?.state).toBe("waiting-ready");
        expect(entries.at(-1)?.fields.pendingCount).toBe(1);
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        await settleSyntaxHighlights();
        expect(terminals().map(({ state }) => state)).toEqual(["cancelled", "completed"]);
        expect(terminals()[1]?.requestId).toBe(intended?.requestId);
        expect(terminals()[1]?.requestId).not.toBe(terminals()[0]?.requestId);
        expect(terminals()[1]?.revision).toBe(terminals()[0]?.revision);
    });

    it("keeps a post-cancellation cache return attached to the old immutable terminal", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const abort = new AbortController();
        const cancelled = highlightSyntaxCodeAsync(source, "typescript", {
            invalidate: owner,
            signal: abort.signal,
        });
        abort.abort();
        await cancelled;
        const old = terminals()[0];
        const colors = await highlightSyntaxCodeAsync(source, "typescript");
        expect(await highlightSyntaxCodeAsync(source, "typescript", { invalidate: owner })).toEqual(
            colors,
        );

        expect(requests().filter(({ state }) => state === "requested")).toHaveLength(2);
        expect(terminals().filter(({ requestId }) => requestId === old?.requestId)).toEqual([old]);
        expect(
            entries.filter(({ event }) => event === "syntax_request_use").at(-1)?.fields,
        ).toMatchObject({ requestId: old?.requestId, state: "cancelled", reason: "cache" });
    });

    it("does not renew repeatedly aborted calls without an actual submission", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const abort = new AbortController();
        abort.abort();

        for (let index = 0; index < 3; index += 1)
            expect(
                await highlightSyntaxCodeAsync(source, "typescript", {
                    invalidate: owner,
                    signal: abort.signal,
                }),
            ).toEqual([source]);

        expect(requests().map(({ state }) => state)).toEqual(["requested", "cancelled"]);
        expect(
            entries.filter(({ event }) => event === "syntax_request_ledger").at(-1)?.fields
                .pendingCount,
        ).toBe(0);
    });

    it("preserves real abort, pending-join, resubmission and cache behavior with diagnostics off/on", async () => {
        const results: unknown[] = [];
        for (const enabled of [false, true]) {
            await disposeSyntaxHighlighting();
            let diagnosticSink: typeof sink | undefined;
            if (enabled) diagnosticSink = sink;
            configureRenderDiagnostics(diagnosticSink);
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
            let invalidations = 0;
            const invalidate = () => {
                invalidations += 1;
            };

            const abort = new AbortController();
            const first = highlightSyntaxCodeAsync(source, "typescript", {
                invalidate,
                signal: abort.signal,
            });
            abort.abort();
            const joined = highlightSyntaxCodeAsync(source, "typescript", { invalidate });
            const cancelled = await Promise.all([first, joined]);
            const available = await highlightSyntaxCodeAsync(source, "typescript", { invalidate });
            const cached = highlightSyntaxCode(source, "typescript", { invalidate });
            expect(available.join("\n")).toContain("\u001b[");
            results.push({ cancelled, available, cached, invalidations });
        }

        expect(results[0]).toEqual(results[1]);
        expect(terminals().map(({ state }) => state)).toEqual(["cancelled", "completed"]);
    });
});
