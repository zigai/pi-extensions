import { createHash } from "node:crypto";

import type { TObject } from "typebox";
import { Value } from "typebox/value";

import type {
    ExtensionSettingsDefinition,
    ExtensionSettingsDefinitionInput,
} from "./definition.ts";
import { extensionSettingsDefinitionMarker as definitionMarker } from "./definition-marker.ts";
import type { JsonObject } from "./json-value.ts";

const PREVALIDATION_FORMAT_VERSION = 1 as const;

type SettingsDefinitionFingerprintInput = {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly schemaId?: string;
    readonly schema: TObject;
    readonly exampleSettings?: unknown;
};

type SettingsFingerprintPayload = {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly schemaId: string;
    readonly schema: TObject;
    readonly inputExampleSettings: unknown;
    readonly defaultSettings: JsonObject;
    readonly exampleSettings: JsonObject | undefined;
};

/** Generated, authoring-validated values used by the startup-only definition fast path. */
export type PrevalidatedExtensionSettingsArtifact = {
    readonly formatVersion: typeof PREVALIDATION_FORMAT_VERSION;
    /** Fast runtime proof over the complete JSON-visible definition contract. */
    readonly fingerprint: string;
    /** Authoring proof that also covers TypeBox codecs and non-enumerable schema metadata. */
    readonly semanticFingerprint: string;
    readonly defaultSettings: JsonObject;
    readonly exampleSettings?: JsonObject;
};

export class InvalidPrevalidatedSettingsArtifact extends Error {
    override readonly name = "InvalidPrevalidatedSettingsArtifact";
}

function cloneJson<Value extends JsonObject>(value: Value): Value {
    return structuredClone(value);
}

function freezeRecursively<Value extends object>(value: Value): void {
    const pending: object[] = [value];
    const seen = new WeakSet<object>();
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        for (const key of Reflect.ownKeys(current)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
            if (descriptor === undefined || !("value" in descriptor)) continue;
            const child: unknown = descriptor.value;
            if (!Object.isFrozen(child)) {
                // SAFETY: ECMAScript Object.isFrozen returns true for every primitive. A false
                // result therefore proves that child is an object/function; TypeScript does not
                // encode this standard-library invariant. Codec/schema clone tests cover both.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Object.isFrozen false proves the object identity accepted by the worklist.
                pending.push(child as object);
            }
        }
        Object.freeze(current);
    }
}

function normalizedSchemaId(input: SettingsDefinitionFingerprintInput): string {
    return input.schemaId ?? `urn:pi-extension-settings:${input.id}`;
}

function fingerprintPayload(
    input: SettingsDefinitionFingerprintInput,
    defaultSettings: JsonObject,
    exampleSettings: JsonObject | undefined,
): SettingsFingerprintPayload {
    return {
        id: input.id,
        title: input.title,
        description: input.description,
        schemaId: normalizedSchemaId(input),
        schema: input.schema,
        inputExampleSettings: input.exampleSettings,
        defaultSettings,
        exampleSettings,
    };
}

/** Computes the inexpensive runtime proof stored beside a prevalidated definition. */
export function prevalidatedExtensionSettingsFingerprint(
    input: SettingsDefinitionFingerprintInput,
    defaultSettings: JsonObject,
    exampleSettings: JsonObject | undefined,
): string {
    const serialized = JSON.stringify(fingerprintPayload(input, defaultSettings, exampleSettings));
    return `json-sha256-v1:${createHash("sha256").update(serialized).digest("hex")}`;
}

function semanticFingerprint(
    input: SettingsDefinitionFingerprintInput,
    defaultSettings: JsonObject,
    exampleSettings: JsonObject | undefined,
): string {
    return `typebox-value-hash-v1:${Value.Hash(
        fingerprintPayload(input, defaultSettings, exampleSettings),
    )}`;
}

