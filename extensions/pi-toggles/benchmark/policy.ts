import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Capability } from "../src/capability.ts";
import type { PolicyConfiguration } from "../src/capability-policy.ts";
import { resolveCapabilityPolicy } from "../src/resolve-capability-policy.ts";

const repeats = Number(process.argv[2] ?? 7);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100)
    throw new RangeError("Benchmark repeats must be an integer from 1 through 100");

console.log(JSON.stringify({ node: process.version, repeats }));
for (const conflicting of [false, true]) {
    for (const [capabilities, rules] of [
        [25, 25],
        [100, 100],
        [100, 800],
    ] as const) {
        const catalog: Capability[] = Array.from({ length: capabilities }, (_, index) => ({
            id: `tool-${index}`,
            kind: "tool",
            name: `tool-${index}`,
            source: {
                source: "synthetic",
                scope: "temporary",
                origin: "top-level",
                path: "synthetic.ts",
            },
            observedState: "active",
            supported: true,
            protected: false,
        }));
        const policyRules: PolicyConfiguration["global"]["rules"][number][] = Array.from(
            { length: rules },
            (_, index) => {
                let state: "on" | "off" = "on";
                let priority = index;
                if (conflicting) {
                    priority = Math.floor(index / 2);
                    if (index % 2 === 0) state = "off";
                }
                return {
                    id: `rule-${String(index).padStart(5, "0")}`,
                    priority,
                    when: { fact: "always", equals: true },
                    decisions: [{ target: { kind: "tool" }, state }],
                    activateProfiles: [],
                };
            },
        );
        policyRules.push({
            id: "fallback",
            priority: -1,
            when: { fact: "always", equals: true },
            decisions: [{ target: { kind: "tool" }, state: "on" }],
            activateProfiles: [],
        });
        const configuration: PolicyConfiguration = {
            enabled: true,
            defaults: { lazyToolLimit: 5, showStatus: true },
            global: {
                scope: "global",
                overrides: [],
                profiles: {},
                promptFragments: [],
                rules: policyRules,
            },
            project: {
                scope: "project",
                overrides: [],
                profiles: {},
                promptFragments: [],
                rules: [],
            },
            session: { overrides: [] },
            diagnostics: [],
        };
        for (let repeat = 0; repeat < repeats; repeat += 1) {
            global.gc?.();
            let facts = 0;
            const started = performance.now();
            const plan = resolveCapabilityPolicy(catalog, configuration, () => {
                facts += 1;
                return { status: "known", value: true };
            });
            const ms = performance.now() - started;
            let expected = "on";
            if (conflicting && rules % 2 === 1) expected = "off";
            assert.equal(plan.capabilities.length, capabilities);
            assert.ok(plan.capabilities.every((entry) => entry.desiredState === expected));
            // Preserve sets and the complete trace/diagnostic order in the checksum.
            const serialized = JSON.stringify({
                ...plan,
                activeProfiles: [...plan.activeProfiles],
            });
            console.log(
                JSON.stringify({
                    capabilities,
                    rules,
                    conflicting,
                    repeat,
                    ms,
                    facts,
                    traceEntries: plan.capabilities.reduce(
                        (sum, entry) => sum + entry.trace.length,
                        0,
                    ),
                    diagnostics: plan.diagnostics.length,
                    digest: createHash("sha256").update(serialized).digest("hex"),
                }),
            );
        }
    }
}
