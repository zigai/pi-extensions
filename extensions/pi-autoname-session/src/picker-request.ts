import type { Api, Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const jsonValueSchema = Type.Cyclic(
    {
        JsonValue: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Array(Type.Ref("JsonValue")),
            Type.Record(Type.String(), Type.Ref("JsonValue")),
        ]),
    },
    "JsonValue",
);
const pickerPayloadSchema = Type.Refine(Type.Record(Type.String(), jsonValueSchema), (payload) => {
    try {
        const prototype = Reflect.getPrototypeOf(payload);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
});
const pickerPayloadParser = {
    parse: (Value.Parse<typeof pickerPayloadSchema>).bind(undefined, pickerPayloadSchema),
};

type PickerPayload = Static<typeof pickerPayloadSchema>;
type LunaPickerPayload = PickerPayload & {
    readonly parallel_tool_calls: false;
    readonly reasoning: PickerPayload;
};

function requiresLunaPickerPayload(model: Model<Api>): boolean {
    return (
        model.provider === "openai-codex" &&
        model.api === "openai-codex-responses" &&
        model.id.toLowerCase().includes("luna")
    );
}

/** Return a replacement payload when a picker model requires one, or undefined to keep it. */
export function preparePickerPayload(
    model: Model<Api>,
    payload: unknown,
): LunaPickerPayload | undefined {
    try {
        const parsedPayload = pickerPayloadParser.parse(payload);
        if (!requiresLunaPickerPayload(model)) {
            return undefined;
        }

        const reasoning = Value.Check(pickerPayloadSchema, parsedPayload.reasoning)
            ? parsedPayload.reasoning
            : {};
        return {
            ...parsedPayload,
            parallel_tool_calls: false,
            reasoning: {
                ...reasoning,
                context: "all_turns",
            },
        };
    } catch {
        return undefined;
    }
}
