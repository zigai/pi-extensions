import { setImmediate as nextJob } from "node:timers/promises";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serviceEventsFixture } from "../../pi-toggles/test/service-events-fixture.ts";
import { createThreadGoal } from "../src/state.ts";
import type { createGoalToolPolicyController as ControllerFactory } from "../src/goal-tool-policy.ts";
import type { TogglesService as ServiceType } from "../../pi-toggles/src/toggles-service.ts";

// Run from any directory. Before uses saved checkout files, not git HEAD.
// Both modes intentionally use the SAME current resolver: this measures service
// event amplification independently of the policy-resolution worker's changes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function collect(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await nextJob();
    global.gc?.();
  }
}

const mode = process.argv[2] ?? "after";
const scenario = process.argv[3] ?? "unchanged";
assert(["before", "after"].includes(mode));
assert(["unchanged", "changing", "refresh", "legacy-events"].includes(scenario));
assert(global.gc, "Run node --expose-gc --import tsx");

const baseline = resolve(
  process.env.GOAL_BASELINE_DIR ?? resolve(root, ".cache/perf-followup/goal"),
);

function moduleURL(saved: string, source: string): string {
  if (mode === "after") return pathToFileURL(resolve(root, source)).href;

  const originalPath = resolve(root, source);
  const content = readFileSync(resolve(baseline, saved), "utf8").replace(
    /from "(\.\/.+?)"/g,
    (_match: string, relative: string) => {
      if (saved === "toggles-service.ts" && relative === "./context-facts.ts") {
        return `from ${JSON.stringify(moduleURL("context-facts.ts", "extensions/pi-toggles/src/context-facts.ts"))}`;
      }

      return `from ${JSON.stringify(resolve(dirname(originalPath), relative))}`;
    },
  );
  const generated = resolve(baseline, "generated", saved);
  mkdirSync(dirname(generated), { recursive: true });
  writeFileSync(generated, content);

  return pathToFileURL(generated).href;
}

function isControllerModule(
  value: unknown,
): value is { createGoalToolPolicyController: typeof ControllerFactory } {
  return (
    typeof value === "object" &&
    value !== null &&
    "createGoalToolPolicyController" in value &&
    typeof value.createGoalToolPolicyController === "function"
  );
}

function isServiceModule(value: unknown): value is { TogglesService: typeof ServiceType } {
  return (
    typeof value === "object" &&
    value !== null &&
    "TogglesService" in value &&
    typeof value.TogglesService === "function"
  );
}

const controllerModule: unknown = await import(
  moduleURL("goal-tool-policy.ts", "extensions/pi-goal/src/goal-tool-policy.ts")
);

const serviceModule: unknown = await import(
  moduleURL("toggles-service.ts", "extensions/pi-toggles/src/toggles-service.ts")
);

assert(isControllerModule(controllerModule));
assert(isServiceModule(serviceModule));
const { createGoalToolPolicyController } = controllerModule;
const { TogglesService } = serviceModule;
const ruleCount = Number(process.env.GOAL_BENCH_RULES ?? 20);
assert(Number.isSafeInteger(ruleCount) && ruleCount >= 0 && ruleCount <= 1000);

const h = serviceEventsFixture({
  toolCount: 100,
  Service: TogglesService,
  settings: {
    rules: Array.from({ length: ruleCount }, (_, index) => ({
      id: `goal-rule-${index}`,
      priority: 0,
      activateProfiles: [],
      when: { fact: "goal.status", equals: "active" },
      decisions: [{ target: { kind: "tool", name: `tool_${index % 100}` }, state: "off" }],
    })),
  },
});
const controller = createGoalToolPolicyController(h.pi, h.pi.events);

try {
  await h.service.initialize();
  controller.startSession("session-one");

  const goal = createThreadGoal("ship", undefined, 0);
  controller.sync(goal);
  await h.service.settleActivation();

  // Warm up the actual scenario without leaving changed state at the boundary.
  for (let index = 0; index < 100; index++) {
    controller.sync(goal);
    await h.service.settleActivation();
  }

  const beforeCounts = { ...h.counts };

  // The baseline predates the revision getter.
  const revisionSource: Partial<Pick<ServiceType, "revisions">> = h.service;
  const beforeRevisions = revisionSource.revisions;
  const iterations = { unchanged: 10000, changing: 500, refresh: 1000, "legacy-events": 10000 }[
    scenario
  ];
  assert(iterations !== undefined);
  await collect();

  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const start = performance.now();

  for (let index = 0; index < iterations; index++) {
    if (scenario === "refresh") {
      await h.service.refresh();
    } else if (scenario === "legacy-events") {
      // Identical events from an older publisher must not hide service churn.
      h.pi.events.emit("pi-toggles:register-context-key", {
        owner: "pi-goal",
        key: "goal.status",
        type: "string",
        description: "Authoritative Goal lifecycle status; absent when no goal exists.",
      });
      h.pi.events.emit("pi-toggles:set-context", {
        owner: "pi-goal",
        key: "goal.status",
        value: "active",
      });
      h.pi.events.emit("pi-goal:tool-policy", {
        version: 1,
        sessionId: "session-one",
        status: "active",
        disabledTools: ["ask_user_question"],
      });
    } else if (scenario === "changing") {
      let status: "active" | "blocked" = "active";
      if (index % 2 === 0) status = "blocked";
      controller.sync({ ...goal, status, updatedAt: index });
    } else {
      controller.sync({ ...goal, updatedAt: index });
    }

    await h.service.settleActivation();
  }

  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);

  await collect();

  const counts = {
    catalogs: h.counts.catalogs - beforeCounts.catalogs,
    allTools: h.counts.allTools - beforeCounts.allTools,
    activeReads: h.counts.activeReads - beforeCounts.activeReads,
    writes: h.counts.writes - beforeCounts.writes,
    events: h.counts.events - beforeCounts.events,
  };

  // The saved baseline runs exactly one resolver call per catalog scan. The new
  // service exposes actual input/computation revisions, independent of scans.
  let planEvaluations = counts.catalogs;
  const afterRevisions = revisionSource.revisions;
  if (beforeRevisions !== undefined && afterRevisions !== undefined) {
    planEvaluations = afterRevisions.plan - beforeRevisions.plan;
  }

  assert(!h.active.includes("ask_user_question"));

  if (mode === "after" && ["unchanged", "legacy-events"].includes(scenario))
    assert.equal(counts.catalogs, 0);

  if (scenario === "refresh") assert(counts.catalogs >= iterations);
  if (scenario === "refresh" || scenario === "changing") assert(planEvaluations >= iterations);

  console.log(
    JSON.stringify({
      mode,
      scenario,
      node: process.version,
      iterations,
      tools: 101,
      rules: ruleCount,
      wallMs,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      peakRSSKiB: process.resourceUsage().maxRSS,
      retainedHeapBytes: process.memoryUsage().heapUsed - heapBefore,
      counts,
      planEvaluations,
    }),
  );
} finally {
  controller.dispose();
  await h.close();
}
