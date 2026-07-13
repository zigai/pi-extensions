import type { ExtensionSettingsDefinition } from "./definition.ts";
export declare const README_GENERATED_START = "<!-- pi-extension-settings:start -->";
export declare const README_GENERATED_END = "<!-- pi-extension-settings:end -->";
export type RenderReadmeOptions = {
    readonly globalPath?: string;
};
/** Render the generated README configuration section from the TypeBox definition. */
export declare function renderReadmeSettingsSection(definition: ExtensionSettingsDefinition, options?: RenderReadmeOptions): string;
/** Replace exactly one generated README region, or return undefined for invalid markers. */
export declare function replaceGeneratedReadmeSection(readme: string, generatedSection: string): string | undefined;
//# sourceMappingURL=readme.d.ts.map