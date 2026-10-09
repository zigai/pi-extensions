import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";

import type { BundledLanguage } from "shiki";
import { syntaxLanguageFromPath } from "./language.ts";

const DEFAULT_MAX_PROJECT_LANGUAGE_SCAN_FILES = 10_000;
const DEFAULT_MAX_PROJECT_LANGUAGE_SCAN_DIRECTORIES = 2_000;
const DEFAULT_MAX_PROJECT_LANGUAGE_SCAN_MS = 150;

const IGNORED_PROJECT_LANGUAGE_DIRECTORIES = new Set([
    ".cache",
    ".git",
    ".hg",
    ".mypy_cache",
    ".next",
    ".nuxt",
    ".pytest_cache",
    ".ruff_cache",
    ".svn",
    ".tox",
    ".turbo",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "env",
    "node_modules",
    "out",
    "target",
    "vendor",
    "venv",
]);

export type ProjectLanguageDetectionStoppedReason = "directory-limit" | "file-limit" | "time-limit";

export type ProjectLanguageDetectionOptions = {
    readonly maxFiles?: number;
    readonly maxDirectories?: number;
    readonly maxMillis?: number;
};

export type ProjectLanguageDetectionResult = {
    readonly languages: readonly BundledLanguage[];
    readonly scannedFiles: number;
    readonly scannedDirectories: number;
    readonly readErrors: number;
    readonly stoppedReason?: ProjectLanguageDetectionStoppedReason;
};

/** Infers Shiki languages from project filenames without reading file contents. */
export function detectProjectSyntaxLanguages(
    cwd: string,
    options: ProjectLanguageDetectionOptions = {},
): ProjectLanguageDetectionResult {
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_PROJECT_LANGUAGE_SCAN_FILES;
    const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_PROJECT_LANGUAGE_SCAN_DIRECTORIES;
    const maxMillis = options.maxMillis ?? DEFAULT_MAX_PROJECT_LANGUAGE_SCAN_MS;
    const startedAtMs = Date.now();
    const languages = new Set<BundledLanguage>();
    const pendingDirectories = [path.resolve(cwd)];
    let scannedFiles = 0;
    let scannedDirectories = 0;
    let readErrors = 0;
    let stoppedReason: ProjectLanguageDetectionStoppedReason | undefined;

    for (let directoryIndex = 0; directoryIndex < pendingDirectories.length; directoryIndex += 1) {
        if (Date.now() - startedAtMs > maxMillis) {
            stoppedReason = "time-limit";
            break;
        }

        if (scannedDirectories >= maxDirectories) {
            stoppedReason = "directory-limit";
            break;
        }

        const directory = pendingDirectories[directoryIndex];
        if (directory === undefined) {
            break;
        }

        scannedDirectories += 1;

        let entries: Dirent[];
        try {
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            readErrors += 1;
            continue;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!shouldIgnoreProjectDirectory(entry.name)) {
                    pendingDirectories.push(path.join(directory, entry.name));
                }
                continue;
            }

            scannedFiles += 1;

            const language = syntaxLanguageFromPath(entry.name);
            if (language !== undefined && language !== "text") {
                languages.add(language);
            }

            if (scannedFiles >= maxFiles) {
                stoppedReason = "file-limit";
                break;
            }
        }

        if (stoppedReason !== undefined) {
            break;
        }
    }

    const result = {
        languages: [...languages].sort(),
        scannedFiles,
        scannedDirectories,
        readErrors,
    } satisfies ProjectLanguageDetectionResult;
    return stoppedReason === undefined ? result : { ...result, stoppedReason };
}

function shouldIgnoreProjectDirectory(name: string): boolean {
    return IGNORED_PROJECT_LANGUAGE_DIRECTORIES.has(name.toLowerCase());
}
