export { checkSettingsArtifacts, generateSettingsArtifacts, renderSettingsArtifacts, type CheckedSettingsArtifacts, type GeneratedSettingsArtifacts, type RenderedSettingsArtifacts, type SettingsArtifactTargets, } from "./artifacts.ts";
export { defineExtensionSettings, InvalidSettingsDefinition, isExtensionSettingsDefinition, type ExtensionSettingsDefinition, type ExtensionSettingsDefinitionInput, type ResolvedSettings, } from "./definition.ts";
export { DefinitionModuleInvalid, FileOperationFailed, ProjectManifestInvalid, ReadmeMarkersMissing, type ArtifactFailure, type ProjectFailure, } from "./failures.ts";
export { defaultGlobalSettingsDisplayPath, EXTENSION_SETTINGS_DIRECTORY, EXTENSION_SETTINGS_SCHEMA_DIRECTORY, resolveGlobalSettingsPaths, resolveProjectSettingsPaths, type ExtensionSettingsPaths, } from "./paths.ts";
export { discoverSettingsProjects, PACKAGE_MANIFEST_KEY, type SettingsArtifactProject, } from "./projects.ts";
export { README_GENERATED_END, README_GENERATED_START, renderReadmeSettingsSection, replaceGeneratedReadmeSection, type RenderReadmeOptions, } from "./readme.ts";
export { loadExtensionSettings, loadExtensionSettingsSync, type BundledSchemaSource, type LoadedExtensionSettings, type LoadExtensionSettingsOptions, type ProjectSettingsLocation, type SettingsDiagnostic, type SettingsDiagnosticCode, } from "./runtime.ts";
export { createDefaultSettingsDocument, createSettingsFileSchema, JSON_SCHEMA_DIALECT, } from "./schema-document.ts";
//# sourceMappingURL=index.d.ts.map