import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { createPolicyConfiguration } from "./capability-policy.ts";
import { buildCapabilityCatalog } from "./capability-catalog.ts";
import { resolveCapabilityPolicy } from "./resolve-capability-policy.ts";
import { applySkillPolicyToPrompt, decideSkillInvocation } from "./skill-policy.ts";
import type { ExtensionSettings } from "./settings.ts";

const skill: Skill = {
    name: "review",
    description: "Review code carefully",
    filePath: "/agent/skills/review/SKILL.md",
    baseDir: "/agent/skills/review",
    sourceInfo: {
        source: "skills",
        scope: "user",
        origin: "top-level",
        path: "/agent/skills/review/SKILL.md",
        baseDir: "/agent/skills/review",
    },
    disableModelInvocation: false,
};

const resolved: ExtensionSettings = {
    enabled: true,
    defaults: { unknownCondition: "no-match", lazyToolLimit: 5, showStatus: true },
    activeProfile: "",
    overrides: [],
    profiles: {},
    promptFragments: [],
    rules: [],
};

function planFor(state: "off" | "on" | "name-only" | "user-only") {
    const catalog = buildCapabilityCatalog({
        tools: [],
        activeToolNames: new Set(),
        commands: [],
        skills: [skill],
        promptFragments: [],
    });
    const configuration = createPolicyConfiguration({
        resolved,
        globalDocument: {
            overrides: [
                {
                    target: { kind: "skill", source: "skills", name: "review" },
                    state,
                },
            ],
        },
        session: { overrides: [] },
    });
    return resolveCapabilityPolicy(catalog, configuration, () => ({
        status: "missing",
        reason: "not used",
    }));
}

describe("skill policy", () => {
    it.each(["read", "bash"] as const)(
        "removes off skills from the native structured prompt with %s",
        (tool) => {
            const base = `<rules>Existing rules</rules>\n\n<skills>\n${formatSkillsForPrompt([skill], tool).trimStart()}\n</skills>`;
            const filtered = applySkillPolicyToPrompt(base, [skill], planFor("off"));

            expect(base).toContain("<name>review</name>");
            expect(filtered).not.toContain("<name>review</name>");
            expect(filtered).toContain("<rules>");
        },
    );
    it("removes off and user-only skills from the model prompt", () => {
        const base = `Base\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>review</name>\n    <description>Review code carefully</description>\n    <location>/agent/skills/review/SKILL.md</location>\n  </skill>\n</available_skills>`;
        expect(applySkillPolicyToPrompt(base, [skill], planFor("off"))).toBe("Base");
        expect(applySkillPolicyToPrompt(base, [skill], planFor("user-only"))).toBe("Base");
    });

    it("keeps only the skill name in name-only model metadata", () => {
        const plan = planFor("name-only");
        const prompt = applySkillPolicyToPrompt("Base", [skill], plan);
        expect(plan.capabilities[0]?.effectiveState).toBe("name-only");
        expect(prompt).toContain("<name>review</name>");
        expect(prompt).toContain("<description></description>");
        expect(prompt).not.toContain("Review code carefully");
    });

    it("lets explicit on policy reveal a natively user-only skill", () => {
        const prompt = applySkillPolicyToPrompt(
            "Base",
            [{ ...skill, disableModelInvocation: true }],
            planFor("on"),
        );
        expect(prompt).toContain("<name>review</name>");
        expect(prompt).toContain("Review code carefully");
    });

    it("blocks only explicit invocations of off skills", () => {
        const plan = planFor("off");
        expect(decideSkillInvocation(plan, "/skill:review focus on security").allowed).toBe(false);
        expect(decideSkillInvocation(plan, "review this normally")).toEqual({ allowed: true });
    });
});
