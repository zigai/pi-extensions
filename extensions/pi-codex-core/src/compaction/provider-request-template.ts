import { textFromResponsesContent } from "./responses-input.ts";
import type {
    JsonObject,
    JsonValue,
    ProviderRequestLayout,
    ProviderRequestTemplate,
    ResponsesInputItem,
    ResponsesTool,
} from "./types.ts";

const templatesBySessionId = new Map<string, ProviderRequestTemplate>();

/** Capture only static/cache-shaping fields from a provider-ready Responses request. */
export function captureProviderRequestTemplate(
    sessionId: string,
    payload: unknown,
    options: { readonly activeToolNames?: readonly string[] | undefined } = {},
): ProviderRequestTemplate | undefined {
    const request = unknownRecord(payload);
    const model = ownValue(request, "model");
    const input = ownValue(request, "input");
    if (!request || typeof model !== "string" || !isUnknownArray(input)) {
        templatesBySessionId.delete(sessionId);
        return undefined;
    }

    const rawFirstInput = input[0];
    const rawFirstRecord = unknownRecord(rawFirstInput);
    const additionalToolsItem = isAdditionalToolsRecord(rawFirstRecord)
        ? parseJsonObject(rawFirstInput)
        : undefined;
    if (isAdditionalToolsRecord(rawFirstRecord) && !additionalToolsItem) {
        templatesBySessionId.delete(sessionId);
        return undefined;
    }
    const layout: ProviderRequestLayout = additionalToolsItem ? "responses-lite" : "responses";
    const instructionItems = additionalToolsItem
        ? leadingLiteInstructionItems(input.slice(1))
        : undefined;
    const standardInstructions = ownValue(request, "instructions");
    const instructions = additionalToolsItem
        ? (instructionItems ?? [])
              .map((item) => textFromResponsesContent(item.content))
              .filter((text) => text.length > 0)
              .join("\n")
        : typeof standardInstructions === "string"
          ? standardInstructions
          : "";
    const tools = parseTools(additionalToolsItem?.tools ?? ownValue(request, "tools"));
    const promptCacheKey = nonEmptyString(ownValue(request, "prompt_cache_key"));
    const reasoning = parseJsonObject(ownValue(request, "reasoning"));
    const serviceTier = nonEmptyString(ownValue(request, "service_tier"));

    const template: ProviderRequestTemplate = {
        model,
        layout,
        ...(options.activeToolNames ? { activeToolNames: [...options.activeToolNames] } : {}),
        instructions,
        ...(tools ? { tools } : {}),
        ...(additionalToolsItem ? { additionalToolsItem } : {}),
        ...(instructionItems && instructionItems.length > 0 ? { instructionItems } : {}),
        ...(promptCacheKey ? { promptCacheKey } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(serviceTier ? { serviceTier } : {}),
    };
    templatesBySessionId.set(sessionId, template);
    return template;
}

/** Return a captured template only when both model and wire layout still match. */
export function getProviderRequestTemplate(
    sessionId: string,
    model: string,
    layout: ProviderRequestLayout,
    activeToolNames?: readonly string[],
): ProviderRequestTemplate | undefined {
    const template = templatesBySessionId.get(sessionId);
    return template?.model === model &&
        template.layout === layout &&
        activeToolsStillMatch(template.activeToolNames, activeToolNames)
        ? template
        : undefined;
}

/** Invalidate captured request state after session, model, or configuration changes. */
export function clearProviderRequestTemplate(sessionId: string): void {
    templatesBySessionId.delete(sessionId);
}

function leadingLiteInstructionItems(input: readonly unknown[]): ResponsesInputItem[] {
    const items: ResponsesInputItem[] = [];
    for (const rawItem of input) {
        const rawRecord = unknownRecord(rawItem);
        if (
            ownValue(rawRecord, "role") !== "developer" ||
            (ownValue(rawRecord, "type") !== undefined && ownValue(rawRecord, "type") !== "message")
        ) {
            break;
        }
        const item = parseJsonObject(rawItem);
        if (!item) break;
        items.push(item);
    }
    return items;
}

function isAdditionalToolsRecord(item: Record<string, unknown> | undefined): boolean {
    return ownValue(item, "type") === "additional_tools" && ownValue(item, "role") === "developer";
}

function parseTools(value: unknown): ResponsesTool[] | undefined {
    if (!isUnknownArray(value)) return undefined;
    const tools: ResponsesTool[] = [];
    for (const item of value) {
        const tool = parseJsonObject(item);
        if (!tool || typeof tool.type !== "string") return undefined;
        tools.push(tool);
    }
    return tools;
}

function parseJsonValue(value: unknown): JsonValue | undefined {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (isUnknownArray(value)) {
        const items: JsonValue[] = [];
        for (const item of value) {
            const parsed = parseJsonValue(item);
            if (parsed === undefined) return undefined;
            items.push(parsed);
        }
        return items;
    }
    return parseJsonObject(value);
}

function parseJsonObject(value: unknown): JsonObject | undefined {
    const record = unknownRecord(value);
    if (!record) return undefined;
    const parsed: Record<string, JsonValue> = {};
    for (const key of Object.keys(record)) {
        const nested = ownValue(record, key);
        if (nested === undefined) continue;
        const parsedValue = parseJsonValue(nested);
        if (parsedValue === undefined) return undefined;
        parsed[key] = parsedValue;
    }
    return parsed;
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
    return isUnknownRecord(value) ? value : undefined;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(record: Record<string, unknown> | undefined, key: string): unknown {
    return record ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function activeToolsStillMatch(
    captured: readonly string[] | undefined,
    current: readonly string[] | undefined,
): boolean {
    if (!captured || !current) return true;
    return (
        captured.length === current.length &&
        captured.every((toolName, index) => toolName === current[index])
    );
}
