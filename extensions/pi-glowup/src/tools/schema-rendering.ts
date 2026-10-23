import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import {
    jsonObjectParser,
    jsonObjectSchema,
    jsonValueSchema,
    isJsonArray,
    type JsonObject,
    type JsonValue,
} from "../json-value.ts";
import { stringParser } from "../json-scalar.ts";
import { output, stack, DEFAULT_GLOWUP_NODE_DECODE_LIMITS } from "./protocol/contract.ts";
import { createProtocolRenderer, glowupRenderingAdapter } from "./protocol/renderer.ts";
import { textOutput } from "./built-in/arguments.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolRenderingOptions } from "./types.ts";

const definitionSchema = Type.Object(
    { outputSchema: Type.Optional(jsonObjectSchema) },
    { additionalProperties: true },
);
const resultSchema = Type.Object(
    { content: Type.Optional(Type.Unknown()), structuredContent: Type.Optional(Type.Unknown()) },
    { additionalProperties: true },
);

export const outputSchemaParser = {
    parse(value: unknown): JsonObject | undefined {
        try {
            return Value.Parse(definitionSchema, value).outputSchema;
        } catch {
            return undefined;
        }
    },
};

function fieldRows(
    schema: JsonObject,
    value: JsonValue,
    label: string,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
    if (isJsonArray(value)) {
        const items = jsonObjectParser.parse(schema.items) ?? {};

        return value.flatMap((item, index) => fieldRows(items, item, `${label}[${index + 1}]`));
    }

    const object = jsonObjectParser.parse(value);
    if (object !== undefined) {
        const declared = jsonObjectParser.parse(schema.properties) ?? {};
        const keys = [...new Set([...Object.keys(declared), ...Object.keys(object)])];

        return keys.flatMap((key) => {
            const child = object[key];
            if (child === undefined) return [];

            const childSchema = jsonObjectParser.parse(declared[key]) ?? {};
            let name = stringParser.parse(childSchema.title) ?? key;
            if (label.length > 0) name = `${label} · ${name}`;

            return fieldRows(childSchema, child, name);
        });
    }

    const content = stringParser.parse(value) ?? JSON.stringify(value);
    return [{ label, value: content }];
}

export function createSchemaRenderer(
    schema: JsonObject,
    fallback: ThirdPartyToolRenderer,
    options?: ThirdPartyToolRenderingOptions,
): ThirdPartyToolRenderer {
    const adapter = glowupRenderingAdapter({
        glowupRendering: {
            version: 3,
            independentExpansion: true,
            parseArgs: (value: JsonValue) => value,
            parseResult: (value: JsonValue) => Value.Parse(resultSchema, value),
            renderResult: (
                result: Static<typeof resultSchema>,
                context: { isPartial: boolean; isError: boolean },
            ) => {
                const text = textOutput(result);
                if (context.isError) return output(text ?? "Tool failed without text output.");

                const diagnostic = (message: string) => stack([output(message), output(text)]);
                if (result.structuredContent === undefined) {
                    let message = "Structured result missing for declared output schema.";
                    if (context.isPartial) message = "Structured result pending.";

                    return diagnostic(message);
                }

                const structured = result.structuredContent;

                try {
                    if (
                        !Value.Check(jsonValueSchema, structured) ||
                        !Value.Check(schema, structured)
                    ) {
                        return diagnostic(
                            "Structured result does not match the declared output schema.",
                        );
                    }

                    const rows = fieldRows(schema, structured, "");
                    if (rows.length === 0) return output("(empty structured result)");

                    const content = rows.map((row) => `${row.label} → ${row.value}`).join("\n");
                    if (content.length > DEFAULT_GLOWUP_NODE_DECODE_LIMITS.maxTextCharacters)
                        return output("Structured result exceeds rendering safety limits.");

                    return output(content);
                } catch {
                    return diagnostic("Declared output schema cannot be rendered or validated.");
                }
            },
        },
    });
    if (adapter === undefined) throw new Error("Invalid schema rendering adapter");
    return createProtocolRenderer(adapter, fallback, options?.labelMode, options?.mutationSettings);
}
