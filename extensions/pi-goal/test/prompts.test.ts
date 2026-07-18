import assert from "node:assert/strict";
import { test } from "vitest";

import {
  GOAL_TOOL_NAME_GUIDANCE,
  TOOL_PROMPT_GUIDELINES,
  compactContinuationPrompt,
  completionAuditContinuationPromptSection,
  completionAuditToolGuidelines,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  goalToolReference,
  supersededContinuationMessage,
  timeLimitPrompt,
} from "../src/prompts.js";
import { createGoal } from "../src/state.js";

test("tool prompt guidelines include exposed and namespaced goal tool guidance", () => {
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /available tool list/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__get_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__create_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /pi__update_goal/);
  assert.match(
    GOAL_TOOL_NAME_GUIDANCE,
    /Do not assume display, history, or transcript tool names are callable/,
  );

  assert.equal(
    goalToolReference("update_goal"),
    "update_goal (or the exposed namespaced equivalent, such as pi__update_goal)",
  );

  const combined = TOOL_PROMPT_GUIDELINES.join("\n");
  assert.match(combined, /get_goal \(or the exposed namespaced equivalent, such as pi__get_goal\)/);
  assert.match(
    combined,
    /create_goal \(or the exposed namespaced equivalent, such as pi__create_goal\)/,
  );
  assert.match(
    combined,
    /update_goal \(or the exposed namespaced equivalent, such as pi__update_goal\)/,
  );
  assert.match(combined, /status blocked only when no safe in-scope path remains/);
  assert.match(combined, /does not grant new authority/);
  for (const guideline of completionAuditToolGuidelines()) {
    assert.ok(TOOL_PROMPT_GUIDELINES.includes(guideline));
  }
});

test("continuation prompt uses the concise completion-audit contract", () => {
  const created = createGoal(null, "ship it", {
    minimumActiveSeconds: 5,
    maximumActiveSeconds: 10,
  }).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  assert.match(
    continuation,
    /Before deciding that the goal is achieved, perform a completion audit/,
  );
  assert.match(continuation, /Map every explicit requirement and deliverable to current evidence/);
  assert.match(continuation, /proxy signals are not completion by themselves/);
  assert.match(continuation, /status "blocked"/);
  assert.ok(continuation.includes(completionAuditContinuationPromptSection().join("\n")));
});

test("compact continuation keeps marker detection and the exact objective", () => {
  const created = createGoal(null, "ship it").goal;
  assert.ok(created);

  const compact = compactContinuationPrompt(created);
  const full = continuationPrompt(created);

  assert.equal(continuationGoalIdFromPrompt(compact), created.goalId);
  assert.match(compact, /<pi_goal_continuation goal_id="/);
  assert.match(compact, /<untrusted_objective>[\s\S]*ship it[\s\S]*<\/untrusted_objective>/);
  assert.match(compact, /status "blocked"/);
  assert.ok(compact.length < full.length);
});

test("superseded continuation bookkeeping does not expose a runnable marker", () => {
  const created = createGoal(null, "ship it").goal;
  assert.ok(created);

  const superseded = supersededContinuationMessage(created.goalId);
  assert.equal(continuationGoalIdFromPrompt(superseded), null);
  assert.match(superseded, /Superseded hidden goal continuation bookkeeping/);
});

test("continuation and time-limit prompts reference exposed goal-completion tool names", () => {
  const created = createGoal(null, "ship it", {
    minimumActiveSeconds: null,
    maximumActiveSeconds: 10,
  }).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  const limited = timeLimitPrompt(created);

  assert.match(limited, /marked the goal as timeLimited/);
  assert.doesNotMatch(limited, /token budget/i);

  for (const prompt of [continuation, limited]) {
    assert.match(
      prompt,
      /update_goal \(or the exposed namespaced equivalent, such as pi__update_goal\)/,
    );
    assert.match(prompt, /pi__update_goal/);
  }
});
