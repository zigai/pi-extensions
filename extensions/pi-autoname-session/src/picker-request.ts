import type { Api, Model } from "@earendil-works/pi-ai";

function isPlainPayloadRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function requiresLunaPickerPayload(model: Model<Api>): boolean {
    return (
        model.provider === "openai-codex" &&
        model.api === "openai-codex-responses" &&
        model.id.toLowerCase().includes("luna")
    );
}

/** Apply request requirements imposed by picker models with specialized endpoints. */
export function preparePickerPayload(model: Model<Api>, payload: unknown): unknown {
    if (!requiresLunaPickerPayload(model) || !isPlainPayloadRecord(payload)) {
        return payload;
    }

    const reasoning = isPlainPayloadRecord(payload.reasoning) ? payload.reasoning : {};
    return {
        ...payload,
        parallel_tool_calls: false,
        reasoning: {
            ...reasoning,
            context: "all_turns",
        },
    };
}
