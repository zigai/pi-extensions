import {
    JsonArrayDecoder,
    JsonObjectDecoder,
    JsonStringDecoder,
    parseResponsesInputItems,
} from "../compaction/responses-input.ts";
import type { JsonObject, JsonValue, ResponsesInputItem } from "../compaction/types.ts";
import type { ImageDetail } from "./codex-prompt.ts";

const IMAGE_DETAIL_MARKER_PREFIX = "[pi-codex-image-detail:";

/** Durable session marker used to restore provider image detail during request serialization. */
export function imageDetailMarker(detail: ImageDetail): string {
    return `${IMAGE_DETAIL_MARKER_PREFIX}${detail}]`;
}

export function isImageDetailMarker(text: string): boolean {
    return parseImageDetailMarker(text) !== undefined;
}

/** Restore detail lost by Pi's generic ImageContent conversion and remove internal markers. */
export function rewriteProviderImageDetails(payload: unknown): JsonObject | undefined {
    const parsedPayload = JsonObjectDecoder.decode(payload);
    const parsedInput = parseResponsesInputItems(parsedPayload?.input);
    if (!parsedPayload || !parsedInput) return undefined;
    let changed = false;
    const input = parsedInput.map((item) => {
        const rewritten = rewriteFunctionOutput(item);
        if (rewritten !== undefined) {
            changed = true;
            return rewritten;
        }
        return item;
    });
    return changed ? { ...parsedPayload, input } : undefined;
}

function rewriteFunctionOutput(item: ResponsesInputItem): ResponsesInputItem | undefined {
    const output = JsonArrayDecoder.decode(item.output);
    if (item.type !== "function_call_output" || !output) return undefined;
    const detail = output.flatMap((part) => {
        const object = JsonObjectDecoder.decode(part);
        const text = JsonStringDecoder.decode(object?.text);
        if (object?.type !== "input_text" || text === undefined) return [];
        const parsed = parseImageDetailFromText(text);
        return parsed ? [parsed] : [];
    })[0];
    if (!detail) return undefined;

    return {
        ...item,
        output: output.flatMap((part): JsonValue[] => {
            const object = JsonObjectDecoder.decode(part);
            const partText = JsonStringDecoder.decode(object?.text);
            if (object?.type === "input_text" && partText !== undefined) {
                const text = partText
                    .split("\n")
                    .filter((line) => !isImageDetailMarker(line))
                    .join("\n")
                    .trim();
                return text.length > 0 ? [{ ...object, text }] : [];
            }
            if (object?.type === "input_image") return [{ ...object, detail }];
            return [part];
        }),
    };
}

function parseImageDetailFromText(text: string): ImageDetail | undefined {
    for (const line of text.split("\n")) {
        const detail = parseImageDetailMarker(line);
        if (detail) return detail;
    }
    return undefined;
}

function parseImageDetailMarker(text: string): ImageDetail | undefined {
    const trimmed = text.trim();
    if (trimmed === imageDetailMarker("high")) return "high";
    if (trimmed === imageDetailMarker("original")) return "original";
    return undefined;
}
