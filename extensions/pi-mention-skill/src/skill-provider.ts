import path from "node:path";

import { createListProvider, type Candidate, type Provider } from "@zigai/pi-mention-anything/api";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
    formatSkillBlock,
    type SkillExpansionLoader,
    type SkillExpansionTarget,
} from "./skill-content.ts";
import { skillName, type SkillCommand } from "./skill-commands.ts";

const skillCandidateDataSchema = Type.Object(
    {
        name: Type.String(),
        location: Type.String(),
        baseDir: Type.String(),
    },
    { additionalProperties: false },
);

type SkillCandidateData = Static<typeof skillCandidateDataSchema>;

type SkillProviderOptions = {
    readonly projectSkillsFirst: boolean;
};

function candidateData(candidate: Candidate): SkillCandidateData {
    return Value.Parse(skillCandidateDataSchema, candidate.data);
}

function skillCandidate(command: SkillCommand): Candidate {
    const name = skillName(command);
    const data: SkillCandidateData = {
        name,
        location: command.sourceInfo.path,
        baseDir: path.dirname(command.sourceInfo.path),
    };

    return {
        id: command.name,
        label: name,
        segment: name,
        description: command.description,
        searchText: `${name} ${command.description}`,
        selectable: true,
        navigable: false,
        data,
    };
}

export async function resolveSkillCandidate(
    candidatePath: readonly Candidate[],
    loadSkillExpansion: SkillExpansionLoader,
    signal?: AbortSignal,
): Promise<string> {
    signal?.throwIfAborted();
    const target = candidatePath.at(-1);
    if (target === undefined) throw new Error("Skill mention resolved without a target.");

    const expansionTarget: SkillExpansionTarget = candidateData(target);
    const expansion = await loadSkillExpansion(expansionTarget);
    signal?.throwIfAborted();
    return formatSkillBlock(expansion);
}

export function createSkillProvider(
    loadCommands: () => SkillCommand[],
    loadSkillExpansion: SkillExpansionLoader,
    options: SkillProviderOptions,
): Provider {
    const provider = createListProvider(async (request) => {
        request.signal.throwIfAborted();
        const commands = loadCommands();
        if (options.projectSkillsFirst) {
            commands.sort((left, right) => {
                const leftProject = left.sourceInfo.scope === "project";
                const rightProject = right.sourceInfo.scope === "project";
                if (leftProject === rightProject) return 0;
                if (leftProject) return -1;
                return 1;
            });
        }

        return commands.map(skillCandidate);
    });

    return {
        ...provider,
        async resolve(request) {
            const resolution = await provider.resolve(request);
            if (resolution.status === "unresolved") return resolution;

            return {
                ...resolution,
                replacement: await resolveSkillCandidate(
                    resolution.path,
                    loadSkillExpansion,
                    request.signal,
                ),
            };
        },
    };
}
