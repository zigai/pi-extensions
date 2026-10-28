import { stripVTControlCharacters } from "node:util";
import Type from "typebox";
import { Value } from "typebox/value";
import { getCapabilities, setCapabilities, TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "../../support/virtual-terminal.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DebugLogFields } from "../../../src/diagnostics/logger.ts";
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
    for (const entry of entries.filter(({ event }) => event.startsWith("syntax_request"))) {
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
});
