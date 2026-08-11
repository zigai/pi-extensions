import assert from "node:assert/strict";
import { describe, test } from "vitest";

import {
  createGoalGlowupRendering,
  getGoalGlowupRendering,
  updateGoalGlowupRendering,
} from "../src/glowup-rendering.js";

const goalResult = {
  content: [],
  details: {
    goal: {
      goalId: "goal-1",
      objective: "Ship the migration",
      status: "active",
      minimumActiveSeconds: null,
      maximumActiveSeconds: null,
      tokensUsed: 125_000,
      timeUsedSeconds: 125,
      createdAt: 1,
      updatedAt: 2,
    },
  },
};

describe("Glowup goal rendering", () => {
  test("parses each public argument contract and rejects malformed values", () => {
    assert.deepEqual(getGoalGlowupRendering.parseArgs({}), {});
    assert.equal(getGoalGlowupRendering.parseArgs(null), undefined);

    assert.deepEqual(
      createGoalGlowupRendering.parseArgs({
        objective: "Ship",
        minimum_time_minutes: 2,
        maximum_time_minutes: 5,
        replace_existing: true,
      }),
      {
        objective: "Ship",
        minimum_time_minutes: 2,
        maximum_time_minutes: 5,
        replace_existing: true,
      },
    );
    assert.equal(
      createGoalGlowupRendering.parseArgs({ objective: "Ship", minimum_time_minutes: 0 }),
      undefined,
    );

    assert.deepEqual(updateGoalGlowupRendering.parseArgs({ status: "complete" }), {
      status: "complete",
    });
    assert.equal(updateGoalGlowupRendering.parseArgs({ status: "active" }), undefined);
  });

  test("renders tool-specific calls and completion semantics", () => {
    const getArgs = getGoalGlowupRendering.parseArgs({});
    const createArgs = createGoalGlowupRendering.parseArgs({ objective: "Ship" });
    const completeArgs = updateGoalGlowupRendering.parseArgs({ status: "complete" });
    const blockedArgs = updateGoalGlowupRendering.parseArgs({ status: "blocked" });
    assert.ok(getArgs && createArgs && completeArgs && blockedArgs);

    assert.deepEqual(getGoalGlowupRendering.renderCall(), {
      kind: "call",
      labels: { static: "Check Goal", running: "Checking Goal", completed: "Checked Goal" },
    });
    assert.deepEqual(createGoalGlowupRendering.renderCall(createArgs), {
      kind: "call",
      labels: { static: "Create Goal", running: "Creating Goal", completed: "Created Goal" },
      body: { kind: "text", text: "Ship" },
      preview: { mode: "head", collapsedLines: 4 },
    });
    assert.equal(updateGoalGlowupRendering.renderCall(completeArgs).labels.static, "Complete Goal");
    assert.equal(updateGoalGlowupRendering.renderCall(blockedArgs).labels.static, "Update Goal");
  });

  test("renders current and restored goal results with bounded usage metadata", () => {
    const parsed = getGoalGlowupRendering.parseResult(goalResult);
    assert.ok(parsed);
    const rendered = getGoalGlowupRendering.renderResult(parsed);
    assert.equal(rendered.kind, "output");
    assert.equal(rendered.text, "active: Ship the migration (125K tok, 2m)");

    const restored = getGoalGlowupRendering.parseResult({
      content: [{ type: "text", text: JSON.stringify({ goal: goalResult.details.goal }) }],
    });
    assert.deepEqual(restored, parsed);
    assert.deepEqual(getGoalGlowupRendering.parseResult({ details: { goal: null } }), {
      goal: null,
    });
    assert.equal(
      getGoalGlowupRendering.parseResult({ details: { goal: { status: "active" } } }),
      undefined,
    );
  });
});
