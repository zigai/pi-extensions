import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import { jsonValueSchema } from "./json-value.ts";

const stringValidator = Compile(Type.String());
const numberValidator = Compile(Type.Number());
const booleanValidator = Compile(Type.Boolean());
const jsonArraySchema = Type.Array(jsonValueSchema);
const jsonArrayValidator = Compile(jsonArraySchema);

export type JsonArray = Static<typeof jsonArraySchema>;

export const stringParser = {
    parse(value: unknown): string | undefined {
        return stringValidator.Check(value) ? value : undefined;
    },
};

export const numberParser = {
    parse(value: unknown): number | undefined {
        return numberValidator.Check(value) ? value : undefined;
    },
};

export const booleanParser = {
    parse(value: unknown): boolean | undefined {
        return booleanValidator.Check(value) ? value : undefined;
    },
};

export const jsonArrayParser = {
    parse(value: unknown): JsonArray | undefined {
        try {
            return jsonArrayValidator.Check(value) ? value : undefined;
        } catch {
            return undefined;
        }
    },
};
