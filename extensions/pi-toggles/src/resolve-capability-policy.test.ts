import { describe, expect, it } from "vitest";
import { selectorMatches, type Capability } from "./capability.ts";
import type { CapabilitySelector, PolicyDecision } from "./settings.ts";
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
    it("uses extension activation proposals as attributed defaults", () => {
        const plan = resolveCapabilityPolicy([writeTool], emptyConfiguration(), resolveFact, [
            {
                version: 1,
                sessionId: "session-1",
                owner: "extension-a",
                decisions: [{ target: { kind: "tool", name: "write" }, state: "off" }],
            },
        ]);

        expect(plan.capabilities[0]?.effectiveState).toBe("inactive");
        expect(plan.capabilities[0]?.winner).toMatchObject({
            scope: "extension",
            origin: "extension-proposal",
            source: "extension-a",
        });
    });

    it("lets user policy override extension activation proposals", () => {
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            global: {
                ...base.global,
                overrides: [
                    { target: { kind: "tool", name: "write", source: "builtin" }, state: "on" },
                ],
            },
        };
        const plan = resolveCapabilityPolicy([writeTool], configuration, resolveFact, [
            {
                version: 1,
                sessionId: "session-1",
                owner: "extension-a",
                decisions: [{ target: { kind: "tool", name: "write" }, state: "off" }],
            },
        ]);

        expect(plan.capabilities[0]?.effectiveState).toBe("active");
        expect(plan.capabilities[0]?.winner?.origin).toBe("override");
        expect(plan.capabilities[0]?.trace).toContainEqual(
            expect.objectContaining({
                origin: "extension-proposal",
                source: "extension-a",
                reason: "shadowed",
            }),
        );
    });

    it("reports conflicting extension defaults and preserves inherited state", () => {
        const plan = resolveCapabilityPolicy([writeTool], emptyConfiguration(), resolveFact, [
            {
                version: 1,
                sessionId: "session-1",
                owner: "extension-a",
                decisions: [{ target: { kind: "tool", name: "write" }, state: "off" }],
            },
            {
                version: 1,
                sessionId: "session-1",
                owner: "extension-b",
                decisions: [{ target: { kind: "tool", name: "write" }, state: "on" }],
            },
        ]);

        expect(plan.capabilities[0]?.desiredState).toBe("inherit");
        expect(plan.capabilities[0]?.effectiveState).toBe("active");
        expect(plan.diagnostics).toContainEqual(expect.stringContaining("extension-a=off"));
        expect(plan.diagnostics).toContainEqual(expect.stringContaining("extension-b=on"));
    });

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
        const capabilities = Array.from({ length: 1_000 }, (_, index): Capability => ({
            ...readTool,
            id: `tool-${index}`,
            name: `tool-${index}`,
            source: { ...readTool.source, path: `<builtin:tool-${index}>` },
        }));
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

function matchingToolRule(
    id: string,
    priority: number,
    states: ("on" | "off")[],
): PolicyConfiguration["global"]["rules"][number] {
    return {
        id,
        priority,
        when: { fact: "prompt.text", contains: "review" },
        decisions: states.map((state) => ({ target: { kind: "tool", name: "read" }, state })),
        activateProfiles: [],
    };
}

it("keeps source/state trace deduplication independent of scope", () => {
    const base = emptyConfiguration();
    const configuration: PolicyConfiguration = {
        ...base,
        global: { ...base.global, rules: [matchingToolRule("shared", 0, ["on"])] },
        project: { ...base.project, rules: [matchingToolRule("shared", 0, ["on"])] },
    };
    const same = resolveCapabilityPolicy([readTool], configuration, resolveFact);
    expect(same.capabilities[0]?.trace).toEqual([
        { scope: "project", origin: "rule", source: "shared", state: "on", selected: true },
    ]);

    const different = resolveCapabilityPolicy(
        [readTool],
        {
            ...configuration,
            global: { ...base.global, rules: [matchingToolRule("shared", 0, ["off"])] },
        },
        resolveFact,
    );
    expect(different.capabilities[0]?.trace).toEqual([
        { scope: "project", origin: "rule", source: "shared", state: "on", selected: true },
        {
            scope: "global",
            origin: "rule",
            source: "shared",
            state: "off",
            selected: false,
            reason: "shadowed",
        },
    ]);
});

it("preserves duplicate conflict traces even when they share the fallback winner's source/state", () => {
    const base = emptyConfiguration();
    const plan = resolveCapabilityPolicy(
        [readTool],
        {
            ...base,
            global: { ...base.global, rules: [matchingToolRule("shared", 0, ["on"])] },
            project: {
                ...base.project,
                rules: [matchingToolRule("shared", 10, ["on", "on", "off"])],
            },
        },
        resolveFact,
    );
    const entry = plan.capabilities[0];
    expect(entry?.winner).toEqual({
        scope: "global",
        origin: "rule",
        source: "shared",
        state: "on",
        selected: true,
    });
    expect(entry?.trace).toEqual(
        ["on", "on", "off"].map((state) => ({
            scope: "project",
            origin: "rule",
            source: "shared",
            state,
            selected: false,
            reason: "conflict",
        })),
    );
    expect(plan.diagnostics).toHaveLength(1);
    expect(plan.diagnostics[0]).toContain("shared=on, shared=on, shared=off");
});

