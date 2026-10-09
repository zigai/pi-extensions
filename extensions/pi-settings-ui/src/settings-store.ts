import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import {
    CONFIG_DIR_NAME,
    getAgentDir,
    withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

import { type JsonObject } from "./json-value.ts";
import {
    type ExtensionSettingsSchema,
    parseExtensionSettingsSchema,
    parseSettingsDocument,
} from "./settings-schema.ts";

const EXTENSION_SETTINGS_DIRECTORY = "extension-settings";
const EXTENSION_SETTINGS_SCHEMA_DIRECTORY = "schemas";

export type SettingsScope = "global" | "project";

export type SettingsLocation = {
    readonly globalConfigPath: (id: string) => string;
    readonly projectConfigPath: (id: string) => string;
    readonly schemaDirectory: string;
};

export type SettingsCatalogDiagnostic = {
    readonly path: string;
    readonly message: string;
};

export type SettingsLayerSnapshot =
    | {
          readonly _tag: "BlockedLayer";
          readonly path: string;
          readonly message: string;
          readonly issues: readonly string[];
      }
    | {
          readonly _tag: "ReadyLayer";
          readonly path: string;
          readonly sourceText: string | undefined;
          readonly document: JsonObject;
      }
    | {
          readonly _tag: "UnavailableLayer";
          readonly path: string;
          readonly message: string;
      };

export type CatalogExtensionSettings = {
    readonly schema: ExtensionSettingsSchema;
    readonly global: SettingsLayerSnapshot;
    readonly project: SettingsLayerSnapshot;
};

export type SettingsCatalog = {
    readonly extensions: readonly CatalogExtensionSettings[];
    readonly diagnostics: readonly SettingsCatalogDiagnostic[];
};

export type LoadSettingsCatalogOptions = {
    readonly projectTrusted: boolean;
};

export type SaveSettingsLayerRequest = {
    readonly extensionId: string;
    readonly scope: SettingsScope;
    readonly schemaPath: string;
    readonly expectedSchemaText: string;
    readonly configPath: string;
    readonly expectedConfigText: string | undefined;
    readonly content: string;
};

export type SaveSettingsLayerOutcome =
    | {
          readonly _tag: "SaveConflict";
          readonly extensionId: string;
          readonly scope: SettingsScope;
          readonly message: string;
      }
    | {
          readonly _tag: "SaveFailed";
          readonly extensionId: string;
          readonly scope: SettingsScope;
          readonly message: string;
      }
    | {
          readonly _tag: "SavedLayer";
          readonly extensionId: string;
          readonly scope: SettingsScope;
          readonly content: string;
          readonly changed: boolean;
      };

function hasStringCode(cause: unknown): cause is Error & { readonly code: string } {
    return cause instanceof Error && "code" in cause && typeof cause.code === "string";
}

function errorCode(cause: unknown): string | undefined {
    return hasStringCode(cause) ? cause.code : undefined;
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (cause: unknown) {
        if (errorCode(cause) === "ENOENT") return undefined;
        throw cause;
    }
}

function initialDocument(
    extensionSchema: ExtensionSettingsSchema,
    scope: SettingsScope,
): JsonObject {
    return scope === "global" ? { $schema: extensionSchema.schemaReference } : {};
}

async function loadSettingsLayer(
    extensionSchema: ExtensionSettingsSchema,
    path: string,
    scope: SettingsScope,
): Promise<SettingsLayerSnapshot> {
    let sourceText: string | undefined;
    try {
        sourceText = await readTextIfPresent(path);
    } catch {
        return {
            _tag: "BlockedLayer",
            path,
            message: `${scope === "global" ? "Global" : "Project"} settings could not be read.`,
            issues: [],
        };
    }

    if (sourceText === undefined) {
        return {
            _tag: "ReadyLayer",
            path,
            sourceText,
            document: initialDocument(extensionSchema, scope),
        };
    }

    const parsed = parseSettingsDocument(extensionSchema, sourceText);
    if (parsed._tag === "InvalidDocument") {
        return {
            _tag: "BlockedLayer",
            path,
            message: parsed.message,
            issues: parsed.issues,
        };
    }

    return {
        _tag: "ReadyLayer",
        path,
        sourceText,
        document: parsed.document,
    };
}

/** Build the standard global and trusted-project paths used by Pi extension settings. */
export function createPiSettingsLocation(cwd: string): SettingsLocation {
    const settingsDirectory = join(getAgentDir(), EXTENSION_SETTINGS_DIRECTORY);
    const projectSettingsDirectory = join(cwd, CONFIG_DIR_NAME, EXTENSION_SETTINGS_DIRECTORY);

    return {
        globalConfigPath: (id) => join(settingsDirectory, `${id}.json`),
        projectConfigPath: (id) => join(projectSettingsDirectory, `${id}.json`),
        schemaDirectory: join(settingsDirectory, EXTENSION_SETTINGS_SCHEMA_DIRECTORY),
    };
}

/** Discover generated schemas and load editable settings layers without mutating the filesystem. */
export async function loadSettingsCatalog(
    location: SettingsLocation,
    options: LoadSettingsCatalogOptions,
): Promise<SettingsCatalog> {
    let schemaNames: readonly string[];
    try {
        schemaNames = (await readdir(location.schemaDirectory))
            .filter((name) => name.endsWith(".schema.json"))
            .sort();
    } catch (cause: unknown) {
        if (errorCode(cause) === "ENOENT") return { extensions: [], diagnostics: [] };

        return {
            extensions: [],
            diagnostics: [
                {
                    path: location.schemaDirectory,
                    message: "The installed extension schema directory could not be read.",
                },
            ],
        };
    }

    const extensions: CatalogExtensionSettings[] = [];
    const diagnostics: SettingsCatalogDiagnostic[] = [];
    for (const schemaName of schemaNames) {
        const id = schemaName.slice(0, -".schema.json".length);
        const schemaPath = join(location.schemaDirectory, schemaName);
        let schemaText: string;
        try {
            schemaText = await readFile(schemaPath, "utf8");
        } catch {
            diagnostics.push({
                path: schemaPath,
                message: "The extension schema could not be read.",
            });
            continue;
        }

        const parsedSchema = parseExtensionSettingsSchema(id, schemaPath, schemaText);
        if (parsedSchema._tag === "InvalidSchema") {
            diagnostics.push({ path: schemaPath, message: parsedSchema.message });
            continue;
        }

        const globalPath = location.globalConfigPath(id);
        const projectPath = location.projectConfigPath(id);
        const [global, project] = await Promise.all([
            loadSettingsLayer(parsedSchema.schema, globalPath, "global"),
            options.projectTrusted
                ? loadSettingsLayer(parsedSchema.schema, projectPath, "project")
                : Promise.resolve<SettingsLayerSnapshot>({
                      _tag: "UnavailableLayer",
                      path: projectPath,
                      message: "Project settings are unavailable until this project is trusted.",
                  }),
        ]);

        extensions.push({ schema: parsedSchema.schema, global, project });
    }

    extensions.sort((left, right) => left.schema.title.localeCompare(right.schema.title));

    return { extensions, diagnostics };
}

async function existingMode(path: string): Promise<number> {
    try {
        const file = await stat(path);
        return file.mode & 0o777;
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
        await writeFile(temporaryPath, content, {
            encoding: "utf8",
            flag: "wx",
            mode,
        });
        await chmod(temporaryPath, mode);
        await rename(temporaryPath, path);
    } finally {
        try {
            await rm(temporaryPath, { force: true });
        } catch {
            // Cleanup must not mask the persistence outcome.
        }
    }
}

async function saveSettingsLayer(
    request: SaveSettingsLayerRequest,
): Promise<SaveSettingsLayerOutcome> {
    return withFileMutationQueue(request.configPath, async () => {
        let release: (() => Promise<void>) | undefined;
        let lockCompromised = false;
        try {
            await mkdir(dirname(request.configPath), { recursive: true });
            release = await lockfile.lock(request.configPath, {
                realpath: false,
                retries: {
                    retries: 20,
                    factor: 1.25,
                    minTimeout: 10,
                    maxTimeout: 100,
                    randomize: true,
                },
                onCompromised: () => {
                    lockCompromised = true;
                },
            });

            const currentSchemaText = await readTextIfPresent(request.schemaPath);
            if (currentSchemaText !== request.expectedSchemaText) {
                return {
                    _tag: "SaveConflict",
                    extensionId: request.extensionId,
                    scope: request.scope,
                    message:
                        "The extension schema changed while the editor was open. Reopen /settings.",
                };
            }

            const currentConfigText = await readTextIfPresent(request.configPath);
            if (currentConfigText !== request.expectedConfigText) {
                return {
                    _tag: "SaveConflict",
                    extensionId: request.extensionId,
                    scope: request.scope,
                    message:
                        "The settings file changed while the editor was open. Reopen /settings.",
                };
            }

            if (currentConfigText === request.content) {
                return {
                    _tag: "SavedLayer",
                    extensionId: request.extensionId,
                    scope: request.scope,
                    content: request.content,
                    changed: false,
                };
            }

            if (lockCompromised) {
                return {
                    _tag: "SaveFailed",
                    extensionId: request.extensionId,
                    scope: request.scope,
                    message: "The settings lock was lost before the file could be saved.",
                };
            }

            await writeAtomically(request.configPath, request.content);

            return {
                _tag: "SavedLayer",
                extensionId: request.extensionId,
                scope: request.scope,
                content: request.content,
                changed: true,
            };
        } catch {
            return {
                _tag: "SaveFailed",
                extensionId: request.extensionId,
                scope: request.scope,
                message: "The settings file could not be saved.",
            };
        } finally {
            try {
                await release?.();
            } catch {
                // A completed write or conflict result is more useful than a cleanup failure.
            }
        }
    });
}

/** Persist validated layer documents with schema and config conflict detection. */
export async function saveSettingsLayers(
    requests: readonly SaveSettingsLayerRequest[],
): Promise<readonly SaveSettingsLayerOutcome[]> {
    return Promise.all(requests.map(saveSettingsLayer));
}
