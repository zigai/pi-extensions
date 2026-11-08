import { parseMentions } from "@zigai/pi-mention-anything/api";

import { skillName, type SkillCommand } from "./skill-commands.ts";

/** Event-bus channel on which the skills named in user input are reported to other extensions. */
export const SKILLS_MENTIONED_CHANNEL = "skills:mentioned";

export type SkillsMentioned = {
    readonly names: readonly string[];

    /** True for input delivered while the agent runs, which adds to the current request. */
    readonly append: boolean;
};

export function mentionedSkillNames(
    text: string,
    trigger: string,
    commands: readonly SkillCommand[],
): string[] {
    const known = new Set(commands.map(skillName));
    const names = parseMentions(text, [{ id: "skill", trigger }])
        .filter((mention) => mention.complete && mention.segments.length === 1)
        .flatMap((mention) => mention.segments)
        .filter((name) => known.has(name));

    return [...new Set(names)];
}