it("walks all conflicting precedence groups in order before selecting a lower-priority fallback", () => {
    const base = emptyConfiguration();
    const plan = resolveCapabilityPolicy(
        [readTool],
        {
            ...base,
            project: {
                ...base.project,
                rules: [
                    matchingToolRule("higher", 20, ["on", "off"]),
                    matchingToolRule("middle", 10, ["on", "off"]),
                    matchingToolRule("fallback", 0, ["on"]),
                ],
            },
        },
        resolveFact,
    );
    expect(
        plan.capabilities[0]?.trace.map((entry) => [
            entry.source,
            entry.state,
            entry.selected,
            entry.reason,
        ]),
    ).toEqual([
        ["higher", "on", false, "conflict"],
        ["higher", "off", false, "conflict"],
        ["middle", "on", false, "conflict"],
        ["middle", "off", false, "conflict"],
        ["fallback", "on", true, undefined],
    ]);
    expect(plan.diagnostics).toHaveLength(2);
});

it("indexes literal source names without prototype keys or cross-state collisions", () => {
    const base = emptyConfiguration();
    const plan = resolveCapabilityPolicy(
        [readTool],
        {
            ...base,
            global: { ...base.global, rules: [matchingToolRule("constructor", 0, ["on"])] },
        },
        resolveFact,
        ["__proto__", "constructor", "toString"].map((owner) => ({
            version: 1,
            sessionId: "synthetic-session",
            owner,
            decisions: [{ target: { kind: "tool", name: "read" }, state: "off" }],
        })),
    );
    expect(plan.capabilities[0]?.trace.map((entry) => [entry.source, entry.state])).toEqual([
        ["constructor", "on"],
        ["__proto__", "off"],
        ["constructor", "off"],
        ["toString", "off"],
    ]);
    expect(plan.capabilities[0]?.desiredState).toBe("on");
});

it("merges all eight selector shapes in legacy stable trace order", () => {
    const selectors = Array.from({ length: 8 }, (_, mask) => {
        const target: CapabilitySelector = { kind: readTool.kind };
        if ((mask & 1) !== 0) target.name = readTool.name;
        if ((mask & 2) !== 0) target.source = readTool.source.source;
        if ((mask & 4) !== 0) target.path = readTool.source.path;
        return target;
    });
    const base = emptyConfiguration();
    const configuration: PolicyConfiguration = {
        ...base,
        global: {
            ...base.global,
            rules: selectors.map((target, index) => ({
                id: `rule-${7 - index}`,
                priority: 0,
                when: { fact: "prompt.text", equals: "review this change" },
                decisions: [{ target, state: "on" }],
                activateProfiles: [],
            })),
        },
    };
    const plan = resolveCapabilityPolicy([readTool], configuration, resolveFact);
    expect(plan.capabilities[0]?.trace.map((entry) => entry.source)).toEqual(
        Array.from({ length: 8 }, (_, index) => `rule-${index}`),
    );
    expect(plan.capabilities[0]?.winner?.source).toBe("rule-0");
});

it("matches prefiltered wildcard policies across mixed exact and partial selectors", () => {
    for (let seed = 1; seed <= 100; seed++) {
        let value = seed;
        const random = (maximum: number) => {
            value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
            return value % maximum;
        };
        const catalog = [
            readTool,
            writeTool,
            command,
            {
                ...readTool,
                id: "other-read",
                source: { ...readTool.source, source: "__proto__", path: "" },
            },
        ];
        const decisions = (): PolicyDecision[] =>
            Array.from({ length: 40 }, () => {
                const capability = catalog[random(catalog.length)] ?? readTool;
                const mask = random(8);
                const states = ["on", "off", "inherit", "lazy"] as const;
                const target: CapabilitySelector = { kind: capability.kind };
                if ((mask & 1) !== 0) target.name = capability.name;
                if ((mask & 2) !== 0) target.source = capability.source.source;
                if ((mask & 4) !== 0) target.path = capability.source.path;
                return { target, state: states[random(states.length)] ?? "on" };
            });
        const base = emptyConfiguration();
        const configuration: PolicyConfiguration = {
            ...base,
            global: {
                ...base.global,
                overrides: decisions(),
                rules: Array.from({ length: 6 }, () => ({
                    id: `rule-${random(3)}`,
                    priority: random(3),
                    when: { fact: "prompt.text", equals: "review this change" },
                    decisions: decisions(),
                    activateProfiles: [],
                })),
            },
            project: { ...base.project, overrides: decisions() },
            session: { overrides: decisions() },
        };
        for (const capability of catalog) {
            const prefilter = (input: readonly PolicyDecision[]): PolicyDecision[] =>
                input
                    .filter((decision) => selectorMatches(decision.target, capability))
                    .map((decision) => ({ ...decision, target: { kind: capability.kind } }));
            const reference: PolicyConfiguration = {
                ...configuration,
                global: {
                    ...configuration.global,
                    overrides: prefilter(configuration.global.overrides),
                    rules: configuration.global.rules.map((rule) => ({
                        ...rule,
                        decisions: prefilter(rule.decisions),
                    })),
                },
                project: {
                    ...configuration.project,
                    overrides: prefilter(configuration.project.overrides),
                },
                session: { overrides: prefilter(configuration.session.overrides) },
            };
            expect(resolveCapabilityPolicy([capability], configuration, resolveFact)).toEqual(
                resolveCapabilityPolicy([capability], reference, resolveFact),
            );
        }
    }
});
