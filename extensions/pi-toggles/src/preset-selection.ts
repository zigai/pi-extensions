import { mergeProfiles, type PolicyConfiguration } from "./capability-policy.ts";
import { evaluateCondition, type FactResolver } from "./condition.ts";
import type { StaticDecode } from "typebox";
import type { modelRoleSchema } from "./settings-input.ts";
import type { Profile } from "./settings.ts";

export type ModelRole = StaticDecode<typeof modelRoleSchema>;
export type PresetSelection = { name: string; profile: Profile; reason: string };

export function selectPreset(
    configuration: PolicyConfiguration,
    facts: FactResolver,
): PresetSelection | undefined {
    if (!configuration.enabled) return undefined;
    const profiles = mergeProfiles(configuration);
    for (const layer of [configuration.session, configuration.project, configuration.global]) {
        if (layer.activeProfile === undefined) continue;
        const profile = profiles[layer.activeProfile];
        if (profile !== undefined)
            return { name: layer.activeProfile, profile, reason: "explicit profile" };
    }
    for (const layer of [configuration.project, configuration.global]) {
        const rules = [...layer.rules].sort(
            (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
        );
        for (const rule of rules) {
            if (evaluateCondition(rule.when, facts).value !== true) continue;
            for (const name of rule.activateProfiles) {
                const profile = profiles[name];
                if (profile !== undefined)
                    return { name, profile, reason: `${layer.scope} rule ${rule.id}` };
            }
        }
    }
    return undefined;
}

export function selectCompactionHandler(
    configuration: PolicyConfiguration,
    facts: FactResolver,
): string | undefined {
    const preset = selectPreset(configuration, facts);
    if (!configuration.enabled) return undefined;
    if (preset?.profile.compactionHandler !== undefined) return preset.profile.compactionHandler;
    for (const layer of [configuration.project, configuration.global]) {
        const rule = [...layer.rules]
            .sort(
                (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
            )
            .find(
                (entry) =>
                    entry.compactionHandler !== undefined &&
                    evaluateCondition(entry.when, facts).value === true,
            );
        if (rule !== undefined) return rule.compactionHandler;
    }
    return undefined;
}

export function resolveModelRole(
    profile: Profile,
    role: string,
): { status: "resolved"; model: ModelRole } | { status: "missing" | "invalid"; reason: string } {
    const seen = new Set<string>();
    let name = role;
    while (!seen.has(name)) {
        seen.add(name);
        const selection = profile.modelRoles?.[name];
        if (selection === undefined) {
            let status: "missing" | "invalid" = "missing";
            if (name !== role) status = "invalid";
            return { status, reason: `Model role ${name} is not defined.` };
        }
        if (typeof selection !== "string") return { status: "resolved", model: { ...selection } };
        name = selection.slice(1);
    }
    return { status: "invalid", reason: `Model role ${role} has a circular reference.` };
}
