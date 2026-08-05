import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import lockfile from "proper-lockfile";
import type { TObject, TSchema } from "typebox";
import { Value } from "typebox/value";

import type { ExtensionSettingsDefinition, ExtensionSettingsLayer } from "./definition.ts";
import { readTextIfPresentAsync, writeTextAtomicallyAsync } from "./file-system.ts";
import { cloneJson, formatJson, isJsonObject, type JsonObject } from "./json-value.ts";
import type { ExtensionSettingsPaths } from "./paths.ts";
import { createSettingsDocument, createSettingsFileSchema } from "./schema-document.ts";
import {
    applySettingsLayer,
    parseSettingsLayer,
    settingsValidationIssues,
    type SettingsDiagnostic,
    type SettingsScope,
    type SettingsValidationIssue,
} from "./settings-layer.ts";
import { mergeSettings } from "./settings-merge.ts";
import { createSettingsRevision, type PiSettingsRevision } from "./settings-revision.ts";

export type PiSettingsUpdateScope = "global" | "project";

export type PiSettingsUpdateIssue = SettingsValidationIssue;

export type UpdatePiExtensionSettingsOptions<Schema extends TObject> = {
    /** Settings layer to update. Project updates require a trusted project. */
    readonly scope: PiSettingsUpdateScope;
    /** Reject the update if the relevant sources no longer match this loader revision. */
    readonly expectedRevision?: PiSettingsRevision;
    /**
     * Produce the next encoded settings layer from the latest valid layer.
     *
     * The callback is invoked once, synchronously, while the settings transaction is locked. It may
     * return a copy or mutate and return the supplied clone. Throwing an `Error` aborts the
     * transaction and rejects `updatePiExtensionSettings` with the same error.
     */
    readonly update: (current: ExtensionSettingsLayer<Schema>) => ExtensionSettingsLayer<Schema>;
};

export type UpdatePiExtensionSettingsResult =
    | {
          readonly status: "updated" | "unchanged";
          readonly revision: PiSettingsRevision;
      }
    | {
          readonly status: "conflict";
          readonly reason: "schema-changed" | "settings-changed";
          readonly message: string;
      }
    | {
          readonly status: "blocked";
          readonly reason: "project-untrusted";
          readonly message: string;
      }
    | {
          readonly status: "invalid-existing";
          readonly message: string;
          readonly diagnostics: readonly SettingsDiagnostic[];
      }
    | {
          readonly status: "invalid-update";
          readonly message: string;
          readonly issues: readonly PiSettingsUpdateIssue[];
      }
    | {
          readonly status: "failed";
          readonly message: string;
      };

export type SettingsTransactionPaths = {
    readonly global: ExtensionSettingsPaths;
    readonly project: ExtensionSettingsPaths;
};

export type SettingsTransactionOptions<Schema extends TObject> =
    UpdatePiExtensionSettingsOptions<Schema> & {
        readonly paths: SettingsTransactionPaths;
        readonly projectTrusted: boolean;
    };

type ExistingLayerResult =
    | {
          readonly status: "valid";
          readonly settings: JsonObject;
          readonly schemaReference: string | undefined;
      }
    | {
          readonly status: "invalid";
          readonly diagnostics: readonly SettingsDiagnostic[];
      };

class SettingsPersistenceError extends Error {
    constructor(cause: unknown) {
        super("The settings transaction could not access persistent storage.", { cause });
    }
}

async function persistently<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
        return await operation();
    } catch (cause: unknown) {
        throw new SettingsPersistenceError(cause);
    }
}

function typedSettingsLayer<Schema extends TObject>(
    schema: TSchema,
    value: unknown,
): value is ExtensionSettingsLayer<Schema> {
    return isJsonObject(value) && !("$schema" in value) && Value.Check(schema, value);
}

function parseExistingLayer(
    path: string,
    scope: SettingsScope,
    text: string | undefined,
    layerSchema: TSchema,
): ExistingLayerResult {
    if (text === undefined) {
        return {
            status: "valid",
            settings: {},
            schemaReference: undefined,
        };
    }

    const parsedLayer = parseSettingsLayer(path, scope, text, layerSchema);
    if (parsedLayer.settings === undefined) {
        return { status: "invalid", diagnostics: parsedLayer.diagnostics };
    }
    return {
        status: "valid",
        settings: parsedLayer.settings,
        schemaReference: parsedLayer.schemaReference,
    };
}

function invalidExisting(
    diagnostics: readonly SettingsDiagnostic[],
): UpdatePiExtensionSettingsResult {
    return {
        status: "invalid-existing",
        message: diagnostics[0]?.message ?? "The existing settings are invalid.",
        diagnostics,
    };
}

function invalidUpdate(
    message: string,
    issues: readonly PiSettingsUpdateIssue[],
): UpdatePiExtensionSettingsResult {
    return { status: "invalid-update", message, issues };
}

async function withInterprocessLocks<Result>(
    paths: readonly string[],
    operation: () => Promise<Result>,
    index = 0,
): Promise<Result> {
    const path = paths[index];
    if (path === undefined) return operation();

    await persistently(() => mkdir(dirname(path), { recursive: true }));
    const release = await persistently(() =>
        lockfile.lock(path, {
            realpath: false,
            retries: {
                retries: 20,
                factor: 1.25,
                minTimeout: 10,
                maxTimeout: 100,
                randomize: true,
            },
        }),
    );
    try {
        return await withInterprocessLocks(paths, operation, index + 1);
    } finally {
        await persistently(release);
    }
}

