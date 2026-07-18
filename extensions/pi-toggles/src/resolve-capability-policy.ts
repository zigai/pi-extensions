import {
    isDesiredStateAllowed,
    selectorMatches,
    type Capability,
    type ObservedState,
} from "./capability.ts";
import {
    mergeProfiles,
    mergePromptFragments,
    type PolicyConfiguration,
    type PolicyScope,
    type ScopedPromptFragment,
} from "./capability-policy.ts";
import { evaluateCondition, type ConditionEvaluation, type FactResolver } from "./condition.ts";
import type { DesiredState, PolicyDecision, PolicyRule, Profile } from "./settings.ts";

export type DecisionOrigin = "override" | "profile" | "rule" | "rule-profile";

export type DecisionTrace = {
    readonly scope: PolicyScope;
    readonly origin: DecisionOrigin;
    readonly source: string;
    readonly state: DesiredState;
    readonly selected: boolean;
    readonly reason?: string;
};

export type EffectiveCapability = {
    readonly capability: Capability;
    readonly desiredState: DesiredState;
    readonly effectiveState: ObservedState | "lazy" | "name-only" | "user-only" | "unsupported";
    readonly winner?: DecisionTrace;
    readonly trace: readonly DecisionTrace[];
};

export type ActivePromptFragment = ScopedPromptFragment & {
    readonly activatedBy: readonly string[];
};

export type PolicyPlan = {
    readonly capabilities: readonly EffectiveCapability[];
    readonly activeProfiles: ReadonlySet<string>;
    readonly activePromptFragments: readonly ActivePromptFragment[];
    readonly diagnostics: readonly string[];
};

type DecisionCandidate = {
    readonly decision: PolicyDecision;
    readonly scope: PolicyScope;
    readonly origin: DecisionOrigin;
    readonly source: string;
    readonly precedence: number;
    readonly priority: number;
};

type RuleMatch = {
    readonly scope: "global" | "project";
    readonly rule: PolicyRule;
    readonly evaluation: ConditionEvaluation;
};

const precedence = {
    sessionOverride: 900,
    sessionProfile: 850,
    projectOverride: 800,
    projectProfile: 750,
    globalOverride: 700,
    globalProfile: 650,
    projectRule: 500,
    globalRule: 300,
} as const;

function matchingRules(
    configuration: PolicyConfiguration,
    resolveFact: FactResolver,
): readonly RuleMatch[] {
    const matches: RuleMatch[] = [];
    for (const layer of [configuration.global, configuration.project] as const) {
        for (const rule of layer.rules) {
            const evaluation = evaluateCondition(rule.when, resolveFact);
            if (evaluation.value === true) {
                matches.push({ scope: layer.scope, rule, evaluation });
            } else if (evaluation.value === "unknown") {
                matches.push({ scope: layer.scope, rule, evaluation });
            }
        }
    }
    return matches;
}

function pushProfileCandidates(
    candidates: DecisionCandidate[],
    profile: Profile | undefined,
    input: Omit<DecisionCandidate, "decision">,
    diagnostics: string[],
): void {
    if (profile === undefined) {
        diagnostics.push(`Unknown profile ${input.source}.`);
        return;
    }
    for (const decision of profile.decisions) {
        candidates.push({ ...input, decision });
    }
}

