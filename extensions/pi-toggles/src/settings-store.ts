import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { LoadedPiExtensionSettings, PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Compile } from "typebox/compile";
import { selectorKey } from "./capability.ts";
import {
    loadTogglesSettings,
    settingsDocumentSchema,
    settingsSchema,
    type ExtensionSettings,
    type PolicyDecision,
    type SettingsDocument,
} from "./settings.ts";

const GLOBAL_SCHEMA_REFERENCE = "./schemas/pi-toggles.schema.json";
const PROJECT_SCHEMA_REFERENCE =
    "https://raw.githubusercontent.com/zigai/pi-toggles/HEAD/config.schema.json";

const settingsDocumentValidator = Compile(settingsDocumentSchema);

export type SettingsSnapshot = {
    readonly loaded: LoadedPiExtensionSettings<typeof settingsSchema>;
    readonly resolved: ExtensionSettings;
    readonly globalDocument: SettingsDocument;
    readonly projectDocument: SettingsDocument;
    readonly diagnostics: readonly string[];
};

export type SettingsWriteResult =
    | { readonly status: "saved"; readonly snapshot: SettingsSnapshot }
    | { readonly status: "blocked"; readonly message: string }
    | { readonly status: "invalid"; readonly message: string }
    | { readonly status: "failed"; readonly message: string; readonly cause: unknown };

type PersistentScope = "global" | "project";

type SettingsPatch =
    | { readonly kind: "overrides"; readonly decisions: readonly PolicyDecision[] }
    | { readonly kind: "active-profile"; readonly profile: string | undefined }
    | {
          readonly kind: "policy";
          readonly decisions: readonly PolicyDecision[];
          readonly profile: string | undefined;
      }
    | { readonly kind: "reset-policy" };

function parseDocument(value: unknown):
    | { readonly status: "ok"; readonly document: SettingsDocument }
    | {
          readonly status: "invalid";
          readonly message: string;
      } {
    try {
        return { status: "ok", document: settingsDocumentValidator.Parse(value) };
    } catch (cause: unknown) {
        return {
            status: "invalid",
            message: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

function snapshotFromLoaded(
    loaded: LoadedPiExtensionSettings<typeof settingsSchema>,
): SettingsSnapshot {
    const globalResult = parseDocument(loaded.globalSettingsLayer ?? {});
    const projectResult = parseDocument(loaded.projectSettingsLayer ?? {});
    const diagnostics = loaded.diagnostics.map((diagnostic) => diagnostic.message);
    if (globalResult.status === "invalid") {
        diagnostics.push(`Global settings layer is invalid: ${globalResult.message}`);
    }
    if (projectResult.status === "invalid") {
        diagnostics.push(`Project settings layer is invalid: ${projectResult.message}`);
    }
    return {
        loaded,
        resolved: loaded.settings,
        globalDocument: globalResult.status === "ok" ? globalResult.document : {},
        projectDocument: projectResult.status === "ok" ? projectResult.document : {},
        diagnostics,
    };
}

function applyPatch(document: SettingsDocument, patch: SettingsPatch): SettingsDocument {
    if (patch.kind === "reset-policy") {
        const next = { ...document, overrides: [] };
        delete next.activeProfile;
        return next;
    }
    if (patch.kind === "active-profile" || patch.kind === "policy") {
        const next = { ...document };
        if (patch.profile === undefined) {
            delete next.activeProfile;
        } else {
            next.activeProfile = patch.profile;
        }
        if (patch.kind === "active-profile") {
            return next;
        }
        return applyPatch(next, { kind: "overrides", decisions: patch.decisions });
    }

    const decisionsBySelector = new Map(
        (document.overrides ?? []).map((decision) => [selectorKey(decision.target), decision]),
    );
    for (const decision of patch.decisions) {
        const key = selectorKey(decision.target);
        if (decision.state === "inherit") {
            decisionsBySelector.delete(key);
        } else {
            decisionsBySelector.set(key, decision);
        }
    }
    return { ...document, overrides: [...decisionsBySelector.values()] };
}

async function readDocument(path: string): Promise<SettingsDocument | SettingsWriteResult> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (cause: unknown) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            return {};
        }
        return { status: "failed", message: `Could not read ${path}.`, cause };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (cause: unknown) {
        return {
            status: "invalid",
            message: `Refusing to overwrite malformed settings ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
    }
    const parsed = parseDocument(raw);
    return parsed.status === "ok"
        ? parsed.document
        : {
              status: "invalid",
              message: `Refusing to overwrite invalid settings ${path}: ${parsed.message}`,
          };
}

async function writeDocument(
    path: string,
    document: SettingsDocument,
): Promise<SettingsWriteResult | undefined> {
    const parsed = parseDocument(document);
    if (parsed.status === "invalid") {
        return { status: "invalid", message: `Generated settings are invalid: ${parsed.message}` };
    }
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(parsed.document, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await rename(temporaryPath, path);
        return undefined;
    } catch (cause: unknown) {
        try {
            await unlink(temporaryPath);
        } catch {
            // The temporary file may not have been created or may already have been renamed.
        }
        return { status: "failed", message: `Could not write ${path}.`, cause };
    }
}

export class SettingsStore {
    #snapshot: SettingsSnapshot;

    constructor(private readonly context: PiSettingsContext) {
        this.#snapshot = snapshotFromLoaded(loadTogglesSettings(context));
    }

    get snapshot(): SettingsSnapshot {
        return this.#snapshot;
    }

    reload(): SettingsSnapshot {
        this.#snapshot = snapshotFromLoaded(loadTogglesSettings(this.context));
        return this.#snapshot;
    }

    async saveOverrides(
        scope: PersistentScope,
        decisions: readonly PolicyDecision[],
    ): Promise<SettingsWriteResult> {
        return this.save(scope, { kind: "overrides", decisions });
    }

    async saveActiveProfile(
        scope: PersistentScope,
        profile: string | undefined,
    ): Promise<SettingsWriteResult> {
        return this.save(scope, { kind: "active-profile", profile });
    }

    async savePolicy(
        scope: PersistentScope,
        decisions: readonly PolicyDecision[],
        profile: string | undefined,
    ): Promise<SettingsWriteResult> {
        return this.save(scope, { kind: "policy", decisions, profile });
    }

    async clearPolicy(scope: PersistentScope): Promise<SettingsWriteResult> {
        return this.save(scope, { kind: "reset-policy" });
    }

    private async save(scope: PersistentScope, patch: SettingsPatch): Promise<SettingsWriteResult> {
        if (scope === "project" && !this.context.isProjectTrusted()) {
            return { status: "blocked", message: "Project settings require a trusted project." };
        }
        const path =
            scope === "global"
                ? this.#snapshot.loaded.globalConfigPath
                : this.#snapshot.loaded.projectConfigPath;
        if (path === undefined) {
            return { status: "blocked", message: `No ${scope} settings path is available.` };
        }

        const result = await withFileMutationQueue(path, async () => {
            const current = await readDocument(path);
            if ("status" in current) {
                return current;
            }
            const schemaReference =
                current.$schema ??
                (scope === "global" ? GLOBAL_SCHEMA_REFERENCE : PROJECT_SCHEMA_REFERENCE);
            return writeDocument(path, { ...applyPatch(current, patch), $schema: schemaReference });
        });
        if (result !== undefined) {
            return result;
        }
        return { status: "saved", snapshot: this.reload() };
    }
}
