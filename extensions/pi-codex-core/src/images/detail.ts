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
export function rewriteProviderImageDetails(payload: unknown): unknown {
    if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
    let changed = false;
    const input = payload.input.map((item): unknown => {
        const rewritten = rewriteFunctionOutput(item);
        if (rewritten !== undefined) {
            changed = true;
            return rewritten;
        }
        return item;
    });
    return changed ? { ...payload, input } : undefined;
}

function rewriteFunctionOutput(item: unknown): unknown {
    if (!isRecord(item) || item.type !== "function_call_output" || !Array.isArray(item.output)) {
        return undefined;
    }
    const detail = item.output.flatMap((part) => {
        if (!isRecord(part) || part.type !== "input_text" || typeof part.text !== "string") {
            return [];
        }
        const parsed = parseImageDetailFromText(part.text);
        return parsed ? [parsed] : [];
    })[0];
    if (!detail) return undefined;

    return {
        ...item,
        output: item.output.flatMap((part): unknown[] => {
            if (isRecord(part) && part.type === "input_text" && typeof part.text === "string") {
                const text = part.text
                    .split("\n")
                    .filter((line) => !isImageDetailMarker(line))
                    .join("\n")
                    .trim();
                return text.length > 0 ? [{ ...part, text }] : [];
            }
            if (isRecord(part) && part.type === "input_image") return [{ ...part, detail }];
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
