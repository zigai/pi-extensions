import { describe, expect, it } from "vitest";
import type { Capability } from "./capability.ts";
import type { PolicyConfiguration } from "./capability-policy.ts";
import type { FactArguments, FactResolution } from "./condition.ts";
import { decideToolInvocation } from "./lazy-tool-search.ts";
import { resolveCapabilityPolicy } from "./resolve-capability-policy.ts";

const readTool: Capability = {
    id: "read",
    kind: "tool",
    name: "read",
    source: { source: "builtin", scope: "temporary", origin: "top-level", path: "<builtin:read>" },
    observedState: "active",
    supported: true,
    protected: false,
};

const writeTool: Capability = {
    ...readTool,
    id: "write",
    name: "write",
    source: { ...readTool.source, path: "<builtin:write>" },
};

const command: Capability = {
    id: "deploy",
    kind: "command",
    name: "deploy",
    source: { source: "extension:deploy", scope: "user", origin: "top-level", path: "deploy.ts" },
    observedState: "active",
    supported: false,
    protected: false,
};

function emptyConfiguration(): PolicyConfiguration {
    return {
        enabled: true,
        defaults: { lazyToolLimit: 5, showStatus: true },
        global: { scope: "global", overrides: [], profiles: {}, promptFragments: [], rules: [] },
        project: { scope: "project", overrides: [], profiles: {}, promptFragments: [], rules: [] },
        session: { overrides: [] },
        diagnostics: [],
    };
}

function resolveFact(name: string, _args: FactArguments | undefined): FactResolution {
    return name === "prompt.text"
        ? { status: "known", value: "review this change" }
        : { status: "missing", reason: "not configured" };
}

describe("resolveCapabilityPolicy", () => {
    it("lets explicit session policy beat project and global policy", () => {
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            global: {
                ...base.global,
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "on" },
                ],
            },
            project: {
                ...base.project,
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "off" },
                ],
            },
            session: {
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "lazy" },
                ],
            },
        };

        const plan = resolveCapabilityPolicy([writeTool], configuration, resolveFact);
        expect(plan.capabilities[0]?.desiredState).toBe("lazy");
        expect(plan.capabilities[0]?.effectiveState).toBe("lazy");
        expect(plan.capabilities[0]?.winner?.scope).toBe("session");
    });

    it("activates profiles from matching rules", () => {
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            global: {
                ...base.global,
                profiles: {
                    review: {
                        decisions: [{ target: { kind: "tool", name: "write" }, state: "off" }],
                        promptFragments: ["review-guidance"],
                    },
                },
                promptFragments: [
                    {
                        id: "review-guidance",
                        priority: 10,
                        content: { kind: "inline", text: "Review only." },
                    },
                ],
                rules: [
                    {
                        id: "review-request",
                        priority: 100,
                        when: { fact: "prompt.text", contains: "review" },
                        decisions: [],
                        activateProfiles: ["review"],
                    },
                ],
            },
        };

        const plan = resolveCapabilityPolicy([writeTool], configuration, resolveFact);
        expect(plan.capabilities[0]?.effectiveState).toBe("inactive");
        expect([...plan.activeProfiles]).toEqual(["review"]);
        expect(plan.activePromptFragments.map((entry) => entry.fragment.id)).toEqual([
            "review-guidance",
        ]);
    });

    it("reports equal-precedence conflicts and falls back to inherited state", () => {
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            global: {
                ...base.global,
                overrides: [
                    { target: { kind: "tool", name: "read", source: "builtin" }, state: "on" },
                    { target: { kind: "tool", name: "read", source: "builtin" }, state: "off" },
                ],
            },
        };

        const plan = resolveCapabilityPolicy([readTool], configuration, resolveFact);
        expect(plan.capabilities[0]?.desiredState).toBe("inherit");
        expect(plan.capabilities[0]?.effectiveState).toBe("active");
        expect(plan.diagnostics[0]).toContain("Conflicting");
    });

    it("marks API-blocked capability decisions as unsupported", () => {
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            session: {
                overrides: [
                    {
                        target: { kind: "command", name: "deploy", source: "extension:deploy" },
                        state: "off",
                    },
                ],
            },
        };

        const plan = resolveCapabilityPolicy([command], configuration, resolveFact);
        expect(plan.capabilities[0]?.effectiveState).toBe("unsupported");
        expect(plan.diagnostics[0]).toContain("does not expose runtime command control");
    });

    it("keeps protected recovery capabilities active", () => {
        const protectedTool: Capability = {
            ...writeTool,
            id: "protected-search",
            name: "search_capabilities",
            protected: true,
        };
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            session: {
                overrides: [
                    {
                        target: {
                            kind: "tool",
                            name: "search_capabilities",
                            source: "builtin",
                        },
                        state: "off",
                    },
                ],
            },
        };

        const plan = resolveCapabilityPolicy([protectedTool], configuration, resolveFact);
        expect(plan.capabilities[0]?.effectiveState).toBe("active");
        expect(plan.diagnostics[0]).toContain("cannot be turned off");
    });

    it("keeps missing persisted targets visibly unavailable", () => {
        const unavailable: Capability = {
            ...writeTool,
            id: "missing-write",
            observedState: "unavailable",
            supported: false,
        };
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            session: {
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "off" },
                ],
            },
        };

        const plan = resolveCapabilityPolicy([unavailable], configuration, resolveFact);
        expect(plan.capabilities[0]?.effectiveState).toBe("unavailable");
        expect(plan.diagnostics[0]).toContain("unavailable in the current Pi runtime");
    });

    it("resolves at least one thousand capabilities deterministically", () => {
        const capabilities = Array.from(
            { length: 1_000 },
            (_, index): Capability => ({
                ...readTool,
                id: `tool-${index}`,
                name: `tool-${index}`,
                source: { ...readTool.source, path: `<builtin:tool-${index}>` },
            }),
        );
        const configuration = emptyConfiguration();

        const first = resolveCapabilityPolicy(capabilities, configuration, resolveFact);
        const second = resolveCapabilityPolicy(capabilities, configuration, resolveFact);

        expect(first.capabilities).toHaveLength(1_000);
        expect(second).toEqual(first);
    });

    it("blocks disabled and not-yet-activated lazy tool invocations", () => {
        const base = emptyConfiguration();
        const offConfiguration: PolicyConfiguration = {
            ...base,
            session: {
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "off" },
                ],
            },
        };
        const offPlan = resolveCapabilityPolicy([writeTool], offConfiguration, resolveFact);
        expect(decideToolInvocation(offPlan, "write", new Set())).toEqual({
            allowed: false,
            reason: "Pi Toggles blocked write: effective state is inactive. Use /toggles explain write.",
        });

        const lazyConfiguration: PolicyConfiguration = {
            ...base,
            session: {
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "lazy" },
                ],
            },
        };
        const lazyPlan = resolveCapabilityPolicy([writeTool], lazyConfiguration, resolveFact);
        expect(decideToolInvocation(lazyPlan, "write", new Set()).allowed).toBe(false);
        expect(decideToolInvocation(lazyPlan, "write", new Set(["write"]))).toEqual({
            allowed: true,
        });
    });
});