function buildCandidates(
    configuration: PolicyConfiguration,
    ruleMatches: readonly RuleMatch[],
    diagnostics: string[],
): {
    readonly candidates: readonly DecisionCandidate[];
    readonly activeProfiles: ReadonlySet<string>;
} {
    const profiles = mergeProfiles(configuration);
    const candidates: DecisionCandidate[] = [];
    const activeProfiles = new Set<string>();

    for (const decision of configuration.session.overrides) {
        candidates.push({
            decision,
            scope: "session",
            origin: "override",
            source: "session override",
            precedence: precedence.sessionOverride,
            priority: 0,
        });
    }
    if (configuration.session.activeProfile !== undefined) {
        activeProfiles.add(configuration.session.activeProfile);
        pushProfileCandidates(
            candidates,
            profiles[configuration.session.activeProfile],
            {
                scope: "session",
                origin: "profile",
                source: configuration.session.activeProfile,
                precedence: precedence.sessionProfile,
                priority: 0,
            },
            diagnostics,
        );
    }

    for (const layer of [configuration.project, configuration.global] as const) {
        const overridePrecedence =
            layer.scope === "project" ? precedence.projectOverride : precedence.globalOverride;
        const profilePrecedence =
            layer.scope === "project" ? precedence.projectProfile : precedence.globalProfile;
        for (const decision of layer.overrides) {
            candidates.push({
                decision,
                scope: layer.scope,
                origin: "override",
                source: `${layer.scope} override`,
                precedence: overridePrecedence,
                priority: 0,
            });
        }
        if (layer.activeProfile !== undefined) {
            activeProfiles.add(layer.activeProfile);
            pushProfileCandidates(
                candidates,
                profiles[layer.activeProfile],
                {
                    scope: layer.scope,
                    origin: "profile",
                    source: layer.activeProfile,
                    precedence: profilePrecedence,
                    priority: 0,
                },
                diagnostics,
            );
        }
    }

    for (const match of ruleMatches) {
        if (match.evaluation.value !== true) {
            diagnostics.push(
                `Rule ${match.rule.id} did not match because a fact was unknown: ${match.evaluation.diagnostics.join(" ")}`,
            );
            continue;
        }
        const rulePrecedence =
            match.scope === "project" ? precedence.projectRule : precedence.globalRule;
        for (const decision of match.rule.decisions) {
            candidates.push({
                decision,
                scope: match.scope,
                origin: "rule",
                source: match.rule.id,
                precedence: rulePrecedence,
                priority: match.rule.priority,
            });
        }
        for (const profileName of match.rule.activateProfiles) {
            activeProfiles.add(profileName);
            pushProfileCandidates(
                candidates,
                profiles[profileName],
                {
                    scope: match.scope,
                    origin: "rule-profile",
                    source: `${match.rule.id}:${profileName}`,
                    precedence: rulePrecedence,
                    priority: match.rule.priority,
                },
                diagnostics,
            );
        }
    }

    return { candidates, activeProfiles };
}

function decisionTrace(
    candidate: DecisionCandidate,
    selected: boolean,
    reason?: string,
): DecisionTrace {
    return {
        scope: candidate.scope,
        origin: candidate.origin,
        source: candidate.source,
        state: candidate.decision.state,
        selected,
        ...(reason === undefined ? {} : { reason }),
    };
}

function resolveCapability(
    capability: Capability,
    allCandidates: readonly DecisionCandidate[],
    diagnostics: string[],
): EffectiveCapability {
    const candidates = allCandidates
        .filter((candidate) => candidate.decision.state !== "inherit")
        .filter((candidate) => selectorMatches(candidate.decision.target, capability))
        .sort(
            (left, right) =>
                right.precedence - left.precedence ||
                right.priority - left.priority ||
                left.source.localeCompare(right.source),
        );

    const trace: DecisionTrace[] = [];
    let winner: DecisionCandidate | undefined;
    for (let index = 0; index < candidates.length;) {
        const first = candidates[index];
        if (first === undefined) {
            break;
        }
        const group = candidates.filter(
            (candidate) =>
                candidate.precedence === first.precedence && candidate.priority === first.priority,
        );
        const states = new Set(group.map((candidate) => candidate.decision.state));
        if (states.size > 1) {
            diagnostics.push(
                `Conflicting ${capability.id} decisions at precedence ${first.precedence}, priority ${first.priority}: ${group.map((candidate) => `${candidate.source}=${candidate.decision.state}`).join(", ")}.`,
            );
            for (const candidate of group) {
                trace.push(decisionTrace(candidate, false, "conflict"));
            }
            index += group.length;
            continue;
        }
        winner = first;
        break;
    }

    if (winner !== undefined) {
        for (const candidate of candidates) {
            if (
                !trace.some(
                    (entry) =>
                        entry.source === candidate.source &&
                        entry.state === candidate.decision.state,
                )
            ) {
                trace.push(
                    decisionTrace(
                        candidate,
                        candidate === winner,
                        candidate === winner ? undefined : "shadowed",
                    ),
                );
            }
        }
    }

    if (winner === undefined) {
        return {
            capability,
            desiredState: "inherit",
            effectiveState: capability.observedState,
            trace,
        };
    }

    const state = winner.decision.state;
    const selectedTrace = decisionTrace(winner, true);
    if (!isDesiredStateAllowed(capability.kind, state)) {
        diagnostics.push(
            `State ${state} is not valid for ${capability.kind} capability ${capability.id}.`,
        );
        return {
            capability,
            desiredState: state,
            effectiveState: capability.observedState,
            winner: selectedTrace,
            trace,
        };
    }
    if (capability.protected && state === "off") {
        diagnostics.push(`Protected capability ${capability.id} cannot be turned off.`);
        return {
            capability,
            desiredState: state,
            effectiveState: "active",
            winner: selectedTrace,
            trace,
        };
    }
    if (capability.observedState === "unavailable") {
        diagnostics.push(
            `Policy target ${capability.id} is unavailable in the current Pi runtime.`,
        );
        return {
            capability,
            desiredState: state,
            effectiveState: "unavailable",
            winner: selectedTrace,
            trace,
        };
    }
    if (!capability.supported) {
        diagnostics.push(
            `Pi does not expose runtime ${capability.kind} control for ${capability.id}.`,
        );
        return {
            capability,
            desiredState: state,
            effectiveState: "unsupported",
            winner: selectedTrace,
            trace,
        };
    }
    const effectiveState =
        state === "on"
            ? "active"
            : state === "off"
              ? "inactive"
              : state === "lazy"
                ? "lazy"
                : state === "name-only"
                  ? "name-only"
                  : state === "user-only"
                    ? "user-only"
                    : capability.observedState;
    return {
        capability,
        desiredState: state,
        effectiveState,
        winner: selectedTrace,
        trace,
    };
}

