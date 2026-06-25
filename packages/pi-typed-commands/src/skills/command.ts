import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { DEFAULT_FORM_SYMBOLS } from "../command/symbols.js";
import type { RegisteredTypedCommand } from "../types.js";
import { renderTypedSkillInvocation } from "./prompt.js";
import type { RenderTypedSkillInvocationOptions, TypedSkillMetadata } from "./types.js";

/** Extract the `SKILL.md` path from a Pi skill command record. */
export function skillPathFromCommand(command: SlashCommandInfo): string | undefined {
    if (command.source !== "skill") {
        return undefined;
    }
    if (!command.name.startsWith("skill:")) {
        return undefined;
    }
    return command.sourceInfo.path;
}

/** Adapt typed skill metadata into the internal typed command representation. */
export function typedSkillCommandFromMetadata(
    skill: TypedSkillMetadata,
): RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } {
    const command: RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } = {
        name: `skill:${skill.name}`,
        description: skill.description,
        args: skill.args,
        target: {
            kind: "skill",
            render: (args, additionalInput) => {
                const options: RenderTypedSkillInvocationOptions = {
                    skill,
                    values: args,
                };
                if (additionalInput !== undefined) {
                    options.additionalInput = additionalInput;
                }
                return renderTypedSkillInvocation(options);
            },
        },
        formSymbols: { ...DEFAULT_FORM_SYMBOLS },
        source: "skill",
        skill,
    };
    if (skill.formTitle !== undefined) {
        command.formTitle = skill.formTitle;
    }
    return command;
}

/** Return whether a registered typed command represents a typed skill invocation. */
export function isTypedSkillCommand(
    command: RegisteredTypedCommand,
): command is RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } {
    return (command as { source?: unknown }).source === "skill";
}
