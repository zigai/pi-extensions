import { type Result as ResultType } from "better-result";
import type { SettingsArtifactTargets } from "./artifacts.ts";
import { type ExtensionSettingsDefinition } from "./definition.ts";
import { type ProjectFailure } from "./failures.ts";
export declare const PACKAGE_MANIFEST_KEY = "piExtensionSettings";
export type SettingsArtifactProject = {
    readonly packageRoot: string;
    readonly definition: ExtensionSettingsDefinition;
    readonly targets: SettingsArtifactTargets;
};
/** Discover configured standalone packages and npm workspace packages. */
export declare function discoverSettingsProjects(root: string): Promise<ResultType<readonly SettingsArtifactProject[], ProjectFailure>>;
//# sourceMappingURL=projects.d.ts.map