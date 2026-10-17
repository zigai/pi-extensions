import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { TypedCommandRegistry } from "../registry.ts";
import { skillPathFromCommand, typedSkillCommandFromMetadata } from "../skills/command.ts";
import { readTypedSkillMetadataResult } from "../skills/metadata.ts";
import type { TypedSkillDiagnostics } from "../skills/types.ts";
import type { RegisteredTypedCommand } from "./command-types.ts";

const RESOURCE_SNAPSHOTS = Symbol.for("pi-typed-args.skill-resource-snapshots");

type SkillSnapshot = {
    readonly commands: readonly RegisteredTypedCommand[];
    readonly diagnostics: readonly TypedSkillDiagnostics[];
};

type SharedSkillSnapshots = WeakMap<SessionStartEvent, Map<string, SkillSnapshot>>;

type GlobalWithSkillSnapshots = typeof globalThis & {
    [RESOURCE_SNAPSHOTS]?: SharedSkillSnapshots;
};

function sharedSkillSnapshots(): SharedSkillSnapshots {
    const globalObject: GlobalWithSkillSnapshots = globalThis;
    let snapshots = globalObject[RESOURCE_SNAPSHOTS];
    if (snapshots === undefined) {
        snapshots = new WeakMap();
        globalObject[RESOURCE_SNAPSHOTS] = snapshots;
    }

    return snapshots;
}

export function refreshTypedSkills(
    pi: ExtensionAPI,
    registry: TypedCommandRegistry,
    resourceSnapshot: SessionStartEvent,
): void {
    const resources = pi.getCommands().flatMap((command) => {
        const path = skillPathFromCommand(command);
        if (path === undefined) return [];

        return [{ path, name: command.name.replace(/^skill:/, "") }];
    });
    const snapshots = sharedSkillSnapshots();
    let resourceSets = snapshots.get(resourceSnapshot);
    if (resourceSets === undefined) {
        resourceSets = new Map();
        snapshots.set(resourceSnapshot, resourceSets);
    }

    const key = JSON.stringify(resources);
    let snapshot = resourceSets.get(key);
    if (snapshot === undefined) {
        const commands: RegisteredTypedCommand[] = [];
        const diagnostics: TypedSkillDiagnostics[] = [];
        for (const resource of resources) {
            const result = readTypedSkillMetadataResult(resource.path, {
                fallbackName: resource.name,
            });
            if (result.status === "ok")
                commands.push(typedSkillCommandFromMetadata(result.metadata));

            if (result.status === "invalid") diagnostics.push(result.diagnostics);
        }

        snapshot = { commands, diagnostics };
        resourceSets.set(key, snapshot);
    }

    registry.replaceSkills(snapshot.commands, snapshot.diagnostics);
}
