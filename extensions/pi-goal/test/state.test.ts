import assert from "node:assert/strict";
import test from "node:test";

import { formatBudget, formatDuration, formatFooterStatus, formatGoalSummary, formatTokenValue } from "../src/format.js";
import {
  applyUsage,
  clearEntry,
  createGoal,
  goalWithLiveUsage,
  reconstructGoal,
  setEntry,
  updateGoalStatus,
} from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";

test("createGoal validates objective and positive token budgets", () => {
  assert.equal(createGoal(null, "   ").ok, false);
  assert.equal(createGoal(null, "ship it", 0).ok, false);

  const result = createGoal(null, " ship it ", 123);

  assert.equal(result.ok, true);
  assert.equal(result.goal?.objective, "ship it");
  assert.equal(result.goal?.status, "active");
  assert.equal(result.goal?.tokenBudget, 123);
});

test("reconstructGoal follows branch-local set and clear entries", () => {
  const created = createGoal(null, "finish").goal;
  assert.ok(created);

  const branch = [
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(created, "tool", 1) },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: clearEntry(created.goalId, "command", 2) },
    { type: "message", message: { role: "assistant" } },
  ];

  assert.deepEqual(reconstructGoal(branch), { goal: null, hasGoal: false });
});

test("applyUsage marks active goals budgetLimited after crossing budget", () => {
  const created = createGoal(null, "finish", 10).goal;
  assert.ok(created);

  const result = applyUsage(created, 12, 7);

  assert.equal(result.changed, true);
  assert.equal(result.crossedBudget, true);
  assert.equal(result.goal?.status, "budgetLimited");
  assert.equal(result.goal?.usage.tokensUsed, 12);
  assert.equal(result.goal?.usage.activeSeconds, 7);
});

test("updateGoalStatus marks completion without clearing final usage", () => {
  const created = createGoal(null, "finish", 10).goal;
  assert.ok(created);
  const used = applyUsage(created, 5, 9).goal;
  assert.ok(used);

  const result = updateGoalStatus(used, "complete");

  assert.equal(result.ok, true);
  assert.equal(result.goal?.status, "complete");
  assert.equal(result.goal?.usage.tokensUsed, 5);
  assert.equal(result.goal?.usage.activeSeconds, 9);
});

test("applyUsage accumulates supplied token deltas", () => {
  const created = createGoal(null, "finish", 1_000_000).goal;
  assert.ok(created);

  const firstTurn = applyUsage(created, 123_456, 3).goal;
  assert.ok(firstTurn);
  const secondTurn = applyUsage(firstTurn, 987_654, 5).goal;

  assert.equal(secondTurn?.usage.tokensUsed, 1_111_110);
  assert.equal(secondTurn?.usage.activeSeconds, 8);
  assert.equal(secondTurn?.status, "budgetLimited");
});

test("formatters produce compact summaries", () => {
  const created = createGoal(null, "finish", 10).goal;
  assert.ok(created);

  assert.equal(formatDuration(3661), "1h 1m 1s");
  assert.match(formatGoalSummary(created), /Goal: finish/);
  assert.match(formatGoalSummary(created), /0\/10 tokens/);
});

test("token formatting uses commas and compact abbreviations", () => {
  assert.equal(formatTokenValue(12_345), "12,345");
  assert.equal(formatTokenValue(123_456), "123K (123,456)");
  assert.equal(formatTokenValue(123_456_789), "123M (123,456,789)");
  assert.equal(formatTokenValue(1_234_567_890), "1.23B (1,234,567,890)");
});

test("budget and footer include formatted tokens and active time", () => {
  const created = createGoal(null, "finish", 2_000_000).goal;
  assert.ok(created);
  const used = applyUsage(created, 123_456, 65).goal;
  assert.ok(used);

  assert.equal(formatBudget(used), "123K (123,456)/2M (2,000,000) tokens");
  assert.equal(formatFooterStatus(used), "Goal active: 123K (123,456)/2M (2,000,000) tokens, 1m 5s");
});

test("goalWithLiveUsage adds in-progress active time for display", () => {
  const created = createGoal(null, "finish").goal;
  assert.ok(created);

  const live = goalWithLiveUsage(created, created.goalId, 1_000, 11_250);

  assert.equal(live?.usage.activeSeconds, 10);
  assert.equal(created.usage.activeSeconds, 0);
});
