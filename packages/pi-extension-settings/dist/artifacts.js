import { Result } from "better-result";
import { ReadmeMarkersMissing } from "./failures.js";
import { readTextIfPresent, writeTextAtomically } from "./file-system.js";
import { formatJson } from "./json-value.js";
import { renderReadmeSettingsSection, replaceGeneratedReadmeSection, } from "./readme.js";
import { createSettingsFileSchema } from "./schema-document.js";
function readmeRenderOptions(targets) {
    return targets.globalPath === undefined ? {} : { globalPath: targets.globalPath };
}
/** Render deterministic repository artifacts without touching the filesystem. */
export function renderSettingsArtifacts(definition, targets) {
    return {
        schema: formatJson(createSettingsFileSchema(definition)),
        readmeSection: renderReadmeSettingsSection(definition, readmeRenderOptions(targets)),
    };
}
async function expectedReadme(readmePath, section) {
    const current = await readTextIfPresent(readmePath);
    if (Result.isError(current))
        return current;
    if (current.value === undefined)
        return Result.err(new ReadmeMarkersMissing(readmePath));
    const expected = replaceGeneratedReadmeSection(current.value, section);
    return expected === undefined
        ? Result.err(new ReadmeMarkersMissing(readmePath))
        : Result.ok(expected);
}
/** Generate the checked-in schema and marked README section. */
export async function generateSettingsArtifacts(definition, targets) {
    const rendered = renderSettingsArtifacts(definition, targets);
    const readme = await expectedReadme(targets.readmePath, rendered.readmeSection);
    if (Result.isError(readme))
        return readme;
    const changedPaths = [];
    const schemaWrite = await writeTextAtomically(targets.schemaPath, rendered.schema);
    if (Result.isError(schemaWrite))
        return schemaWrite;
    if (schemaWrite.value !== "unchanged")
        changedPaths.push(targets.schemaPath);
    const readmeWrite = await writeTextAtomically(targets.readmePath, readme.value);
    if (Result.isError(readmeWrite))
        return readmeWrite;
    if (readmeWrite.value !== "unchanged")
        changedPaths.push(targets.readmePath);
    return Result.ok({ changedPaths });
}
/** Check generated artifacts without modifying the working tree. */
export async function checkSettingsArtifacts(definition, targets) {
    const rendered = renderSettingsArtifacts(definition, targets);
    const readme = await expectedReadme(targets.readmePath, rendered.readmeSection);
    if (Result.isError(readme))
        return readme;
    const [schemaCurrent, readmeCurrent] = await Promise.all([
        readTextIfPresent(targets.schemaPath),
        readTextIfPresent(targets.readmePath),
    ]);
    if (Result.isError(schemaCurrent))
        return schemaCurrent;
    if (Result.isError(readmeCurrent))
        return readmeCurrent;
    const stalePaths = [];
    if (schemaCurrent.value !== rendered.schema)
        stalePaths.push(targets.schemaPath);
    if (readmeCurrent.value !== readme.value)
        stalePaths.push(targets.readmePath);
    return Result.ok({ current: stalePaths.length === 0, stalePaths });
}
//# sourceMappingURL=artifacts.js.map