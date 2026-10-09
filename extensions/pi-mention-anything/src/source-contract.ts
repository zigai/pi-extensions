import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

export type JsonValue =
    | null
    | boolean
    | number
    | string
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

export type Candidate = {
    readonly id: string;
    readonly label: string;
    readonly segment: string;
    readonly insertionText?: string;
    readonly description?: string;
    readonly searchText?: string;
    readonly selectable: boolean;
    readonly navigable: boolean;
    readonly replacement?: string;
    readonly data?: JsonValue;
};

const MAX_ID_LENGTH = 4096;
const MAX_TEXT_LENGTH = 16_384;
const MAX_REPLACEMENT_LENGTH = 1_048_576;
const MAX_PATH_LENGTH = 64;
const MAX_DISCOVERY_ITEMS = 10_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_COLLECTION_ITEMS = 256;
const MAX_JSON_OBJECT_PROPERTIES = 256;

function createJsonValueSchema(depth: number): TSchema {
    const variants: TSchema[] = [
        Type.Null(),
        Type.Boolean(),
        Type.Number(),
        Type.String({ maxLength: MAX_TEXT_LENGTH }),
    ];
    if (depth > 0) {
        const nested = createJsonValueSchema(depth - 1);

        variants.push(
            Type.Array(nested, { maxItems: MAX_JSON_COLLECTION_ITEMS }),
            Type.Object(
                {},
                {
                    additionalProperties: nested,
                    maxProperties: MAX_JSON_OBJECT_PROPERTIES,
                    propertyNames: Type.String({ maxLength: MAX_ID_LENGTH }),
                },
            ),
        );
    }

    return Type.Union(variants);
}

const jsonValueSchema = Type.Unsafe<JsonValue>(createJsonValueSchema(MAX_JSON_DEPTH));
const candidateFields = {
    id: Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH }),
    label: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
    segment: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
    insertionText: Type.Optional(Type.String({ maxLength: MAX_TEXT_LENGTH })),
    description: Type.Optional(Type.String({ maxLength: MAX_TEXT_LENGTH })),
    searchText: Type.Optional(Type.String({ maxLength: MAX_TEXT_LENGTH })),
    replacement: Type.Optional(Type.String({ maxLength: MAX_REPLACEMENT_LENGTH })),
    data: Type.Optional(jsonValueSchema),
};

export const candidateSchema = Type.Union([
    Type.Object(
        {
            ...candidateFields,
            selectable: Type.Literal(true),
            navigable: Type.Boolean(),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...candidateFields,
            selectable: Type.Literal(false),
            navigable: Type.Literal(true),
        },
        { additionalProperties: false },
    ),
]);

export function parseCandidate(value: unknown): Candidate {
    return Value.Parse(candidateSchema, value);
}

export type DiscoveryRequest = {
    readonly sourceId: string;
    readonly cwd: string;
    readonly trusted: boolean;
    readonly query: string;
    readonly path: readonly Candidate[];
    readonly limit: number;
    readonly cursor?: string;
    readonly signal: AbortSignal;
};

export type DiscoveryResponse = {
    readonly items: readonly Candidate[];
    readonly nextCursor?: string;
};

export const discoveryResponseSchema = Type.Object(
    {
        items: Type.Array(candidateSchema, { maxItems: MAX_DISCOVERY_ITEMS }),
        nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH })),
    },
    { additionalProperties: false },
);

export function parseDiscoveryResponse(value: unknown): DiscoveryResponse {
    return Value.Parse(discoveryResponseSchema, value);
}

export type ResolveRequest = {
    readonly sourceId: string;
    readonly cwd: string;
    readonly trusted: boolean;
    readonly segments: readonly string[];
    readonly signal: AbortSignal;
};

export type Resolution =
    | {
          readonly status: "resolved";
          readonly path: readonly Candidate[];
          readonly replacement?: string;
      }
    | { readonly status: "unresolved"; readonly reason: string };

export const resolutionSchema = Type.Union([
    Type.Object(
        {
            status: Type.Literal("resolved"),
            path: Type.Array(candidateSchema, { minItems: 1, maxItems: MAX_PATH_LENGTH }),
            replacement: Type.Optional(Type.String({ maxLength: MAX_REPLACEMENT_LENGTH })),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: Type.Literal("unresolved"),
            reason: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH }),
        },
        { additionalProperties: false },
    ),
]);

export function parseResolution(value: unknown): Resolution {
    const resolution = Value.Parse(resolutionSchema, value);
    if (resolution.status === "resolved") {
        for (const [index, candidate] of resolution.path.slice(0, -1).entries()) {
            if (!candidate.navigable)
                throw new Error(`resolved path ancestor at index ${index} must be navigable`);
        }
    }

    return resolution;
}

export type Provider = {
    readonly filtering: "local" | "provider";
    discover(request: DiscoveryRequest): Promise<DiscoveryResponse>;
    resolve(request: ResolveRequest): Promise<Resolution>;
    dispose?(): void | Promise<void>;
};
