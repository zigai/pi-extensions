import type { Api, Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Request header that opts a Codex model into the Responses Lite wire
 * contract. Requests carrying it are rejected unless reasoning context is
 * set to "all_turns".
 */
const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";

// Request bodies are in-memory values rather than serialized JSON: pi-ai
// assigns undefined to absent optional keys (for example prompt_cache_key
// when no session id is configured) and drops those keys during
// serialization. The schema mirrors that contract so validation sees the
// wire-equivalent value instead of discarding valid bodies.
const jsonValueSchema = Type.Cyclic(
    {
        JsonValue: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Undefined(),
            Type.Array(Type.Ref("JsonValue")),
            Type.Record(Type.String(), Type.Ref("JsonValue")),
        ]),
    },
    "JsonValue",
);
const jsonRecordSchema = Type.Record(Type.String(), jsonValueSchema);
const pickerPayloadSchema = Type.Refine(jsonRecordSchema, (payload) => {
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

type LitePickerPayload = PickerPayload & {
    readonly parallel_tool_calls: false;
    readonly reasoning: PickerPayload;
};

function hasResponsesLiteHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
    if (headers === undefined) {
        return false;
    }

    for (const [name, value] of Object.entries(headers)) {
        if (name.trim().toLowerCase() === CODEX_RESPONSES_LITE_HEADER && value.trim() !== "") {
            return true;
        }
    }

    return false;
}

function requiresResponsesLitePayload(
    model: Model<Api>,
    requestHeaders: Readonly<Record<string, string>> | undefined,
): boolean {
    if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
        return false;
    }

    return hasResponsesLiteHeader(requestHeaders) || model.id.toLowerCase().includes("luna");
}

/** Return a replacement payload when a picker model requires one, or undefined to keep it. */
export function preparePickerPayload(
    model: Model<Api>,
    payload: unknown,
    requestHeaders?: Readonly<Record<string, string>>,
): LitePickerPayload | undefined {
    try {
        const parsedPayload = pickerPayloadParser.parse(payload);

        if (!requiresResponsesLitePayload(model, requestHeaders)) {
            return undefined;
        }

        const reasoning = Value.Check(jsonRecordSchema, parsedPayload.reasoning)
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
