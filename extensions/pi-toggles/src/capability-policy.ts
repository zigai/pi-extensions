import type {
    ExtensionSettings,
    PolicyDecision,
    PolicyRule,
    Profile,
    PromptFragment,
    SettingsDocument,
} from "./settings.ts";
import { isDesiredStateAllowed, isExactSelector } from "./capability.ts";

export type PolicyScope = "global" | "project" | "session";

export type PolicyLayer = {
    readonly scope: "global" | "project";
    readonly activeProfile?: string;
    readonly overrides: readonly PolicyDecision[];
    readonly profiles: Readonly<Record<string, Profile>>;
    readonly promptFragments: readonly PromptFragment[];
    readonly rules: readonly PolicyRule[];
};

export type SessionPolicy = {
    readonly activeProfile?: string;
    readonly overrides: readonly PolicyDecision[];
};

export type PolicyConfiguration = {
    readonly enabled: boolean;
    readonly defaults: {
        readonly lazyToolLimit: number;
        readonly showStatus: boolean;
    };
    readonly global: PolicyLayer;
    readonly project: PolicyLayer;
    readonly session: SessionPolicy;
    readonly diagnostics: readonly string[];
};

function uniqueById<T extends { readonly id: string }>(
    values: readonly T[],
    label: string,
    scope: "global" | "project",
    diagnostics: string[],
): readonly T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const value of values) {
        if (seen.has(value.id)) {
            diagnostics.push(
                `Duplicate ${scope} ${label} ID ${value.id}; ignored the later definition.`,
            );
            continue;
        }
        seen.add(value.id);
        result.push(value);
    }
    return result;
}

function validOverrides(
    decisions: readonly PolicyDecision[],
    scope: PolicyScope,
    diagnostics: string[],
): readonly PolicyDecision[] {
    return decisions.filter((decision) => {
        if (!isExactSelector(decision.target)) {
            diagnostics.push(
                `${scope} override for ${decision.target.kind} must select a name plus source or path.`,
            );
            return false;
        }
        if (!isDesiredStateAllowed(decision.target.kind, decision.state)) {
            diagnostics.push(
                `${scope} override state ${decision.state} is invalid for ${decision.target.kind}.`,
            );
            return false;
        }
        return true;
    });
}

function validDecisions(
    decisions: readonly PolicyDecision[],
    source: string,
    diagnostics: string[],
): PolicyDecision[] {
    return decisions.filter((decision) => {
        if (isDesiredStateAllowed(decision.target.kind, decision.state)) {
            return true;
        }
        diagnostics.push(
            `${source} state ${decision.state} is invalid for ${decision.target.kind}.`,
        );
        return false;
    });
}

function validProfiles(
    profiles: Readonly<Record<string, Profile>>,
    scope: "global" | "project",
    diagnostics: string[],
): Readonly<Record<string, Profile>> {
    return Object.fromEntries(
        Object.entries(profiles).map(([name, profile]) => [
            name,
            {
                ...profile,
                decisions: validDecisions(
                    profile.decisions,
                    `${scope} profile ${name}`,
                    diagnostics,
                ),
            },
        ]),
    );
}

function layerFromDocument(
    scope: "global" | "project",
    document: SettingsDocument | undefined,
    diagnostics: string[],
): PolicyLayer {
    return {
        scope,
        overrides: validOverrides(document?.overrides ?? [], scope, diagnostics),
        profiles: validProfiles(document?.profiles ?? {}, scope, diagnostics),
        promptFragments: uniqueById(
            document?.promptFragments ?? [],
            "prompt fragment",
            scope,
            diagnostics,
        ),
        rules: uniqueById(document?.rules ?? [], "rule", scope, diagnostics).map((rule) => ({
            ...rule,
            decisions: validDecisions(rule.decisions, `${scope} rule ${rule.id}`, diagnostics),
        })),
        ...(document?.activeProfile === undefined ? {} : { activeProfile: document.activeProfile }),
    };
}

export function createPolicyConfiguration(input: {
    readonly resolved: ExtensionSettings;
    readonly globalDocument?: SettingsDocument;
    readonly projectDocument?: SettingsDocument;
    readonly session: SessionPolicy;
}): PolicyConfiguration {
    const diagnostics: string[] = [];
    return {
        enabled: input.resolved.enabled,
        defaults: {
            lazyToolLimit: input.resolved.defaults?.lazyToolLimit ?? 5,
            showStatus: input.resolved.defaults?.showStatus ?? true,
        },
        global: layerFromDocument("global", input.globalDocument, diagnostics),
        project: layerFromDocument("project", input.projectDocument, diagnostics),
        session: {
            overrides: validOverrides(input.session.overrides, "session", diagnostics),
            ...(input.session.activeProfile === undefined
                ? {}
                : { activeProfile: input.session.activeProfile }),
        },
        diagnostics,
    };
}

export function mergeProfiles(
    configuration: PolicyConfiguration,
): Readonly<Record<string, Profile>> {
    return { ...configuration.global.profiles, ...configuration.project.profiles };
}

export type ScopedPromptFragment = {
    readonly scope: "global" | "project";
    readonly fragment: PromptFragment;
};

export function mergePromptFragments(
    configuration: PolicyConfiguration,
): readonly ScopedPromptFragment[] {
    const fragmentsById = new Map<string, ScopedPromptFragment>();
    for (const fragment of configuration.global.promptFragments) {
        fragmentsById.set(fragment.id, { scope: "global", fragment });
    }
    for (const fragment of configuration.project.promptFragments) {
        fragmentsById.set(fragment.id, { scope: "project", fragment });
    }
    return [...fragmentsById.values()];
}
