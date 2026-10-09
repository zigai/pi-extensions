import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MentionProjectSettings } from "./settings.ts";

export type ProjectDirectory = {
    name: string;
    path: string;
    root: string;
};

function compareProjectNames(left: string, right: string): number {
    return left.localeCompare(right, undefined, { sensitivity: "base" });
}

export type ProjectDirectoryLoadOptions = {
    readonly signal?: AbortSignal;
};

function expandHome(root: string): string {
    if (root === "~") return os.homedir();

    if (root.startsWith("~/") || root.startsWith("~\\")) {
        return path.join(os.homedir(), root.slice(2));
    }

    return root;
}

export function resolveProjectRoot(root: string, cwd: string): string {
    const expanded = expandHome(root.trim());
    if (path.isAbsolute(expanded)) return path.resolve(expanded);
    return path.resolve(cwd, expanded);
}

function uniqueResolvedRoots(roots: string[], cwd: string): string[] {
    const seen = new Set<string>();
    const resolved: string[] = [];

    for (const root of roots) {
        const directory = resolveProjectRoot(root, cwd);
        if (seen.has(directory)) continue;
        seen.add(directory);
        resolved.push(directory);
    }

    return resolved;
}

function isAborted(options?: ProjectDirectoryLoadOptions): boolean {
    return options?.signal?.aborted === true;
}

async function directoryEntryIsDirectory(
    root: string,
    entry: Dirent,
    options?: ProjectDirectoryLoadOptions,
): Promise<boolean> {
    if (isAborted(options)) return false;
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;

    try {
        const stats = await fs.stat(path.join(root, entry.name));

        if (isAborted(options)) return false;
        return stats.isDirectory();
    } catch {
        return false;
    }
}

async function isGitRepository(
    projectPath: string,
    options?: ProjectDirectoryLoadOptions,
): Promise<boolean> {
    if (isAborted(options)) return false;
    try {
        const stats = await fs.stat(path.join(projectPath, ".git"));

        if (isAborted(options)) return false;
        return stats.isDirectory() || stats.isFile();
    } catch {
        return false;
    }
}

async function directoryEntryMatchesSettings(
    root: string,
    entry: Dirent,
    settings: MentionProjectSettings,
    options?: ProjectDirectoryLoadOptions,
): Promise<boolean> {
    if (isAborted(options)) return false;
    if (!settings.includeDotFolders && entry.name.startsWith(".")) return false;
    if (!(await directoryEntryIsDirectory(root, entry, options))) return false;
    if (!settings.gitReposOnly) return true;
    return isGitRepository(path.join(root, entry.name), options);
}

async function listRootProjectDirectories(
    root: string,
    settings: MentionProjectSettings,
    options?: ProjectDirectoryLoadOptions,
): Promise<ProjectDirectory[]> {
    if (isAborted(options)) return [];

    let entries: Dirent[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }

    if (isAborted(options)) return [];

    const projects: ProjectDirectory[] = [];
    for (const entry of entries) {
        if (isAborted(options)) break;
        if (!(await directoryEntryMatchesSettings(root, entry, settings, options))) continue;

        const projectPath = path.join(root, entry.name);
        projects.push({ name: entry.name, path: projectPath, root });
    }

    projects.sort((left, right) => compareProjectNames(left.name, right.name));

    return projects;
}

export function uniqueProjectsByName(projects: ProjectDirectory[]): ProjectDirectory[] {
    const seen = new Set<string>();
    const unique: ProjectDirectory[] = [];

    for (const project of projects) {
        if (seen.has(project.name)) continue;
        seen.add(project.name);
        unique.push(project);
    }

    return unique;
}

export async function listProjectDirectories(
    settings: MentionProjectSettings,
    cwd: string,
    options?: ProjectDirectoryLoadOptions,
): Promise<ProjectDirectory[]> {
    if (isAborted(options)) return [];

    const projects: ProjectDirectory[] = [];
    for (const root of uniqueResolvedRoots(settings.roots, cwd)) {
        if (isAborted(options)) break;

        projects.push(...(await listRootProjectDirectories(root, settings, options)));
    }

    return uniqueProjectsByName(projects);
}
