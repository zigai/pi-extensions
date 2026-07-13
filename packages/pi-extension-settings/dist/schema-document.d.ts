import type { TSchema } from "typebox";
import { type JsonObject } from "./json-value.ts";
export declare const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
export type SchemaDocumentInput = {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly schemaId: string;
    readonly schema: TSchema;
};
/** Return whether the user schema collides with editor metadata owned by this package. */
export declare function hasReservedSchemaProperty(schema: TSchema): boolean;
/** Return user-editable leaf settings that do not have descriptions. */
export declare function findUndocumentedSettings(schema: TSchema): readonly string[];
/** Return paths of object schemas that permit unrecognized properties. */
export declare function findNonStrictObjectSchemas(schema: TSchema): readonly string[];
/** Convert a resolved settings schema into a deeply partial persisted-file schema. */
export declare function createSettingsFileSchema(input: SchemaDocumentInput): JsonObject;
/** Create the exact global settings document scaffolded for users. */
export declare function createDefaultSettingsDocument(input: SchemaDocumentInput & {
    readonly defaultSettings: JsonObject;
}): JsonObject;
/** Return a TypeBox-compatible schema for decoding persisted partial settings layers. */
export declare function createSettingsLayerSchema(input: SchemaDocumentInput): TSchema;
/** Return whether the schema's defaults are ordinary JSON data. */
export declare function isJsonSettingsDefault(value: unknown): value is JsonObject;
//# sourceMappingURL=schema-document.d.ts.map