/** Creates the generated artifact payload from a fully authoring-validated definition. */
export function createPrevalidatedExtensionSettingsArtifact<Schema extends TObject>(
    definition: ExtensionSettingsDefinition<Schema>,
): PrevalidatedExtensionSettingsArtifact {
    const input: SettingsDefinitionFingerprintInput =
        definition.exampleSettings === undefined
            ? {
                  id: definition.id,
                  title: definition.title,
                  description: definition.description,
                  schemaId: definition.schemaId,
                  schema: definition.schema,
              }
            : {
                  id: definition.id,
                  title: definition.title,
                  description: definition.description,
                  schemaId: definition.schemaId,
                  schema: definition.schema,
                  exampleSettings: definition.exampleSettings,
              };
    const defaultSettings = cloneJson(definition.defaultSettings);
    const exampleSettings =
        definition.exampleSettings === undefined
            ? undefined
            : cloneJson(definition.exampleSettings);
    const fingerprint = prevalidatedExtensionSettingsFingerprint(
        input,
        defaultSettings,
        exampleSettings,
    );
    const semantic = semanticFingerprint(input, defaultSettings, exampleSettings);
    return exampleSettings === undefined
        ? {
              formatVersion: PREVALIDATION_FORMAT_VERSION,
              fingerprint,
              semanticFingerprint: semantic,
              defaultSettings,
          }
        : {
              formatVersion: PREVALIDATION_FORMAT_VERSION,
              fingerprint,
              semanticFingerprint: semantic,
              defaultSettings,
              exampleSettings,
          };
}

function hasPlainObjectPrototype(value: JsonObject): boolean {
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

/**
 * Hydrates a settings definition from a checked-in authoring-validated artifact.
 *
 * This startup path deliberately omits schema documentation/default/example validation. Generation
 * performs those exhaustive checks. A stale or malformed artifact fails closed before any settings
 * files are loaded.
 */
export function definePrevalidatedExtensionSettings<const Schema extends TObject>(
    input: ExtensionSettingsDefinitionInput<Schema>,
    artifact: PrevalidatedExtensionSettingsArtifact,
): ExtensionSettingsDefinition<Schema> {
    if (artifact.formatVersion !== PREVALIDATION_FORMAT_VERSION) {
        throw new InvalidPrevalidatedSettingsArtifact(
            `unsupported prevalidation format version: ${String(artifact.formatVersion)}`,
        );
    }
    if (!hasPlainObjectPrototype(artifact.defaultSettings)) {
        throw new InvalidPrevalidatedSettingsArtifact(
            "prevalidated defaultSettings must be a JSON object",
        );
    }
    if (
        artifact.exampleSettings !== undefined &&
        !hasPlainObjectPrototype(artifact.exampleSettings)
    ) {
        throw new InvalidPrevalidatedSettingsArtifact(
            "prevalidated exampleSettings must be a JSON object",
        );
    }

    const expectedFingerprint = prevalidatedExtensionSettingsFingerprint(
        input,
        artifact.defaultSettings,
        artifact.exampleSettings,
    );
    if (artifact.fingerprint !== expectedFingerprint) {
        throw new InvalidPrevalidatedSettingsArtifact(
            "prevalidated settings artifact is stale; run pi-extension-settings generate",
        );
    }

    const expectedSemanticFingerprint = semanticFingerprint(
        input,
        artifact.defaultSettings,
        artifact.exampleSettings,
    );
    if (artifact.semanticFingerprint !== expectedSemanticFingerprint) {
        throw new InvalidPrevalidatedSettingsArtifact(
            "prevalidated settings artifact is stale; run pi-extension-settings generate",
        );
    }

    const schema = Value.Clone(input.schema);
    const defaultSettings = cloneJson(artifact.defaultSettings);
    const exampleSettings =
        artifact.exampleSettings === undefined ? undefined : cloneJson(artifact.exampleSettings);
    freezeRecursively(schema);
    freezeRecursively(defaultSettings);
    if (exampleSettings !== undefined) freezeRecursively(exampleSettings);

    return Object.freeze({
        [definitionMarker]: true as const,
        id: input.id,
        title: input.title,
        description: input.description,
        schemaId: normalizedSchemaId(input),
        schema,
        defaultSettings,
        exampleSettings,
    });
}