function activeFragments(
    configuration: PolicyConfiguration,
    activeProfiles: ReadonlySet<string>,
    effectiveCapabilities: readonly EffectiveCapability[],
    resolveFact: FactResolver,
    diagnostics: string[],
): readonly ActivePromptFragment[] {
    const profiles = mergeProfiles(configuration);
    const scopedFragments = mergePromptFragments(configuration);
    const fragmentIds = new Set(scopedFragments.map((entry) => entry.fragment.id));
    const profileActivations = new Map<string, string[]>();
    for (const profileName of activeProfiles) {
        const profile = profiles[profileName];
        if (profile === undefined) {
            diagnostics.push(`Active profile ${profileName} is not defined.`);
            continue;
        }
        for (const fragmentId of profile.promptFragments) {
            if (!fragmentIds.has(fragmentId)) {
                diagnostics.push(
                    `Profile ${profileName} references unknown prompt fragment ${fragmentId}.`,
                );
                continue;
            }
            const activators = profileActivations.get(fragmentId) ?? [];
            activators.push(`profile:${profileName}`);
            profileActivations.set(fragmentId, activators);
        }
    }

    const fragmentDecisions = new Map(
        effectiveCapabilities
            .filter((entry) => entry.capability.kind === "system-fragment")
            .map((entry) => [entry.capability.name, entry] as const),
    );
    const active: ActivePromptFragment[] = [];
    for (const scoped of scopedFragments) {
        const decision = fragmentDecisions.get(scoped.fragment.id);
        if (decision?.desiredState === "off") {
            continue;
        }
        const activatedBy = [...(profileActivations.get(scoped.fragment.id) ?? [])];
        if (scoped.fragment.when !== undefined) {
            const evaluation = evaluateCondition(scoped.fragment.when, resolveFact);
            if (evaluation.value === true) {
                activatedBy.push("fragment condition");
            } else if (evaluation.value === "unknown") {
                diagnostics.push(
                    `Prompt fragment ${scoped.fragment.id} condition is unknown: ${evaluation.diagnostics.join(" ")}`,
                );
            }
        }
        if (decision?.desiredState === "on") {
            activatedBy.push("explicit decision");
        }
        if (activatedBy.length > 0) {
            active.push({ ...scoped, activatedBy });
        }
    }
    return active.sort(
        (left, right) =>
            right.fragment.priority - left.fragment.priority ||
            left.fragment.id.localeCompare(right.fragment.id),
    );
}

export function resolveCapabilityPolicy(
    catalog: readonly Capability[],
    configuration: PolicyConfiguration,
    resolveFact: FactResolver,
): PolicyPlan {
    if (!configuration.enabled) {
        return {
            capabilities: catalog.map((capability) => ({
                capability,
                desiredState: "inherit",
                effectiveState: capability.observedState,
                trace: [],
            })),
            activeProfiles: new Set(),
            activePromptFragments: [],
            diagnostics: [],
        };
    }

    const diagnostics: string[] = [...configuration.diagnostics];
    const ruleMatches = matchingRules(configuration, resolveFact);
    const { candidates, activeProfiles } = buildCandidates(configuration, ruleMatches, diagnostics);
    const capabilities = catalog.map((capability) =>
        resolveCapability(capability, candidates, diagnostics),
    );
    const promptFragments = activeFragments(
        configuration,
        activeProfiles,
        capabilities,
        resolveFact,
        diagnostics,
    );
    const uniqueDiagnostics = [...new Set(diagnostics)];
    const boundedDiagnostics = uniqueDiagnostics.slice(0, 100);
    if (uniqueDiagnostics.length > boundedDiagnostics.length) {
        boundedDiagnostics.push(
            `${uniqueDiagnostics.length - boundedDiagnostics.length} additional policy diagnostics omitted.`,
        );
    }

    return {
        capabilities,
        activeProfiles,
        activePromptFragments: promptFragments,
        diagnostics: boundedDiagnostics,
    };
}
