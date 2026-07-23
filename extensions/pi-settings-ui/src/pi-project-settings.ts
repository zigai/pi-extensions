import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const jsonObjectBoundary = Type.Record(Type.String(), Type.Unknown());

type JsonObject = Static<typeof jsonObjectBoundary>;

export type PiProjectSettingsSnapshot =
    | {
          readonly _tag: "BlockedProjectSettings";
          readonly path: string;
          readonly message: string;
      }
    | {
          readonly _tag: "ReadyProjectSettings";
          readonly path: string;
          readonly sourceText: string | undefined;
          readonly document: JsonObject;
      }
    | {
          readonly _tag: "UnavailableProjectSettings";
          readonly path: string;
          readonly message: string;
      };

export type SavePiProjectSettingOutcome =
    | {
          readonly _tag: "ProjectSettingSaved";
          readonly snapshot: PiProjectSettingsSnapshot;
      }
    | { readonly _tag: "ProjectSettingSaveFailed"; readonly message: string };

function errorCode(cause: unknown): string | undefined {
    if (cause instanceof Error && "code" in cause && typeof cause.code === "string") {
        return cause.code;
    }
    return undefined;
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (cause: unknown) {
        if (errorCode(cause) === "ENOENT") return undefined;
        throw cause;
    }
}

async function existingMode(path: string): Promise<number> {
    try {
        return (await stat(path)).mode & 0o777;
    } catch (cause: unknown) {
        if (errorCode(cause) === "ENOENT") return 0o600;
        throw cause;
    }
}

async function writeAtomically(path: string, content: string): Promise<void> {
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await mkdir(directory, { recursive: true });
        const mode = await existingMode(path);
        await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
        await chmod(temporaryPath, mode);
        await rename(temporaryPath, path);
    } finally {
        try {
            await rm(temporaryPath, { force: true });
        } catch {
            // Cleanup must not hide the persistence result.
        }
    }
}

function decodeDocument(sourceText: string): JsonObject | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(sourceText);
    } catch {
        return undefined;
    }
    if (!Value.Check(jsonObjectBoundary, parsed)) return undefined;
    return Value.Decode(jsonObjectBoundary, parsed);
}

function setNestedValue(document: JsonObject, path: readonly string[], value: unknown): JsonObject {
    const updated = structuredClone(document);
    let current = updated;
    for (const segment of path.slice(0, -1)) {
        const existing = current[segment];
        const child = Value.Check(jsonObjectBoundary, existing)
            ? Value.Decode(jsonObjectBoundary, existing)
            : {};
        current[segment] = child;
        current = child;
    }
    const leaf = path.at(-1);
    if (leaf !== undefined) current[leaf] = structuredClone(value);
    return updated;
}

/** Load Pi's trusted project settings without creating or repairing user files. */
export async function loadPiProjectSettings(
    cwd: string,
    projectTrusted: boolean,
): Promise<PiProjectSettingsSnapshot> {
    const path = join(cwd, CONFIG_DIR_NAME, "settings.json");
    if (!projectTrusted) {
        return {
            _tag: "UnavailableProjectSettings",
            path,
            message: "Project settings are unavailable until this project is trusted.",
        };
    }
    let sourceText: string | undefined;
    try {
        sourceText = await readTextIfPresent(path);
    } catch {
        return {
            _tag: "BlockedProjectSettings",
            path,
            message: "Project settings could not be read.",
        };
    }
    if (sourceText === undefined) {
        return { _tag: "ReadyProjectSettings", path, sourceText, document: {} };
    }
    const document = decodeDocument(sourceText);
    if (document === undefined) {
        return {
            _tag: "BlockedProjectSettings",
            path,
            message: "Project settings contain malformed JSON or are not a JSON object.",
        };
    }
    return { _tag: "ReadyProjectSettings", path, sourceText, document };
}

/** Atomically update one Pi project setting while preserving unrelated fields. */
export async function savePiProjectSetting(
    snapshot: PiProjectSettingsSnapshot,
    path: readonly string[],
    value: unknown,
): Promise<SavePiProjectSettingOutcome> {
    if (snapshot._tag !== "ReadyProjectSettings") {
        return { _tag: "ProjectSettingSaveFailed", message: snapshot.message };
    }
    return withFileMutationQueue(snapshot.path, async () => {
        try {
            const currentText = await readTextIfPresent(snapshot.path);
            if (currentText !== snapshot.sourceText) {
                return {
                    _tag: "ProjectSettingSaveFailed",
                    message:
                        "Project settings changed while the editor was open. Reopen /settings.",
                };
            }
            const document = setNestedValue(snapshot.document, path, value);
            const content = `${JSON.stringify(document, undefined, 2)}\n`;
            if (content !== currentText) await writeAtomically(snapshot.path, content);
            return {
                _tag: "ProjectSettingSaved",
                snapshot: {
                    _tag: "ReadyProjectSettings",
                    path: snapshot.path,
                    sourceText: content,
                    document,
                },
            };
        } catch {
            return {
                _tag: "ProjectSettingSaveFailed",
                message: "Project settings could not be saved.",
            };
        }
    });
}
