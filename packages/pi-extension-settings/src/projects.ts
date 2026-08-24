import { glob } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { SettingsArtifactTargets } from "./artifacts.ts";
import {
    defineExtensionSettings,
    ExtensionSettingsDefinitionCandidateSchema,
    type ExtensionSettingsDefinition,
} from "./definition.ts";
import { readTextIfPresent } from "./file-system.ts";
import { isJsonObject, isJsonString, parseJson, type JsonObject } from "./json-value.ts";
import { Type, Value } from "./typebox-runtime.ts";

export const PACKAGE_MANIFEST_KEY = "piExtensionSettings";

const ImportedDefinitionModuleSchema = Type.Object({
    default: ExtensionSettingsDefinitionCandidateSchema,
});

type SettingsProjectManifest = {
    readonly definition: string;
    readonly schema: string;
    readonly readme: string;
    readonly prevalidation?: string;
    readonly globalPath?: string;
};

export type SettingsArtifactProject = {
    readonly packageRoot: string;
    readonly definition: ExtensionSettingsDefinition;
    readonly targets: SettingsArtifactTargets;
};

function manifestError(path: string, reason: string): Error {
    return new Error(`Invalid Pi extension settings manifest in ${path}: ${reason}`);
}

function stringProperty(object: JsonObject, key: string): string | undefined {
    const value = object[key];
    return isJsonString(value) && value.trim() !== "" ? value : undefined;
}

function parseSettingsManifest(
    packagePath: string,
    packageJson: JsonObject,
): SettingsProjectManifest | undefined {
    const raw = packageJson[PACKAGE_MANIFEST_KEY];
    if (raw === undefined) return undefined;
    if (!isJsonObject(raw)) {
        throw manifestError(packagePath, `${PACKAGE_MANIFEST_KEY} must be an object`);
    }

    const supported = new Set(["definition", "schema", "readme", "prevalidation", "globalPath"]);
    const unknownKeys = Object.keys(raw).filter((key) => !supported.has(key));
    if (unknownKeys.length > 0) {
        throw manifestError(packagePath, `unknown keys: ${unknownKeys.join(", ")}`);
    }

    const definition = stringProperty(raw, "definition");
    if (definition === undefined) {
        throw manifestError(packagePath, "definition must be a non-empty relative path");
    }

    const schema = stringProperty(raw, "schema") ?? "config.schema.json";
    const readme = stringProperty(raw, "readme") ?? "README.md";
    const prevalidation = stringProperty(raw, "prevalidation");
    const globalPath = stringProperty(raw, "globalPath");
    if (prevalidation === undefined) {
        return globalPath === undefined
            ? { definition, schema, readme }
            : { definition, schema, readme, globalPath };
    }
    return globalPath === undefined
        ? { definition, schema, readme, prevalidation }
        : { definition, schema, readme, prevalidation, globalPath };
}

function resolveInside(packageRoot: string, configuredPath: string): string | undefined {
    if (isAbsolute(configuredPath)) return undefined;
    const resolved = resolve(packageRoot, configuredPath);
    const relativePath = relative(packageRoot, resolved);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
        return resolved;
    }
    return undefined;
}

function workspacePatterns(packageJson: JsonObject): readonly string[] {
    const workspaces = packageJson.workspaces;
    if (Array.isArray(workspaces)) {
        return workspaces.filter(isJsonString);
    }
    if (!isJsonObject(workspaces) || !Array.isArray(workspaces.packages)) return [];
    return workspaces.packages.filter(isJsonString);
}

function readPackageJson(path: string): JsonObject {
    const content = readTextIfPresent(path);
    if (content === undefined) throw manifestError(path, "file does not exist");

    const parsed = parseJson(content);
    if (!isJsonObject(parsed)) throw manifestError(path, "file is not valid JSON");
    return parsed;
}

async function packageJsonPaths(root: string): Promise<readonly string[]> {
    const rootPackagePath = resolve(root, "package.json");
    const rootPackage = readPackageJson(rootPackagePath);

    const paths = new Set<string>([rootPackagePath]);
    for (const pattern of workspacePatterns(rootPackage)) {
        const packagePattern = pattern.endsWith("package.json")
            ? pattern
            : `${pattern.replace(/\/$/, "")}/package.json`;
        for await (const match of glob(packagePattern, {
            cwd: root,
            exclude: ["**/node_modules/**"],
        })) {
            paths.add(resolve(root, match));
        }
    }
    return [...paths].sort();
}

async function importDefinition(path: string): Promise<ExtensionSettingsDefinition> {
    let imported: unknown;
    try {
        imported = await import(pathToFileURL(path).href);
    } catch (cause: unknown) {
        throw new Error(
            `Invalid settings definition module ${path}: module could not be imported`,
            {
                cause,
            },
        );
    }

    const invalidDefaultMessage = `Invalid settings definition module ${path}: default export must be created by defineExtensionSettings or be a valid definition input`;
    let candidateModule;
    try {
        candidateModule = Value.Parse(ImportedDefinitionModuleSchema, imported);
    } catch (cause: unknown) {
        throw new Error(invalidDefaultMessage, { cause });
    }
    try {
        // Always execute exhaustive authoring validation, including when the module exported a
        // pre-existing definition created through a runtime fast path.
        return defineExtensionSettings(candidateModule.default);
    } catch (cause: unknown) {
        throw new Error(invalidDefaultMessage, { cause });
    }
}

async function loadProject(packagePath: string): Promise<SettingsArtifactProject | undefined> {
    const packageJson = readPackageJson(packagePath);
    const manifest = parseSettingsManifest(packagePath, packageJson);
    if (manifest === undefined) return undefined;

    const packageRoot = dirname(packagePath);
    const definitionPath = resolveInside(packageRoot, manifest.definition);
    const schemaPath = resolveInside(packageRoot, manifest.schema);
    const readmePath = resolveInside(packageRoot, manifest.readme);
    const prevalidationPath =
        manifest.prevalidation === undefined
            ? undefined
            : resolveInside(packageRoot, manifest.prevalidation);
    if (
        definitionPath === undefined ||
        schemaPath === undefined ||
        readmePath === undefined ||
        (manifest.prevalidation !== undefined && prevalidationPath === undefined)
    ) {
        throw manifestError(
            packagePath,
            "definition, schema, readme, and prevalidation paths must stay inside the package",
        );
    }

    const definition = await importDefinition(definitionPath);
    let targets: SettingsArtifactTargets;
    if (prevalidationPath === undefined) {
        targets =
            manifest.globalPath === undefined
                ? { schemaPath, readmePath }
                : { schemaPath, readmePath, globalPath: manifest.globalPath };
    } else {
        targets =
            manifest.globalPath === undefined
                ? { schemaPath, readmePath, prevalidationPath }
                : {
                      schemaPath,
                      readmePath,
                      prevalidationPath,
                      globalPath: manifest.globalPath,
                  };
    }
    return { packageRoot, definition, targets };
}

export async function discoverSettingsProjects(
    root: string,
): Promise<readonly SettingsArtifactProject[]> {
    const paths = await packageJsonPaths(root);
    const projects: SettingsArtifactProject[] = [];
    for (const path of paths) {
        const project = await loadProject(path);
        if (project !== undefined) projects.push(project);
    }
    return projects;
}
