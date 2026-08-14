import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { compileTypedCommandDefinition } from "../compiler.js";
import { diagnosticMessages } from "../diagnostics.js";
import { DEFAULT_FORM_SYMBOLS } from "../command/symbols.js";
import type { RegisteredTypedCommand } from "../pi/command-types.js";
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
    if (skill.name.length === 0 || /[\s\p{Cc}]/u.test(skill.name) || skill.name.startsWith("-")) {
        throw new TypeError(`Invalid typed skill name ${JSON.stringify(skill.name)}`);
    }
    const commandName = `skill:${skill.name}`;
    const compiled = compileTypedCommandDefinition({
        name: commandName,
        description: skill.description,
        args: skill.args,
    });
    if (!compiled.ok) {
        throw new TypeError(
            [
                `Invalid typed arguments for /${commandName}:`,
                ...diagnosticMessages(compiled.diagnostics),
            ].join("\n"),
        );
    }
    const snapshot: TypedSkillMetadata = Object.freeze({
        ...skill,
        args: compiled.command.args,
    });
    const formFields: { formTitle?: string; ghostText?: string } = {};
    if (snapshot.formTitle !== undefined) {
        formFields.formTitle = snapshot.formTitle;
    }
    if (snapshot.ghostText !== undefined) {
        formFields.ghostText = snapshot.ghostText;
    }
    const command: RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } = {
        name: commandName,
        description: snapshot.description,
        args: compiled.command.args,
        compiled: compiled.command,
        target: {
            kind: "skill",
            render: (args, additionalInput) => {
                const options: RenderTypedSkillInvocationOptions = {
                    skill: snapshot,
                    values: args,
                };
                if (additionalInput !== undefined) {
                    options.additionalInput = additionalInput;
                }
                return renderTypedSkillInvocation(options);
            },
        },
        formSymbols: Object.freeze({ ...DEFAULT_FORM_SYMBOLS }),
        source: "skill",
        skill: snapshot,
        ...formFields,
    };
    return Object.freeze(command);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return whether a registered typed command represents a complete typed skill invocation. */
export function isTypedSkillCommand(
    command: RegisteredTypedCommand,
): command is RegisteredTypedCommand & { source: "skill"; skill: TypedSkillMetadata } {
    if (command.source !== "skill" || !("skill" in command) || !isRecord(command.skill)) {
        return false;
    }
    const skill = command.skill;
    return (
        typeof skill.name === "string" &&
        typeof skill.description === "string" &&
        typeof skill.filePath === "string" &&
        typeof skill.baseDir === "string" &&
        typeof skill.body === "string" &&
        isRecord(skill.args) &&
        (skill.formTitle === undefined || typeof skill.formTitle === "string") &&
        (skill.ghostText === undefined || typeof skill.ghostText === "string")
    );
}
