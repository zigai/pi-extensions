import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";

export type SchemaValidator<TValue> = {
    readonly Parse: (value: unknown) => TValue;
    readonly decode: (value: unknown) => TValue | undefined;
};

function createSchemaValidator<TValue>(
    parseValue: SchemaValidator<TValue>["Parse"],
): SchemaValidator<TValue> {
    return {
        Parse(value: unknown): TValue {
            return parseValue(value);
        },
        decode(value: unknown): TValue | undefined {
            try {
                return parseValue(value);
            } catch {
                return undefined;
            }
        },
    };
}

/** Creates a runtime validator backed by TypeBox's schema compiler. */
export function compileSchema<const T extends TSchema>(schema: T): SchemaValidator<Static<T>> {
    const validator = Compile(schema);
    return createSchemaValidator((value): Static<T> => {
        if (!validator.Check(value)) throw new Error("Value does not match schema.");
        // oxlint-disable-next-line typescript/no-unsafe-return -- SAFETY: TypeBox's compiled validator checked the value against the schema that defines Static<T>.
        return value;
    });
}

/** Parses a boundary value with a compiled TypeBox validator. */
export function parseWithSchema<TValue>(
    validator: SchemaValidator<TValue>,
    value: unknown,
): TValue | undefined {
    return validator.decode(value);
}

/** Shared scalar decoder for host APIs whose declarations expose an imprecise value type. */
export const StringDecoder = compileSchema(Type.String());

/** Shared decoder for Node failures that carry a filesystem-style error code. */
export const NodeErrorCodeDecoder = compileSchema(Type.Object({ code: Type.String() }));
