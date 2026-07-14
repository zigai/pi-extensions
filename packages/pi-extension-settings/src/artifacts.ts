import type { ExtensionSettingsDefinition } from "./definition.ts";
import { readTextIfPresent, writeTextAtomically } from "./file-system.ts";
import { formatJson } from "./json-value.ts";
import {
    renderReadmeSettingsSection,
    replaceGeneratedReadmeSection,
    type RenderReadmeOptions,
} from "./settings-documentation.ts";
import { createSettingsFileSchema } from "./schema-document.ts";

export type SettingsArtifactTargets = {
    readonly schemaPath: string;
    readonly readmePath: string;
    readonly globalPath?: string;
};

export type RenderedSettingsArtifacts = {
    readonly schema: string;
    readonly readmeSection: string;
};

export type GeneratedSettingsArtifacts = {
    readonly changedPaths: readonly string[];
};

export type CheckedSettingsArtifacts = {
    readonly current: boolean;
    readonly stalePaths: readonly string[];
};

function readmeRenderOptions(targets: SettingsArtifactTargets): RenderReadmeOptions {
    return targets.globalPath === undefined ? {} : { globalPath: targets.globalPath };
}

export function renderSettingsArtifacts(
    definition: ExtensionSettingsDefinition,
    targets: SettingsArtifactTargets,
): RenderedSettingsArtifacts {
    return {
        schema: formatJson(createSettingsFileSchema(definition)),
        readmeSection: renderReadmeSettingsSection(definition, readmeRenderOptions(targets)),
    };
}

function expectedReadme(readmePath: string, section: string): string {
    const current = readTextIfPresent(readmePath);
    if (current === undefined) {
        throw new Error(`README does not exist: ${readmePath}`);
    }

    const expected = replaceGeneratedReadmeSection(current, section);
    if (expected === undefined) {
        throw new Error(`README generation markers are invalid in ${readmePath}`);
    }
    return expected;
}

export function generateSettingsArtifacts(
    definition: ExtensionSettingsDefinition,
    targets: SettingsArtifactTargets,
): GeneratedSettingsArtifacts {
    const rendered = renderSettingsArtifacts(definition, targets);
    const readme = expectedReadme(targets.readmePath, rendered.readmeSection);

    const changedPaths: string[] = [];
    if (writeTextAtomically(targets.schemaPath, rendered.schema) !== "unchanged") {
        changedPaths.push(targets.schemaPath);
    }
    if (writeTextAtomically(targets.readmePath, readme) !== "unchanged") {
        changedPaths.push(targets.readmePath);
    }

    return { changedPaths };
}

export function checkSettingsArtifacts(
    definition: ExtensionSettingsDefinition,
    targets: SettingsArtifactTargets,
): CheckedSettingsArtifacts {
    const rendered = renderSettingsArtifacts(definition, targets);
    const readme = expectedReadme(targets.readmePath, rendered.readmeSection);
    const schemaCurrent = readTextIfPresent(targets.schemaPath);
    const readmeCurrent = readTextIfPresent(targets.readmePath);

    const stalePaths: string[] = [];
    if (schemaCurrent !== rendered.schema) stalePaths.push(targets.schemaPath);
    if (readmeCurrent !== readme) stalePaths.push(targets.readmePath);

    return { current: stalePaths.length === 0, stalePaths };
}
