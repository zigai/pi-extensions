import { type Result as ResultType } from "better-result";
import type { ExtensionSettingsDefinition } from "./definition.ts";
import { type ArtifactFailure } from "./failures.ts";
export type SettingsArtifactTargets = {
    readonly schemaPath: string;
    readonly readmePath: string;
    readonly globalPath?: string;
};
export type RenderedSettingsArtifacts = {
    readonly schema: string;
    readonly readmeSection: string;
};
export type GeneratedSettingsArtifacts = {
    readonly changedPaths: readonly string[];
};
export type CheckedSettingsArtifacts = {
    readonly current: boolean;
    readonly stalePaths: readonly string[];
};
/** Render deterministic repository artifacts without touching the filesystem. */
export declare function renderSettingsArtifacts(definition: ExtensionSettingsDefinition, targets: SettingsArtifactTargets): RenderedSettingsArtifacts;
/** Generate the checked-in schema and marked README section. */
export declare function generateSettingsArtifacts(definition: ExtensionSettingsDefinition, targets: SettingsArtifactTargets): Promise<ResultType<GeneratedSettingsArtifacts, ArtifactFailure>>;
/** Check generated artifacts without modifying the working tree. */
export declare function checkSettingsArtifacts(definition: ExtensionSettingsDefinition, targets: SettingsArtifactTargets): Promise<ResultType<CheckedSettingsArtifacts, ArtifactFailure>>;
//# sourceMappingURL=artifacts.d.ts.map