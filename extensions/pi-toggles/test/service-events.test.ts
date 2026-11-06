import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serviceEventsFixture } from "./service-events-fixture.ts";
import type { GoalPolicy } from "../src/goal-policy.ts";
import type { ExtensionActivationProposal } from "../src/activation-coordination.ts";
import { ContextFacts } from "../src/context-facts.ts";

const fixtures: ReturnType<typeof serviceEventsFixture>[] = [];
afterEach(async () => {
    for (const fixture of fixtures.splice(0).reverse()) await fixture.close();
});
function fixture(options: Parameters<typeof serviceEventsFixture>[0] = {}) {
    const result = serviceEventsFixture(options);
    fixtures.push(result);
    return result;
}
const declaration = {
    owner: "pi-goal",
    key: "goal.status",
    type: "string" as const,
    description: "Goal lifecycle",
};
const goal: GoalPolicy = {
    version: 1,
    sessionId: "session-one",
    status: "active",
    disabledTools: ["ask_user_question", "late_tool"],
};
const proposal: ExtensionActivationProposal = {
    version: 1,
    sessionId: "session-one",
    owner: "test-owner",
    decisions: [{ target: { kind: "tool", name: "tool_0" }, state: "off" }],
};

describe("service event invalidation and freshness", () => {
    it("tracks accepted fact revisions without caching rejected declarations or changing type-drift semantics", () => {
        const facts = new ContextFacts("/workspace", true);
        facts.set("model.id", "built-in");
        const input = {
            owner: "extension",
            key: "model.id",
            type: "string" as const,
            description: "Model fact",
        };
        const initial = facts.revision;
        expect(facts.registerContextKey(input)).toBe(false);
        expect(facts.revision).toBe(initial);
        facts.set("model.id", undefined);
        expect(facts.registerContextKey(input)).toBe(true);
        facts.setContext({ owner: "extension", key: "model.id", value: "custom" });
        const accepted = facts.revision;
        expect(facts.registerContextKey(input)).toBe(true);
        expect(facts.revision).toBe(accepted);
        expect(facts.registerContextKey({ ...input, type: "number" })).toBe(true);
        // Re-registration historically preserves the supplied value, even when
        // its type no longer matches; only future writes use the new type.
        expect(facts.resolve("model.id", undefined)).toEqual({ status: "known", value: "custom" });
        const changedType = facts.revision;
        expect(facts.registerContextKey({ ...input, type: "number" })).toBe(true);
        expect(facts.revision).toBe(changedType);
        facts.setContext({ owner: "extension", key: "model.id", value: "wrong" });
        expect(facts.revision).toBe(changedType);
        expect(facts.registerContextKey({ ...input, key: "env.present" })).toBe(false);
        facts.clearContext({ owner: "extension" });
        const cleared = facts.revision;
        facts.clearContext({ owner: "extension" });
        expect(facts.revision).toBe(cleared);
    });
    it("does no catalog or plan work for 10000 unchanged declarations, facts, restrictions, or proposals", async () => {
        const h = fixture();
        h.service.registerContextKey(declaration);
        h.service.setContext({ owner: "pi-goal", key: "goal.status", value: "active" });
        h.service.acceptGoalPolicy(goal);
        h.service.acceptExtensionActivationProposal(proposal);
        await h.service.settleActivation();
        const counts = { ...h.counts };
        const plan = h.service.plan;
        const catalog = h.service.catalog;
        for (let index = 0; index < 10000; index++) {
            h.service.registerContextKey({ ...declaration });
            h.service.setContext({ owner: "pi-goal", key: "goal.status", value: "active" });
            h.service.acceptGoalPolicy({ ...goal, disabledTools: [...goal.disabledTools] });
            h.service.acceptExtensionActivationProposal({
                ...proposal,
                decisions: proposal.decisions.map((decision) => ({
                    ...decision,
                    target: { ...decision.target },
                })),
            });
        }
        await h.service.settleActivation();
        expect(h.service.plan).toBe(plan);
        expect(h.service.catalog).toBe(catalog);
        expect(h.counts).toEqual(counts);
    });

    it("separates plan input revisions from catalog discovery and explicit freshness", async () => {
        const h = fixture();
        h.service.registerContextKey(declaration);
        const initial = h.service.revisions;
        const scans = h.counts.catalogs;
        const catalog = h.service.catalog;
        h.service.setContext({ owner: "pi-goal", key: "goal.status", value: "active" });
        h.service.acceptGoalPolicy({ ...goal, status: "blocked" });
        await h.service.settleActivation();
        expect(h.counts.catalogs).toBe(scans);
        expect(h.service.catalog).toBe(catalog);
        expect(h.service.revisions.catalog).toBe(initial.catalog);
        expect(h.service.revisions.facts).toBe(initial.facts + 1);
        expect(h.service.revisions.policy).toBe(initial.policy + 1);
        expect(h.service.revisions.plan).toBe(initial.plan + 2);
        const beforeRefresh = h.service.revisions;
        await h.service.refresh();
        expect(h.counts.catalogs).toBe(scans + 1);
        expect(h.service.revisions.catalog).toBe(beforeRefresh.catalog);
        expect(h.service.revisions.freshness).toBe(beforeRefresh.freshness + 1);
        expect(h.service.revisions.plan).toBe(beforeRefresh.plan + 1);
        expect(h.service.catalog).toBe(catalog);
    });

    it("explicit refresh discovers late tools despite identical declarations, and withdraws proposals", async () => {
        const h = fixture();
        h.service.acceptGoalPolicy(goal);
        h.service.acceptExtensionActivationProposal(proposal);
        await h.service.settleActivation();
        expect(h.active).not.toContain("tool_0");
        h.addTool("late_tool");
        const before = h.counts.catalogs;
        h.service.acceptGoalPolicy(goal);
        h.service.acceptExtensionActivationProposal(proposal);
        expect(h.counts.catalogs).toBe(before);
        await h.service.refresh();
        expect(h.counts.catalogs).toBeGreaterThan(before);
        expect(h.service.catalog.some((entry) => entry.name === "late_tool")).toBe(true);
        expect(h.active).not.toContain("late_tool");
        expect(h.service.clearExtensionActivationProposal("test-owner", "wrong-session")).toBe(
            false,
        );
        expect(h.service.clearExtensionActivationProposal("test-owner", "session-one")).toBe(true);
        await h.service.settleActivation();
        expect(h.active).toContain("tool_0");
        h.service.acceptGoalPolicy({ ...goal, status: "paused" });
        await h.service.settleActivation();
        expect(h.active).toContain("ask_user_question");
        expect(h.active).toContain("late_tool");
    });

    it("invalidates on fact values, cleared values, explicit dynamic-fact refresh, and config edits", async () => {
        const h = fixture({
            settings: {
                rules: [
                    {
                        id: "goal-rule",
                        priority: 0,
                        activateProfiles: [],
                        when: { fact: "goal.status", equals: "active" },
                        decisions: [{ target: { kind: "tool", name: "tool_0" }, state: "off" }],
                    },
                    {
                        id: "file-rule",
                        priority: 0,
                        activateProfiles: [],
                        when: { fact: "project.fileExists", args: { path: "flag" }, equals: true },
                        decisions: [{ target: { kind: "tool", name: "tool_1" }, state: "off" }],
                    },
                ],
            },
        });
        h.service.registerContextKey(declaration);
        h.service.setContext({ owner: "pi-goal", key: "goal.status", value: "active" });
        await h.service.settleActivation();
        expect(h.active).not.toContain("tool_0");
        h.service.clearContext({ owner: "pi-goal", key: "goal.status" });
        await h.service.settleActivation();
        expect(h.active).toContain("tool_0");
        writeFileSync(join(h.ctx.cwd, "flag"), "present");
        await h.service.refresh();
        expect(h.active).not.toContain("tool_1");
        expect(
            await h.service.setDecisions("session", [
                { target: { kind: "tool", name: "tool_2", source: "inline" }, state: "off" },
            ]),
        ).toEqual({ status: "applied" });
        expect(h.active).not.toContain("tool_2");
    });

    it("snapshots accepted small payloads and handles changed restrictions/proposals", async () => {
        const h = fixture();
        const mutable = { ...goal, disabledTools: ["tool_0"] };
        h.service.acceptGoalPolicy(mutable);
        await h.service.settleActivation();
        expect(h.active).not.toContain("tool_0");
        mutable.disabledTools[0] = "tool_1";
        h.service.acceptGoalPolicy(mutable);
        await h.service.settleActivation();
        expect(h.active).toContain("tool_0");
        expect(h.active).not.toContain("tool_1");
        h.service.acceptExtensionActivationProposal(proposal);
        await h.service.settleActivation();
        h.service.acceptExtensionActivationProposal({ ...proposal, decisions: [] });
        await h.service.settleActivation();
        expect(h.active).toContain("tool_0");
    });

    it("session reset discards cached inputs and rejects stale owners", async () => {
        const h = fixture();
        h.service.acceptGoalPolicy(goal);
        await h.service.settleActivation();
        const oldService = h.service;
        await h.reset();
        expect(h.active).toContain("ask_user_question");
        const plan = h.service.plan;
        h.service.acceptGoalPolicy(goal);
        expect(h.service.acceptExtensionActivationProposal(proposal)).toBe(false);
        expect(h.service.plan).toBe(plan);
        oldService.registerContextKey(declaration);
        oldService.setContext({ owner: "pi-goal", key: "goal.status", value: "active" });
        h.service.acceptGoalPolicy({ ...goal, sessionId: "session-two" });
        await h.service.settleActivation();
        expect(h.active).not.toContain("ask_user_question");
    });

    it("disabled coordination rejects restrictions and proposals without recomputing", async () => {
        const h = fixture({ settings: { enabled: false } });
        const before = h.counts.catalogs;
        h.service.acceptGoalPolicy(goal);
        expect(h.service.acceptExtensionActivationProposal(proposal)).toBe(false);
        expect(h.counts.catalogs).toBe(before);
        expect(h.active).toContain("ask_user_question");
    });
});

it("discovers tools registered while initial asynchronous facts are settling", async () => {
    const h = fixture();
    const initializing = h.service.initialize();
    h.addTool("registered_during_initialize");
    await initializing;
    expect(h.service.catalog.some((entry) => entry.name === "registered_during_initialize")).toBe(
        true,
    );
});
