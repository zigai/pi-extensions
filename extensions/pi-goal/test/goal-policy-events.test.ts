import { afterEach, expect, test } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createGoalToolPolicyController } from "../src/goal-tool-policy.ts";
import { createThreadGoal } from "../src/state.ts";
import { serviceEventsFixture } from "../../pi-toggles/test/service-events-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function setup() {
  const h = serviceEventsFixture();
  const controller = createGoalToolPolicyController(h.pi, h.pi.events);
  cleanups.push(async () => {
    controller.dispose();
    await h.close();
  });

  return { h, controller };
}

test("10000 unchanged Goal accounting/tool synchronizations do not rebuild the real Toggles service", async () => {
  const { h, controller } = setup();
  controller.startSession("session-one");
  const goal = createThreadGoal("ship", undefined, 0);
  controller.sync(goal);
  await h.service.settleActivation();
  const counts = { ...h.counts };
  const plan = h.service.plan;

  for (let index = 0; index < 10000; index++) {
    controller.sync({ ...goal, updatedAt: index });
  }

  await h.service.settleActivation();
  expect(h.counts).toEqual(counts);
  expect(h.service.plan).toBe(plan);
  expect(h.active).not.toContain("ask_user_question");
});

test("a service registered after Goal's initial publication learns the current state on ready", async () => {
  const h = serviceEventsFixture();
  const events = createEventBus();
  const controller = createGoalToolPolicyController(h.pi, events);
  cleanups.push(async () => {
    controller.dispose();
    await h.close();
  });

  controller.startSession("session-one");
  const goal = createThreadGoal("ship", undefined, 0);
  controller.sync(goal);

  // Nothing was listening to Goal's initial publications. The fallback owns
  // the restriction until a service accepts the subsequent ready handshake.
  expect(h.counts.events).toBe(0);

  for (const name of [
    "pi-toggles:register-context-key",
    "pi-toggles:set-context",
    "pi-goal:tool-policy",
  ]) {
    events.on(name, (value) => h.pi.events.emit(name, value));
  }

  h.pi.events.on("pi-goal:tool-policy-accepted", (value) =>
    events.emit("pi-goal:tool-policy-accepted", value),
  );

  events.emit("pi-toggles:context-ready", { version: 1, sessionId: "session-one" });
  await h.service.settleActivation();
  expect(h.counts.events).toBe(3);
  expect(h.active).not.toContain("ask_user_question");
  const counts = { ...h.counts };
  controller.sync(goal);
  expect(h.counts).toEqual(counts);
});

test("late service readiness and replacement re-publish declarations and current state", async () => {
  const { h, controller } = setup();
  const emitted: string[] = [];

  for (const name of [
    "pi-toggles:register-context-key",
    "pi-toggles:set-context",
    "pi-goal:tool-policy",
  ]) {
    h.pi.events.on(name, () => {
      emitted.push(name);
    });
  }

  controller.startSession("session-one");
  const goal = createThreadGoal("ship", undefined, 0);
  controller.sync(goal);
  await h.service.settleActivation();
  emitted.length = 0;
  h.pi.events.emit("pi-toggles:context-ready", { version: 1, sessionId: "stale" });
  expect(emitted).toEqual([]);

  // Replacing the owner with identical declarations still needs a handshake.
  await h.reset("session-one");
  h.pi.events.emit("pi-toggles:context-ready", { version: 1, sessionId: "session-one" });
  await h.service.settleActivation();
  expect(emitted).toContain("pi-toggles:register-context-key");
  expect(emitted).toContain("pi-toggles:set-context");
  expect(emitted).toContain("pi-goal:tool-policy");
  expect(h.active).not.toContain("ask_user_question");
});

test("status/config changes publish only meaningful state and session reset declares again", async () => {
  const { h, controller } = setup();
  let declarations = 0;
  let facts = 0;
  let policies = 0;
  h.pi.events.on("pi-toggles:register-context-key", () => {
    declarations++;
  });

  h.pi.events.on("pi-toggles:set-context", () => {
    facts++;
  });

  h.pi.events.on("pi-goal:tool-policy", () => {
    policies++;
  });

  controller.startSession("session-one");
  const goal = createThreadGoal("ship", undefined, 0);
  controller.sync(goal);
  await h.service.settleActivation();
  expect([declarations, facts, policies]).toEqual([1, 2, 2]);
  controller.configure({ disabledTools: ["tool_0"] });
  controller.sync(goal);
  await h.service.settleActivation();
  expect([declarations, facts, policies]).toEqual([1, 2, 3]);
  expect(h.active).not.toContain("tool_0");
  controller.sync({ ...goal, status: "blocked" });
  await h.service.settleActivation();
  expect([declarations, facts, policies]).toEqual([1, 3, 4]);
  expect(h.active).toContain("ask_user_question");
  expect(h.active).toContain("tool_0");
  controller.release();
  await h.reset();
  controller.startSession("session-two");
  controller.sync(goal);
  await h.service.settleActivation();
  expect(declarations).toBe(2);
  expect(h.active).not.toContain("ask_user_question");
});

test("delegation withdrawal restores standalone enforcement and discovers late restricted tools", async () => {
  const { h, controller } = setup();
  controller.configure({ disabledTools: ["late_tool"] });
  controller.startSession("session-one");
  const goal = createThreadGoal("ship", undefined, 0);
  controller.sync(goal);
  await h.service.settleActivation();
  h.service.dispose();
  h.addTool("late_tool");
  controller.sync(goal);
  expect(h.active).not.toContain("late_tool");
  expect(controller.canInvoke("late_tool")).toBe(false);
  controller.release();
  expect(h.active).toContain("late_tool");
});
