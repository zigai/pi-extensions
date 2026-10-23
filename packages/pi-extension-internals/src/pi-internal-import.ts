import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { reportExtensionDiagnostic } from "./diagnostics.ts";

export type PiInternalModuleLoadOptions<T> = {
    readonly scope: string;
    readonly feature: string;
    readonly parse: (module: unknown) => T | undefined;
};

function isCodingAgentPackageDirectory(directory: string): boolean {
    return (
        basename(directory) === "pi-coding-agent" &&
        basename(dirname(directory)) === "@earendil-works"
    );
}

function findEntrypointPackageDirectory(): string | undefined {
    if (process.env.PI_CODING_AGENT !== "true") return undefined;

    const entrypoint = process.argv.at(1);
    if (entrypoint === undefined || entrypoint.length === 0) return undefined;

    let directory = dirname(realpathSync(entrypoint));
    for (;;) {
        if (
            isCodingAgentPackageDirectory(directory) &&
            existsSync(join(directory, "package.json"))
        ) {
            return directory;
        }

        const parent = dirname(directory);
        if (parent === directory) return undefined;

        directory = parent;
    }
}

async function resolveRunningPiPackageDirectory(): Promise<string> {
    // A managed extension can have no Pi peer beside it. Prefer the explicit host
    // path or the running CLI before trying package resolution from this library.
    const configuredDirectory = process.env.PI_PACKAGE_DIR;
    if (configuredDirectory !== undefined && configuredDirectory.length > 0) {
        return resolve(configuredDirectory);
    }

    const runningDirectory = findEntrypointPackageDirectory();
    if (runningDirectory !== undefined) return runningDirectory;

    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    return getPackageDir();
}

const ENTRYPOINT_IMPORT_PATTERN = /(?:\bfrom\s*|(?:^|;)\s*import\s*)["'](\.\/[^"']+\.js)["']/g;

async function resolvePiEntrypointModuleUrls(): Promise<string[]> {
    if (process.env.PI_CODING_AGENT !== "true") return [];

    const entrypoint = process.argv.at(1);
    if (entrypoint === undefined || entrypoint.length === 0 || !existsSync(entrypoint)) return [];

    const packageDirectory = resolve(await resolveRunningPiPackageDirectory());
    const entrypointPath = realpathSync(entrypoint);
    const entrypointWithinPackage = relative(packageDirectory, entrypointPath);
    if (
        entrypointWithinPackage === ".." ||
        entrypointWithinPackage.startsWith(`..${sep}`) ||
        isAbsolute(entrypointWithinPackage)
    ) {
        return [];
    }

    const source = readFileSync(entrypointPath, "utf8");
    const moduleUrls: string[] = [];
    for (const match of source.matchAll(ENTRYPOINT_IMPORT_PATTERN)) {
        const specifier = match.at(1);
        if (specifier === undefined) continue;

        const modulePath = resolve(dirname(entrypointPath), specifier);
        const moduleWithinPackage = relative(packageDirectory, modulePath);
        if (
            moduleWithinPackage === ".." ||
            moduleWithinPackage.startsWith(`..${sep}`) ||
            isAbsolute(moduleWithinPackage)
        ) {
            continue;
        }

        moduleUrls.push(pathToFileURL(modulePath).href);
    }

    return [...new Set(moduleUrls)];
}

/** Resolves a path relative to the running Pi coding-agent distribution. */
async function resolvePiInternalModuleUrl(relativePath: string): Promise<string> {
    const codingAgentDirectory = resolve(await resolveRunningPiPackageDirectory(), "dist");

    if (relativePath.length === 0 || isAbsolute(relativePath)) {
        throw new TypeError("Pi internal module path must be relative to the coding-agent package");
    }

    const modulePath = resolve(codingAgentDirectory, relativePath);
    const pathWithinPackage = relative(codingAgentDirectory, modulePath);
    if (
        pathWithinPackage.length === 0 ||
        pathWithinPackage === ".." ||
        pathWithinPackage.startsWith(`..${sep}`) ||
        isAbsolute(pathWithinPackage)
    ) {
        throw new TypeError("Pi internal module path escapes the coding-agent package");
    }

    return pathToFileURL(modulePath).href;
}

/** Reports a disabled best-effort patch without interrupting extension startup. */
export function warnPiInternalPatchUnavailable(
    scope: string,
    feature: string,
    cause?: unknown,
): void {
    let suffix = "";
    if (cause instanceof Error && cause.message.length > 0) {
        suffix = `: ${cause.message}`;
    }

    reportExtensionDiagnostic(
        `[${scope}] ${feature} unavailable; Pi internals may have changed${suffix}`,
    );
}

async function parseImportedModule<T>(
    moduleUrl: string,
    options: PiInternalModuleLoadOptions<T>,
): Promise<T | undefined> {
    const imported: unknown = await import(moduleUrl);
    return options.parse(imported);
}

/** Loads and parses an unsupported Pi internal module, degrading to undefined on failure. */
export async function loadPiInternalModule<T>(
    relativePath: string,
    options: PiInternalModuleLoadOptions<T>,
): Promise<T | undefined> {
    try {
        const parsed = await parseImportedModule(
            await resolvePiInternalModuleUrl(relativePath),
            options,
        );
        if (parsed !== undefined) return parsed;

        warnPiInternalPatchUnavailable(options.scope, options.feature);

        return undefined;
    } catch (cause: unknown) {
        warnPiInternalPatchUnavailable(options.scope, options.feature, cause);
        return undefined;
    }
}

/** Loads a runtime-owned export from Pi's bundle before its unbundled fallback module. */
export async function loadPiRuntimeModule<T>(
    fallbackRelativePath: string,
    options: PiInternalModuleLoadOptions<T>,
): Promise<T | undefined> {
    try {
        for (const moduleUrl of await resolvePiEntrypointModuleUrls()) {
            const parsed = await parseImportedModule(moduleUrl, options);
            if (parsed !== undefined) return parsed;
        }

        const fallback = await parseImportedModule(
            await resolvePiInternalModuleUrl(fallbackRelativePath),
            options,
        );
        if (fallback !== undefined) return fallback;

        warnPiInternalPatchUnavailable(options.scope, options.feature);

        return undefined;
    } catch (cause: unknown) {
        warnPiInternalPatchUnavailable(options.scope, options.feature, cause);
        return undefined;
    }
}
