var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { glob } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Result } from "better-result";
import { isExtensionSettingsDefinition } from "./definition.js";
import { DefinitionModuleInvalid, ProjectManifestInvalid, } from "./failures.js";
import { readTextIfPresent } from "./file-system.js";
import { isJsonObject, parseJson } from "./json-value.js";
export const PACKAGE_MANIFEST_KEY = "piExtensionSettings";
function stringProperty(object, key) {
    const value = object[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function parseSettingsManifest(packagePath, packageJson) {
    const raw = packageJson[PACKAGE_MANIFEST_KEY];
    if (raw === undefined)
        return Result.ok(undefined);
    if (!isJsonObject(raw)) {
        return Result.err(new ProjectManifestInvalid({
            path: packagePath,
            reason: `${PACKAGE_MANIFEST_KEY} must be an object`,
        }));
    }
    const supported = new Set(["definition", "schema", "readme", "globalPath"]);
    const unknownKeys = Object.keys(raw).filter((key) => !supported.has(key));
    if (unknownKeys.length > 0) {
        return Result.err(new ProjectManifestInvalid({
            path: packagePath,
            reason: `unknown keys: ${unknownKeys.join(", ")}`,
        }));
    }
    const definition = stringProperty(raw, "definition");
    if (definition === undefined) {
        return Result.err(new ProjectManifestInvalid({
            path: packagePath,
            reason: "definition must be a non-empty relative path",
        }));
    }
    const schema = stringProperty(raw, "schema") ?? "config.schema.json";
    const readme = stringProperty(raw, "readme") ?? "README.md";
    const globalPath = stringProperty(raw, "globalPath");
    return Result.ok(globalPath === undefined
        ? { definition, schema, readme }
        : { definition, schema, readme, globalPath });
}
function resolveInside(packageRoot, configuredPath) {
    if (isAbsolute(configuredPath))
        return undefined;
    const resolved = resolve(packageRoot, configuredPath);
    const relativePath = relative(packageRoot, resolved);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
        return resolved;
    }
    return undefined;
}
function workspacePatterns(packageJson) {
    const workspaces = packageJson.workspaces;
    if (Array.isArray(workspaces)) {
        return workspaces.filter((value) => typeof value === "string");
    }
    if (!isJsonObject(workspaces) || !Array.isArray(workspaces.packages))
        return [];
    return workspaces.packages.filter((value) => typeof value === "string");
}
async function readPackageJson(path) {
    const content = await readTextIfPresent(path);
    if (Result.isError(content))
        return content;
    if (content.value === undefined) {
        return Result.err(new ProjectManifestInvalid({ path, reason: "file does not exist" }));
    }
    const parsed = parseJson(content.value);
    if (!isJsonObject(parsed)) {
        return Result.err(new ProjectManifestInvalid({ path, reason: "file is not valid JSON" }));
    }
    return Result.ok(parsed);
}
async function packageJsonPaths(root) {
    const rootPackagePath = resolve(root, "package.json");
    const rootPackage = await readPackageJson(rootPackagePath);
    if (Result.isError(rootPackage))
        return rootPackage;
    const paths = new Set([rootPackagePath]);
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
function isObjectWithDefault(value) {
    return value !== null && typeof value === "object" && "default" in value;
}
async function importDefinition(path) {
    let imported;
    try {
        imported = await import(__rewriteRelativeImportExtension(pathToFileURL(path).href));
    }
    catch (cause) {
        return Result.err(new DefinitionModuleInvalid({
            path,
            reason: "module could not be imported",
            cause,
        }));
    }
    if (!isObjectWithDefault(imported) || !isExtensionSettingsDefinition(imported.default)) {
        return Result.err(new DefinitionModuleInvalid({
            path,
            reason: "default export must be created by defineExtensionSettings",
        }));
    }
    return Result.ok(imported.default);
}
async function loadProject(packagePath) {
    const packageJson = await readPackageJson(packagePath);
    if (Result.isError(packageJson))
        return packageJson;
    const manifest = parseSettingsManifest(packagePath, packageJson.value);
    if (Result.isError(manifest))
        return manifest;
    if (manifest.value === undefined)
        return Result.ok(undefined);
    const packageRoot = dirname(packagePath);
    const definitionPath = resolveInside(packageRoot, manifest.value.definition);
    const schemaPath = resolveInside(packageRoot, manifest.value.schema);
    const readmePath = resolveInside(packageRoot, manifest.value.readme);
    if (definitionPath === undefined || schemaPath === undefined || readmePath === undefined) {
        return Result.err(new ProjectManifestInvalid({
            path: packagePath,
            reason: "definition, schema, and readme paths must stay inside the package",
        }));
    }
    const definition = await importDefinition(definitionPath);
    if (Result.isError(definition))
        return definition;
    const targets = manifest.value.globalPath === undefined
        ? { schemaPath, readmePath }
        : { schemaPath, readmePath, globalPath: manifest.value.globalPath };
    return Result.ok({ packageRoot, definition: definition.value, targets });
}
/** Discover configured standalone packages and npm workspace packages. */
export async function discoverSettingsProjects(root) {
    const paths = await packageJsonPaths(root);
    if (Result.isError(paths))
        return paths;
    const projects = [];
    for (const path of paths.value) {
        const project = await loadProject(path);
        if (Result.isError(project))
            return project;
        if (project.value !== undefined)
            projects.push(project.value);
    }
    return Result.ok(projects);
}
//# sourceMappingURL=projects.js.map