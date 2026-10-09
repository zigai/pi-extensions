import assert from "node:assert/strict";
import { test } from "vitest";

import {
    getVisibleOutputTokens,
    isProviderOutputEvent,
    TurnTokenThroughputTracker,
} from "../src/token-throughput.ts";

test("visible output excludes provider-reported reasoning", () => {
    assert.equal(getVisibleOutputTokens({ output: 120, reasoning: 20 }), 100);
    assert.equal(getVisibleOutputTokens({ output: 120 }), 120);
    assert.equal(getVisibleOutputTokens({ output: 20, reasoning: 30 }), 0);
});

test("provider output starts on text, thinking, and tool-call content events", () => {
    const outputEvents = [
        "text_start",
        "text_delta",
        "text_end",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
    ] as const;
    for (const event of outputEvents) {
        assert.equal(isProviderOutputEvent(event), true);
    }

    assert.equal(isProviderOutputEvent("start"), false);
    assert.equal(isProviderOutputEvent("done"), false);
    assert.equal(isProviderOutputEvent("error"), false);
});

test("aggregates the OpenCode reference turn without counting its tool gap", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep();
    tracker.markOutput(1_000);
    tracker.finishStep(3_000, { output: 20 });
    tracker.startStep();
    tracker.markOutput(20_000);
    tracker.finishStep(23_000, { output: 30 });

    assert.deepEqual(tracker.result(), {
        status: "available",
        measurement: {
            tokensPerSecond: 10,
            visibleOutputTokens: 50,
            streamDurationMs: 5_000,
            stepCount: 2,
        },
    });
});

test("uses the first output once and excludes reasoning from the weighted total", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep();
    tracker.markOutput(1_000);
    tracker.markOutput(1_500);
    tracker.finishStep(3_000, { output: 220, reasoning: 20 });

    assert.deepEqual(tracker.result(), {
        status: "available",
        measurement: {
            tokensPerSecond: 100,
            visibleOutputTokens: 200,
            streamDurationMs: 2_000,
            stepCount: 1,
        },
    });
});

test("suppresses a turn when positive output lacks a provider-output boundary", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep();
    tracker.finishStep(2_000, { output: 100 });

    assert.deepEqual(tracker.result(), {
        status: "unavailable",
        reason: "incomplete-step",
    });
});

test("an empty step does not invalidate measurable calls in the same turn", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep();
    tracker.markOutput(0);
    tracker.finishStep(1_000, { output: 100 });
    tracker.startStep();
    tracker.finishStep(5_000, { output: 0 });

    assert.deepEqual(tracker.result(), {
        status: "available",
        measurement: {
            tokensPerSecond: 100,
            visibleOutputTokens: 100,
            streamDurationMs: 1_000,
            stepCount: 2,
        },
    });
});

test("distinguishes no visible output from a zero-duration stream", () => {
    const noOutput = new TurnTokenThroughputTracker();
    noOutput.startStep();
    noOutput.markOutput(0);
    noOutput.finishStep(1_000, { output: 20, reasoning: 20 });
    assert.deepEqual(noOutput.result(), {
        status: "unavailable",
        reason: "no-visible-output",
    });

    const zeroDuration = new TurnTokenThroughputTracker();
    zeroDuration.startStep();
    zeroDuration.markOutput(1_000);
    zeroDuration.finishStep(1_000, { output: 20 });
    assert.deepEqual(zeroDuration.result(), {
        status: "unavailable",
        reason: "zero-duration",
    });
});

test("reset starts a new user turn", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep();
    tracker.markOutput(0);
    tracker.finishStep(1_000, { output: 100 });
    tracker.reset();

    assert.deepEqual(tracker.result(), {
        status: "unavailable",
        reason: "no-steps",
    });
});

test("rejects malformed or unfinished step lifecycles", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep();
    tracker.markOutput(2_000);
    tracker.startStep();
    tracker.markOutput(3_000);
    tracker.finishStep(2_500, { output: 100 });

    assert.deepEqual(tracker.result(), {
        status: "unavailable",
        reason: "incomplete-step",
    });
});

test("startStep timestamp measures full step duration for non-streaming or late-burst responses", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep(1_000);

    // Late output delta right before step completion
    tracker.markOutput(4_990);
    tracker.finishStep(5_000, { output: 200 });

    assert.deepEqual(tracker.result(), {
        status: "available",
        measurement: {
            tokensPerSecond: 50,
            visibleOutputTokens: 200,
            streamDurationMs: 4_000,
            stepCount: 1,
        },
    });
});

test("errored or aborted steps invalidate token throughput", () => {
    const tracker = new TurnTokenThroughputTracker();

    tracker.startStep(1_000);
    tracker.markOutput(1_100);
    tracker.finishStep(2_000, { output: 50 }, "error");

    assert.deepEqual(tracker.result(), {
        status: "unavailable",
        reason: "incomplete-step",
    });
});
