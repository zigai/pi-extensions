import type { Capability } from "./capability.ts";
import type { PolicyPlan } from "./resolve-capability-policy.ts";

function normalizeSearchTerms(query: string): readonly string[] {
    return query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 0);
}

function scoreCapability(capability: Capability, terms: readonly string[]): number {
    const name = capability.name.toLowerCase();
    const description = capability.description?.toLowerCase() ?? "";
    const searchText = capability.searchText?.toLowerCase() ?? "";
    return terms.reduce((score, term) => {
        if (name === term) {
            return score + 20;
        }
        return (
            score +
            (name.includes(term) ? 5 : 0) +
            (description.includes(term) ? 2 : 0) +
            (searchText.includes(term) ? 1 : 0)
        );
    }, 0);
}

export function rankLazyTools(plan: PolicyPlan, query: string, limit: number): readonly string[] {
    const terms = normalizeSearchTerms(query);
    return plan.capabilities
        .filter((entry) => entry.capability.kind === "tool" && entry.effectiveState === "lazy")
        .map((entry) => ({ entry, score: scoreCapability(entry.capability, terms) }))
        .filter((match) => match.score > 0)
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.entry.capability.name.localeCompare(right.entry.capability.name),
        )
        .slice(0, limit)
        .map((match) => match.entry.capability.name);
}

export function decideToolInvocation(
    plan: PolicyPlan,
    name: string,
    lazyActivated: ReadonlySet<string>,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
    const entry = plan.capabilities.find(
        (candidate) => candidate.capability.kind === "tool" && candidate.capability.name === name,
    );
    if (
        entry === undefined ||
        entry.desiredState === "inherit" ||
        entry.effectiveState === "active"
    ) {
        return { allowed: true };
    }
    if (entry.effectiveState === "lazy" && lazyActivated.has(name)) {
        return { allowed: true };
    }
    return {
        allowed: false,
        reason: `Pi Toggles blocked ${name}: effective state is ${entry.effectiveState}. Use /toggles explain ${name}.`,
    };
}
