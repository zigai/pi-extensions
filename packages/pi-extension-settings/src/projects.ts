import { glob } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Result, type Result as ResultType } from "better-result";

import type { SettingsArtifactTargets } from "./artifacts.ts";
import { isExtensionSettingsDefinition, type ExtensionSettingsDefinition } from "./definition.ts";
import {
    DefinitionModuleInvalid,
    ProjectManifestInvalid,
    type ProjectFailure,
} from "./failures.ts";
import { readTextIfPresent } from "./file-system.ts";
import { isJsonObject, parseJson, type JsonObject } from "./json-value.ts";

export const PACKAGE_MANIFEST_KEY = "piExtensionSettings";

type SettingsProjectManifest = {
    readonly definition: string;
    readonly schema: string;
    readonly readme: string;
    readonly globalPath?: string;
};

export type SettingsArtifactProject = {
    readonly packageRoot: string;
    readonly definition: ExtensionSettingsDefinition;
    readonly targets: SettingsArtifactTargets;
};

function stringProperty(object: JsonObject, key: string): string | undefined {
    const value = object[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseSettingsManifest(
    packagePath: string,
    packageJson: JsonObject,
): ResultType<SettingsProjectManifest | undefined, ProjectManifestInvalid> {
    const raw = packageJson[PACKAGE_MANIFEST_KEY];
    if (raw === undefined) return Result.ok(undefined);
    if (!isJsonObject(raw)) {
        return Result.err(
            new ProjectManifestInvalid({
                path: packagePath,
                reason: `${PACKAGE_MANIFEST_KEY} must be an object`,
            }),
        );
    }

    const supported = new Set(["definition", "schema", "readme", "globalPath"]);
    const unknownKeys = Object.keys(raw).filter((key) => !supported.has(key));
    if (unknownKeys.length > 0) {
        return Result.err(
            new ProjectManifestInvalid({
                path: packagePath,
                reason: `unknown keys: ${unknownKeys.join(", ")}`,
            }),
        );
    }

    const definition = stringProperty(raw, "definition");
    if (definition === undefined) {
        return Result.err(
            new ProjectManifestInvalid({
                path: packagePath,
                reason: "definition must be a non-empty relative path",
            }),
        );
    }

    const schema = stringProperty(raw, "schema") ?? "config.schema.json";
    const readme = stringProperty(raw, "readme") ?? "README.md";
    const globalPath = stringProperty(raw, "globalPath");
    return Result.ok(
        globalPath === undefined
            ? { definition, schema, readme }
            : { definition, schema, readme, globalPath },
    );
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
        return workspaces.filter((value): value is string => typeof value === "string");
    }
    if (!isJsonObject(workspaces) || !Array.isArray(workspaces.packages)) return [];
    return workspaces.packages.filter((value): value is string => typeof value === "string");
}

async function readPackageJson(path: string): Promise<ResultType<JsonObject, ProjectFailure>> {
    const content = readTextIfPresent(path);
    if (Result.isError(content)) return content;
    if (content.value === undefined) {
        return Result.err(new ProjectManifestInvalid({ path, reason: "file does not exist" }));
    }
    const parsed = parseJson(content.value);
    if (!isJsonObject(parsed)) {
        return Result.err(new ProjectManifestInvalid({ path, reason: "file is not valid JSON" }));
    }
    return Result.ok(parsed);
}

async function packageJsonPaths(
    root: string,
): Promise<ResultType<readonly string[], ProjectFailure>> {
    const rootPackagePath = resolve(root, "package.json");
    const rootPackage = await readPackageJson(rootPackagePath);
    if (Result.isError(rootPackage)) return rootPackage;

    const paths = new Set<string>([rootPackagePath]);
    for (const pattern of workspacePatterns(rootPackage.value)) {
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
    return Result.ok([...paths].sort());
}

function isObjectWithDefault(value: unknown): value is { readonly default: unknown } {
    return value !== null && typeof value === "object" && "default" in value;
}

async function importDefinition(
    path: string,
): Promise<ResultType<ExtensionSettingsDefinition, DefinitionModuleInvalid>> {
    let imported: unknown;
    try {
        imported = await import(pathToFileURL(path).href);
    } catch (cause: unknown) {
        return Result.err(
            new DefinitionModuleInvalid({
                path,
                reason: "module could not be imported",
                cause,
            }),
        );
    }

    if (!isObjectWithDefault(imported) || !isExtensionSettingsDefinition(imported.default)) {
        return Result.err(
            new DefinitionModuleInvalid({
                path,
                reason: "default export must be created by defineExtensionSettings",
            }),
        );
    }
    return Result.ok(imported.default);
}

async function loadProject(
    packagePath: string,
): Promise<ResultType<SettingsArtifactProject | undefined, ProjectFailure>> {
    const packageJson = await readPackageJson(packagePath);
    if (Result.isError(packageJson)) return packageJson;

    const manifest = parseSettingsManifest(packagePath, packageJson.value);
    if (Result.isError(manifest)) return manifest;
    if (manifest.value === undefined) return Result.ok(undefined);

    const packageRoot = dirname(packagePath);
    const definitionPath = resolveInside(packageRoot, manifest.value.definition);
    const schemaPath = resolveInside(packageRoot, manifest.value.schema);
    const readmePath = resolveInside(packageRoot, manifest.value.readme);
    if (definitionPath === undefined || schemaPath === undefined || readmePath === undefined) {
        return Result.err(
            new ProjectManifestInvalid({
                path: packagePath,
                reason: "definition, schema, and readme paths must stay inside the package",
            }),
        );
    }

    const definition = await importDefinition(definitionPath);
    if (Result.isError(definition)) return definition;
    const targets: SettingsArtifactTargets =
        manifest.value.globalPath === undefined
            ? { schemaPath, readmePath }
            : { schemaPath, readmePath, globalPath: manifest.value.globalPath };
    return Result.ok({ packageRoot, definition: definition.value, targets });
}

/** Discover configured standalone packages and npm workspace packages. */
export async function discoverSettingsProjects(
    root: string,
): Promise<ResultType<readonly SettingsArtifactProject[], ProjectFailure>> {
    const paths = await packageJsonPaths(root);
    if (Result.isError(paths)) return paths;

    const projects: SettingsArtifactProject[] = [];
    for (const path of paths.value) {
        const project = await loadProject(path);
        if (Result.isError(project)) return project;
        if (project.value !== undefined) projects.push(project.value);
    }
    return Result.ok(projects);
}
