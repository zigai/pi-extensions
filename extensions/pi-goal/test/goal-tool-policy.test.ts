import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGoalToolPolicyController } from "../src/goal-tool-policy.js";
import { createThreadGoal } from "../src/state.js";
import { createRuntimeHarness, sessionShutdownEvent } from "./support/runtime-harness.js";

function createHarness(availableNames: readonly string[], activeNames: readonly string[]) {
  const available = new Set(availableNames);
  let active = [...activeNames];
  const changes: string[][] = [];
  const host = {
    getActiveTools: () => [...active],
    getAllTools: () =>
      [...available].map((name) => ({ name })) as ReturnType<ExtensionAPI["getAllTools"]>,
    setActiveTools(names: string[]) {
      active = [...names];
      changes.push([...names]);
    },
  } satisfies Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">;

  return {
    available,
    changes,
    controller: createGoalToolPolicyController(host),
    get active() {
      return active;
    },
    activate(name: string) {
      if (!active.includes(name)) {
        active.push(name);
      }
    },
  };
}

function writeProjectToolSettings(cwd: string, disabledTools: readonly string[]): void {
  const path = join(cwd, ".pi", "pi-codex-goal", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ disabledToolsWhileGoalActive: disabledTools }, null, 2)}\n`,
    "utf8",
  );
}

test("active-goal tool policy is relative and restores previous states", () => {
  const harness = createHarness(
    ["read", "ask_user_question", "get_goal", "update_goal"],
    ["read", "ask_user_question", "get_goal", "update_goal"],
  );
  const goal = createThreadGoal("ship", undefined, 0);
  harness.controller.configure({ disabledTools: ["ask_user_question"] });

  harness.controller.sync(goal);
  assert.deepEqual(harness.active, ["read", "get_goal", "update_goal"]);

  harness.controller.sync({ ...goal, status: "blocked" });
  assert.deepEqual(harness.active, ["read", "get_goal", "update_goal", "ask_user_question"]);
});

test("tool policy preserves unrelated changes and handles tools registered later", () => {
  const harness = createHarness(["read", "get_goal", "update_goal"], ["read"]);
  const goal = createThreadGoal("ship", undefined, 0);
  harness.controller.configure({ disabledTools: ["late_tool"] });

  harness.controller.sync(goal);
  harness.available.add("late_tool");
  harness.activate("late_tool");
  harness.available.add("new_unrelated_tool");
  harness.activate("new_unrelated_tool");
  harness.controller.sync(goal);
  assert.equal(harness.active.includes("late_tool"), false);
  assert.equal(harness.active.includes("new_unrelated_tool"), true);

  harness.controller.release();
  assert.equal(harness.active.includes("late_tool"), true);
  assert.equal(harness.active.includes("new_unrelated_tool"), true);
});

test("changing configured disabled tools restores the old policy first", () => {
  const harness = createHarness(
    ["read", "ask_user_question", "get_goal", "update_goal"],
    ["read", "ask_user_question"],
  );
  const goal = createThreadGoal("ship", undefined, 0);
  harness.controller.configure({ disabledTools: ["ask_user_question"] });
  harness.controller.sync(goal);
  assert.equal(harness.active.includes("ask_user_question"), false);

  harness.controller.configure({ disabledTools: ["read"] });
  harness.controller.sync(goal);
  assert.equal(harness.active.includes("ask_user_question"), true);
  assert.equal(harness.active.includes("read"), false);
});

test("runtime applies settings-based disabled tools only while a goal is active", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-goal-tool-runtime-"));
  writeProjectToolSettings(cwd, ["ask_user_question"]);
  try {
    const harness = createRuntimeHarness({
      cwd,
      availableTools: ["read", "ask_user_question"],
      activeTools: ["read", "ask_user_question"],
    });
    await harness.reloadSession();

    await harness.runTool("create_goal", { objective: "ship" });
    assert.equal(harness.activeTools.includes("ask_user_question"), false);

    await harness.runTool("update_goal", { status: "blocked" });
    assert.equal(harness.snapshot().goal?.status, "blocked");
    assert.equal(harness.activeTools.includes("ask_user_question"), true);

    await harness.runCommand("resume");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.activeTools.includes("ask_user_question"), false);

    await harness.runTool("update_goal", { status: "complete" });
    assert.equal(harness.activeTools.includes("ask_user_question"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("session shutdown releases settings-based disabled tools", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-goal-tool-shutdown-"));
  writeProjectToolSettings(cwd, ["ask_user_question"]);
  try {
    const harness = createRuntimeHarness({
      cwd,
      availableTools: ["read", "ask_user_question"],
      activeTools: ["read", "ask_user_question"],
    });
    await harness.reloadSession();
    await harness.runTool("create_goal", { objective: "ship" });
    assert.equal(harness.activeTools.includes("ask_user_question"), false);

    await harness.emit("session_shutdown", sessionShutdownEvent("reload"));
    assert.equal(harness.activeTools.includes("ask_user_question"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
