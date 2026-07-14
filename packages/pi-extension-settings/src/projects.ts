import { glob } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { SettingsArtifactTargets } from "./artifacts.ts";
import { isExtensionSettingsDefinition, type ExtensionSettingsDefinition } from "./definition.ts";
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

function manifestError(path: string, reason: string): Error {
    return new Error(`Invalid Pi extension settings manifest in ${path}: ${reason}`);
}

function stringProperty(object: JsonObject, key: string): string | undefined {
    const value = object[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

    const supported = new Set(["definition", "schema", "readme", "globalPath"]);
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
    const globalPath = stringProperty(raw, "globalPath");
    return globalPath === undefined
        ? { definition, schema, readme }
        : { definition, schema, readme, globalPath };
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

function isObjectWithDefault(value: unknown): value is { readonly default: unknown } {
    return value !== null && typeof value === "object" && "default" in value;
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

    if (!isObjectWithDefault(imported) || !isExtensionSettingsDefinition(imported.default)) {
        throw new Error(
            `Invalid settings definition module ${path}: default export must be created by defineExtensionSettings`,
        );
    }
    return imported.default;
}

async function loadProject(packagePath: string): Promise<SettingsArtifactProject | undefined> {
    const packageJson = readPackageJson(packagePath);
    const manifest = parseSettingsManifest(packagePath, packageJson);
    if (manifest === undefined) return undefined;

    const packageRoot = dirname(packagePath);
    const definitionPath = resolveInside(packageRoot, manifest.definition);
    const schemaPath = resolveInside(packageRoot, manifest.schema);
    const readmePath = resolveInside(packageRoot, manifest.readme);
    if (definitionPath === undefined || schemaPath === undefined || readmePath === undefined) {
        throw manifestError(
            packagePath,
            "definition, schema, and readme paths must stay inside the package",
        );
    }

    const definition = await importDefinition(definitionPath);
    const targets: SettingsArtifactTargets =
        manifest.globalPath === undefined
            ? { schemaPath, readmePath }
            : { schemaPath, readmePath, globalPath: manifest.globalPath };
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
