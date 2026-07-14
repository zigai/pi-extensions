import { Result, type Result as ResultType } from "better-result";

import type { ExtensionSettingsDefinition } from "./definition.ts";
import { ReadmeMarkersMissing, type ArtifactFailure } from "./failures.ts";
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

function expectedReadme(readmePath: string, section: string): ResultType<string, ArtifactFailure> {
    const current = readTextIfPresent(readmePath);
    if (Result.isError(current)) return current;
    if (current.value === undefined) return Result.err(new ReadmeMarkersMissing(readmePath));

    const expected = replaceGeneratedReadmeSection(current.value, section);
    return expected === undefined
        ? Result.err(new ReadmeMarkersMissing(readmePath))
        : Result.ok(expected);
}

export function generateSettingsArtifacts(
    definition: ExtensionSettingsDefinition,
    targets: SettingsArtifactTargets,
): ResultType<GeneratedSettingsArtifacts, ArtifactFailure> {
    const rendered = renderSettingsArtifacts(definition, targets);
    const readme = expectedReadme(targets.readmePath, rendered.readmeSection);
    if (Result.isError(readme)) return readme;

    const changedPaths: string[] = [];
    const schemaWrite = writeTextAtomically(targets.schemaPath, rendered.schema);
    if (Result.isError(schemaWrite)) return schemaWrite;
    if (schemaWrite.value !== "unchanged") changedPaths.push(targets.schemaPath);

    const readmeWrite = writeTextAtomically(targets.readmePath, readme.value);
    if (Result.isError(readmeWrite)) return readmeWrite;
    if (readmeWrite.value !== "unchanged") changedPaths.push(targets.readmePath);

    return Result.ok({ changedPaths });
}

export function checkSettingsArtifacts(
    definition: ExtensionSettingsDefinition,
    targets: SettingsArtifactTargets,
): ResultType<CheckedSettingsArtifacts, ArtifactFailure> {
    const rendered = renderSettingsArtifacts(definition, targets);
    const readme = expectedReadme(targets.readmePath, rendered.readmeSection);
    if (Result.isError(readme)) return readme;

    const schemaCurrent = readTextIfPresent(targets.schemaPath);
    const readmeCurrent = readTextIfPresent(targets.readmePath);
    if (Result.isError(schemaCurrent)) return schemaCurrent;
    if (Result.isError(readmeCurrent)) return readmeCurrent;

    const stalePaths: string[] = [];
    if (schemaCurrent.value !== rendered.schema) stalePaths.push(targets.schemaPath);
    if (readmeCurrent.value !== readme.value) stalePaths.push(targets.readmePath);

    return Result.ok({ current: stalePaths.length === 0, stalePaths });
}
