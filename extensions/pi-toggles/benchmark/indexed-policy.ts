import { setImmediate as nextJob } from "node:timers/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Capability } from "../src/capability.ts";
import type { PolicyConfiguration } from "../src/capability-policy.ts";

// Fresh-process comparison against a saved pre-edit source directory (not clean Git HEAD).
async function collect(): Promise<void> {
    for (let index = 0; index < 3; index++) {
        await nextJob();
        global.gc?.();
    }
}

const variant = process.argv[2] ?? "after";
const mode = process.argv[3] ?? "exact";
let directory = resolve("extensions/pi-toggles/src");
if (variant === "before")
    directory = resolve(process.argv[4] ?? ".cache/perf-followup/policy/original/src");
function isPolicyModule(
    value: unknown,
): value is Pick<typeof import("../src/resolve-capability-policy.ts"), "resolveCapabilityPolicy"> {
    return (
        typeof value === "object" &&
        value !== null &&
        "resolveCapabilityPolicy" in value &&
        typeof value.resolveCapabilityPolicy === "function"
    );
}
const imported: unknown = await import(
    pathToFileURL(resolve(directory, "resolve-capability-policy.ts")).href
);
assert.ok(isPolicyModule(imported));
const { resolveCapabilityPolicy } = imported;
let count = 500;
let rules = 4_000;
if (mode === "wildcard") {
    count = 100;
    rules = 800;
}
if (mode === "small") {
    count = 25;
    rules = 25;
}
if (!["exact", "mixed", "wildcard", "small"].includes(mode)) throw new Error("Unknown workload");
const catalog: Capability[] = Array.from({ length: count }, (_, index) => ({
    id: `tool-${index}`,
    kind: "tool",
    name: `tool-${index}`,
    source: {
        source: "synthetic",
        scope: "temporary",
        origin: "top-level",
        path: `tool-${index}.ts`,
    },
    observedState: "active",
    supported: true,
    protected: false,
}));
const configuration: PolicyConfiguration = {
    enabled: true,
    defaults: { lazyToolLimit: 5, showStatus: true },
    global: {
        scope: "global",
        overrides: [],
        profiles: {},
        promptFragments: [],
        rules: Array.from({ length: rules }, (_, index) => {
            const target: { kind: "tool"; name?: string; source?: string; path?: string } = {
                kind: "tool",
            };
            if (mode !== "wildcard" && (mode !== "mixed" || index % 16 !== 0)) {
                target.name = `tool-${index % count}`;
                target.source = "synthetic";
                target.path = `tool-${index % count}.ts`;
            }
            return {
                id: `rule-${index}`,
                priority: (index * 7919) % rules,
                when: { fact: "always", equals: true },
                decisions: [{ target, state: "on" }],
                activateProfiles: [],
            };
        }),
    },
    project: { scope: "project", overrides: [], profiles: {}, promptFragments: [], rules: [] },
    session: { overrides: [] },
    diagnostics: [],
};
const fact = () => ({ status: "known" as const, value: true });
for (let index = 0; index < 3; index++) resolveCapabilityPolicy(catalog, configuration, fact);
if (global.gc === undefined) throw new Error("Run with --expose-gc");
await collect();
const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const start = performance.now();
const operations = 10;
let plan = resolveCapabilityPolicy(catalog, configuration, fact);
for (let index = 1; index < operations; index++)
    plan = resolveCapabilityPolicy(catalog, configuration, fact);
const wallMs = (performance.now() - start) / operations;
const cpu = process.cpuUsage(cpuBefore);
await collect();
const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
assert.equal(plan.capabilities.length, count);
assert.ok(plan.capabilities.every((entry) => entry.desiredState === "on"));
const checksum = createHash("sha256")
    .update(JSON.stringify({ ...plan, activeProfiles: [...plan.activeProfiles] }))
    .digest("hex");
console.log(
    JSON.stringify({
        variant,
        mode,
        capabilities: count,
        rules,
        operations,
        wallMs,
        userMs: cpu.user / 1000 / operations,
        systemMs: cpu.system / 1000 / operations,
        peakRssKiB: process.resourceUsage().maxRSS,
        retainedHeapBytes,
        checksum,
    }),
);
