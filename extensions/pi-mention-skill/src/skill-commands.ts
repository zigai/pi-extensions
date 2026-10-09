import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export type SkillCommand = SlashCommandInfo & {
    name: `skill:${string}`;
    description: string;
};

const SKILL_COMMAND_PREFIX = "skill:";

export function getSkillCommands(pi: Pick<ExtensionAPI, "getCommands">): SkillCommand[] {
    return pi.getCommands().filter((command): command is SkillCommand => {
        return command.source === "skill" && command.name.startsWith(SKILL_COMMAND_PREFIX);
    });
}

export function skillName(command: SkillCommand): string {
    return command.name.slice(SKILL_COMMAND_PREFIX.length);
}
