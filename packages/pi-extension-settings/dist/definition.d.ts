import { type StaticDecode, type TObject } from "typebox";
import { type JsonObject } from "./json-value.ts";
declare const definitionMarker: unique symbol;
export declare class InvalidSettingsDefinition extends Error {
    readonly name = "InvalidSettingsDefinition";
    readonly reason: string;
    constructor(reason: string);
}
export type ExtensionSettingsDefinition<Schema extends TObject = TObject> = {
    readonly [definitionMarker]: true;
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly schemaId: string;
    readonly schema: Schema;
    readonly defaultSettings: JsonObject;
};
export type ExtensionSettingsDefinitionInput<Schema extends TObject> = {
    /** Stable, filename-safe identity. Changing it changes where settings are stored. */
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /** Stable canonical URI for project-local schema references. */
    readonly schemaId?: string;
    /** Resolved settings schema. Required properties must declare defaults. */
    readonly schema: Schema;
};
/** Define an extension's settings contract and verify its defaults immediately. */
export declare function defineExtensionSettings<const Schema extends TObject>(input: ExtensionSettingsDefinitionInput<Schema>): ExtensionSettingsDefinition<Schema>;
/** Return whether a dynamically imported value was created by `defineExtensionSettings`. */
export declare function isExtensionSettingsDefinition(value: unknown): value is ExtensionSettingsDefinition;
export type ResolvedSettings<Definition extends ExtensionSettingsDefinition> = StaticDecode<Definition["schema"]>;
export {};
//# sourceMappingURL=definition.d.ts.map