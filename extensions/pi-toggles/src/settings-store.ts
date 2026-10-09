import {
    updatePiExtensionSettings,
    type LoadedPiExtensionSettings,
    type PiSettingsContext,
} from "@zigai/pi-extension-settings/pi";
import { Compile } from "typebox/compile";
import { selectorKey } from "./capability.ts";
import {
    extensionSettingsDefinition,
    loadTogglesSettings,
    settingsDocumentSchema,
    settingsSchema,
    type ExtensionSettings,
    type PolicyDecision,
    type SettingsDocument,
} from "./settings.ts";

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

        const result = await updatePiExtensionSettings(extensionSettingsDefinition, this.context, {
            scope,
            update: (current) => applyPatch(current, patch),
        });
        switch (result.status) {
            case "updated":
            case "unchanged":
                return { status: "saved", snapshot: this.reload() };
            case "blocked":
                return { status: "blocked", message: result.message };
            case "invalid-existing":
            case "invalid-update":
                return { status: "invalid", message: result.message };
            case "conflict":
            case "failed":
                return { status: "failed", message: result.message, cause: result };
        }
    }
}