async function runSettingsTransaction<Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    options: SettingsTransactionOptions<Schema>,
): Promise<UpdatePiExtensionSettingsResult> {
    const layerSchema = createSettingsFileSchema(definition);
    const expectedSchema = formatJson(layerSchema);
    const installedSchema = await persistently(() =>
        readTextIfPresentAsync(options.paths.global.schemaPath),
    );
    if (installedSchema !== expectedSchema) {
        return {
            status: "conflict",
            reason: "schema-changed",
            message: "The installed settings schema changed; reload the extension before saving.",
        };
    }

    const globalText = await persistently(() =>
        readTextIfPresentAsync(options.paths.global.configPath),
    );
    const projectText =
        options.scope === "project"
            ? await persistently(() => readTextIfPresentAsync(options.paths.project.configPath))
            : undefined;
    const revision =
        options.scope === "global"
            ? createSettingsRevision(globalText)
            : createSettingsRevision(globalText, projectText);
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
        return {
            status: "conflict",
            reason: "settings-changed",
            message: "The settings changed after they were loaded; reload before saving.",
        };
    }

    const globalResult = parseExistingLayer(
        options.paths.global.configPath,
        "global",
        globalText,
        layerSchema,
    );
    if (globalResult.status === "invalid") return invalidExisting(globalResult.diagnostics);

    const globalApplied = applySettingsLayer(
        definition.schema,
        definition.defaultSettings,
        globalResult,
        options.paths.global.configPath,
        "global",
    );
    if (globalApplied.diagnostic !== undefined) {
        return invalidExisting([globalApplied.diagnostic]);
    }

    let currentLayer = globalResult;
    let validationBase = definition.defaultSettings;
    if (options.scope === "project") {
        const projectResult = parseExistingLayer(
            options.paths.project.configPath,
            "project",
            projectText,
            layerSchema,
        );
        if (projectResult.status === "invalid") return invalidExisting(projectResult.diagnostics);

        const projectApplied = applySettingsLayer(
            definition.schema,
            globalApplied.settings,
            projectResult,
            options.paths.project.configPath,
            "project",
        );
        if (projectApplied.diagnostic !== undefined) {
            return invalidExisting([projectApplied.diagnostic]);
        }
        currentLayer = projectResult;
        validationBase = globalApplied.settings;
    }

    const currentForUpdate = cloneJson(currentLayer.settings);
    if (!typedSettingsLayer<Schema>(layerSchema, currentForUpdate)) {
        throw new TypeError("A validated settings layer unexpectedly failed its encoded schema.");
    }

    const candidate: unknown = options.update(currentForUpdate);
    if (!isJsonObject(candidate)) {
        return invalidUpdate("The settings updater must return a JSON object.", [
            { path: "/", message: "Expected a JSON object" },
        ]);
    }
    if ("$schema" in candidate) {
        return invalidUpdate("The settings updater cannot modify $schema metadata.", [
            { path: "/$schema", message: "$schema is reserved for editor metadata" },
        ]);
    }
    if (!Value.Check(layerSchema, candidate)) {
        return invalidUpdate(
            "The settings update does not match the extension schema.",
            settingsValidationIssues(layerSchema, candidate),
        );
    }

    const nextLayer = cloneJson(candidate);
    const resolved = mergeSettings(validationBase, nextLayer);
    if (!Value.Check(definition.schema, resolved)) {
        return invalidUpdate(
            "The settings update conflicts with the resolved configuration.",
            settingsValidationIssues(definition.schema, resolved),
        );
    }
    try {
        Value.Decode(Value.Clone(definition.schema), resolved);
    } catch {
        return invalidUpdate("The settings update could not be decoded.", [
            { path: "/", message: "The resolved settings codec rejected the update" },
        ]);
    }

    if (isDeepStrictEqual(currentLayer.settings, nextLayer)) {
        return { status: "unchanged", revision };
    }

    const targetPaths = options.scope === "global" ? options.paths.global : options.paths.project;
    const schemaReference =
        currentLayer.schemaReference ??
        (options.scope === "global" ? targetPaths.schemaReference : definition.schemaId);
    const content = formatJson(createSettingsDocument(definition.id, nextLayer, schemaReference));
    await persistently(() => writeTextAtomicallyAsync(targetPaths.configPath, content));
    const nextRevision =
        options.scope === "global"
            ? createSettingsRevision(content)
            : createSettingsRevision(globalText, content);
    return { status: "updated", revision: nextRevision };
}

export async function updateSettingsTransaction<Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
    options: SettingsTransactionOptions<Schema>,
): Promise<UpdatePiExtensionSettingsResult> {
    if (options.scope === "project" && !options.projectTrusted) {
        return {
            status: "blocked",
            reason: "project-untrusted",
            message: "Project settings can only be updated for a trusted project.",
        };
    }

    const lockPaths =
        options.scope === "global"
            ? [options.paths.global.configPath]
            : [options.paths.global.configPath, options.paths.project.configPath].sort();
    try {
        return await withInterprocessLocks(lockPaths, () =>
            runSettingsTransaction(definition, options),
        );
    } catch (cause: unknown) {
        if (cause instanceof SettingsPersistenceError) {
            return {
                status: "failed",
                message: `The ${options.scope} settings transaction failed.`,
            };
        }
        if (cause instanceof Error) throw cause;
        throw new Error("The settings transaction threw a non-Error value.", { cause });
    }
}
