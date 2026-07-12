import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";

export type SchemaValidator<TValue> = {
    readonly Check: (value: unknown) => value is TValue;
    readonly Parse: (value: unknown) => TValue;
};

/** Creates a runtime validator backed by TypeBox's schema compiler. */
export function compileSchema<const T extends TSchema>(schema: T): SchemaValidator<Static<T>> {
    const validator = Compile(schema);
    return {
        Check(value: unknown): value is Static<T> {
            return validator.Check(value);
        },
        Parse(value: unknown): Static<T> {
            if (!validator.Check(value)) throw new Error("Value does not match schema.");
            // oxlint-disable-next-line typescript/no-unsafe-return -- SAFETY: TypeBox's compiled validator checked the value against the schema that defines Static<T>.
            return value;
        },
    };
}

/** Parses a boundary value with a compiled TypeBox validator. */
export function parseWithSchema<TValue>(
    validator: SchemaValidator<TValue>,
    value: unknown,
): TValue | undefined {
    return validator.Check(value) ? validator.Parse(value) : undefined;
}
