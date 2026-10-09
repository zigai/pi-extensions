import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { jsonValueSchema } from "./json-value.ts";

const stringSchema = Type.String();
const numberSchema = Type.Number();
const booleanSchema = Type.Boolean();
const jsonArraySchema = Type.Array(jsonValueSchema);

export type JsonArray = Static<typeof jsonArraySchema>;

export const stringParser = {
    parse(value: unknown): string | undefined {
        try {
            return Value.Parse(stringSchema, value);
        } catch {
            return undefined;
        }
    },
};

export const numberParser = {
    parse(value: unknown): number | undefined {
        try {
            return Value.Parse(numberSchema, value);
        } catch {
            return undefined;
        }
    },
};

export const booleanParser = {
    parse(value: unknown): boolean | undefined {
        try {
            return Value.Parse(booleanSchema, value);
        } catch {
            return undefined;
        }
    },
};

export const jsonArrayParser = {
    parse(value: unknown): JsonArray | undefined {
        try {
            return Value.Parse(jsonArraySchema, value);
        } catch {
            return undefined;
        }
    },
};
