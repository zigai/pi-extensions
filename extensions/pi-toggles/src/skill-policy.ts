import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { createCapabilityId, normalizeSourceInfo } from "./capability.ts";
import type { PolicyPlan } from "./resolve-capability-policy.ts";

const STANDARD_SKILL_SECTION =
    /(?:\n\n)?The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

function skillEntry(plan: PolicyPlan, skill: Skill) {
    const source = normalizeSourceInfo(skill.sourceInfo);
    const id = createCapabilityId("skill", skill.name, source);
    return plan.capabilities.find((entry) => entry.capability.id === id);
}

function skillForModel(skill: Skill, plan: PolicyPlan): Skill {
    const state = skillEntry(plan, skill)?.desiredState ?? "inherit";
    if (state === "on") {
        return { ...skill, disableModelInvocation: false };
    }
    if (state === "name-only") {
        return { ...skill, description: "", disableModelInvocation: false };
    }
    if (state === "off" || state === "user-only") {
        return { ...skill, disableModelInvocation: true };
    }
    return skill;
}

export function applySkillPolicyToPrompt(
    systemPrompt: string,
    skills: readonly Skill[],
    plan: PolicyPlan,
): string {
    const originalSection = formatSkillsForPrompt([...skills]);
    const desiredSection = formatSkillsForPrompt(skills.map((skill) => skillForModel(skill, plan)));
    if (originalSection.length > 0 && systemPrompt.includes(originalSection)) {
        return systemPrompt.replace(originalSection, desiredSection);
    }
    const withoutStandardSection = systemPrompt.replace(STANDARD_SKILL_SECTION, "");
    if (desiredSection.length === 0 || withoutStandardSection.includes(desiredSection)) {
        return withoutStandardSection;
    }
    return `${withoutStandardSection}${desiredSection}`;
}

export function parseSkillInvocation(text: string): string | undefined {
    return /^\s*\/skill:([^\s]+)(?:\s|$)/u.exec(text)?.[1];
}

export function decideSkillInvocation(
    plan: PolicyPlan,
    text: string,
):
    | { readonly allowed: true }
    | { readonly allowed: false; readonly name: string; readonly reason: string } {
    const name = parseSkillInvocation(text);
    if (name === undefined) {
        return { allowed: true };
    }
    const matches = plan.capabilities.filter(
        (candidate) => candidate.capability.kind === "skill" && candidate.capability.name === name,
    );
    const entry =
        matches.find((candidate) => candidate.capability.observedState !== "unavailable") ??
        matches[0];
    if (entry?.desiredState !== "off") {
        return { allowed: true };
    }
    return {
        allowed: false,
        name,
        reason: `Pi Toggles blocked /skill:${name}: effective state is off. Use /toggles explain skill:${name}.`,
    };
}
