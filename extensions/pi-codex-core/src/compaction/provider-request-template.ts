import { Type } from "typebox";

import { JsonObjectDecoder, textFromResponsesContent } from "./responses-input.ts";
import { compileSchema } from "../schema-parsing.ts";
import type {
    ProviderRequestLayout,
    ProviderRequestTemplate,
    ResponsesInputItem,
    ResponsesTool,
} from "./types.ts";

type ProviderRequestTemplateConstruction = {
    -readonly [Key in keyof ProviderRequestTemplate]: ProviderRequestTemplate[Key];
};

const UnknownArrayDecoder = compileSchema(Type.Array(Type.Unknown()));
const StringDecoder = compileSchema(Type.String());
const InputLengthDecoder = compileSchema(Type.Integer({ minimum: 0, maximum: 4_294_967_295 }));
const templatesBySessionId = new Map<string, ProviderRequestTemplate>();

/** Capture only static/cache-shaping fields from a provider-ready Responses request. */
export function captureProviderRequestTemplate(
    sessionId: string,
    payload: unknown,
    options: { readonly activeToolNames?: readonly string[] | undefined } = {},
): ProviderRequestTemplate | undefined {
    const template = ProviderRequestTemplateDecoder.decode(payload);
    if (!template) {
        templatesBySessionId.delete(sessionId);
        return undefined;
    }
    if (options.activeToolNames) template.activeToolNames = [...options.activeToolNames];
    templatesBySessionId.set(sessionId, template);
    return template;
}

// Descriptor-based projection keeps accessors and conversation content outside the retained boundary.
const ProviderRequestTemplateDecoder = {
    decode(payload: unknown): ProviderRequestTemplateConstruction | undefined {
        try {
            if (!isRequestObject(payload)) return undefined;
            const input: unknown = Object.getOwnPropertyDescriptor(payload, "input")?.value;
            const modelValue: unknown = Object.getOwnPropertyDescriptor(payload, "model")?.value;
            const instructionsValue: unknown = Object.getOwnPropertyDescriptor(
                payload,
                "instructions",
            )?.value;
            const toolsValue: unknown = Object.getOwnPropertyDescriptor(payload, "tools")?.value;
            const cacheKeyValue: unknown = Object.getOwnPropertyDescriptor(
                payload,
                "prompt_cache_key",
            )?.value;
            const reasoningValue: unknown = Object.getOwnPropertyDescriptor(
                payload,
                "reasoning",
            )?.value;
            const serviceTierValue: unknown = Object.getOwnPropertyDescriptor(
                payload,
                "service_tier",
            )?.value;
            const request = JsonObjectDecoder.decode({
                model: modelValue,
                instructions: instructionsValue,
                tools: toolsValue,
                prompt_cache_key: cacheKeyValue,
                reasoning: reasoningValue,
                service_tier: serviceTierValue,
            });
            const model = StringDecoder.decode(request?.model);
            if (!request || model === undefined || !isInputArray(input)) return undefined;

            const rawFirstInput: unknown = Object.getOwnPropertyDescriptor(input, "0")?.value;
            const hasAdditionalTools = isAdditionalToolsRecord(rawFirstInput);
            const additionalToolsItem = hasAdditionalTools
                ? JsonObjectDecoder.decode(rawFirstInput)
                : undefined;
            if (hasAdditionalTools && !additionalToolsItem) return undefined;
            const layout: ProviderRequestLayout = additionalToolsItem
                ? "responses-lite"
                : "responses";
            const instructionItems = additionalToolsItem
                ? leadingLiteInstructionItems(input)
                : undefined;
            if (additionalToolsItem && !instructionItems) return undefined;
            const instructions = additionalToolsItem
                ? (instructionItems ?? [])
                      .map((item) => textFromResponsesContent(item.content))
                      .filter((text) => text.length > 0)
                      .join("\n")
                : (StringDecoder.decode(request.instructions) ?? "");
            const tools = parseTools(additionalToolsItem?.tools ?? request.tools);
            const promptCacheKey = nonEmptyString(request.prompt_cache_key);
            const reasoning = JsonObjectDecoder.decode(request.reasoning);
            const serviceTier = nonEmptyString(request.service_tier);
            const template: ProviderRequestTemplateConstruction = { model, layout, instructions };
            if (tools) template.tools = tools;
            if (additionalToolsItem) template.additionalToolsItem = additionalToolsItem;
            if (instructionItems && instructionItems.length > 0)
                template.instructionItems = instructionItems;
            if (promptCacheKey) template.promptCacheKey = promptCacheKey;
            if (reasoning) template.reasoning = reasoning;
            if (serviceTier) template.serviceTier = serviceTier;
            return template;
        } catch {
            return undefined;
        }
    },
};

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

function leadingLiteInstructionItems(input: readonly unknown[]): ResponsesInputItem[] | undefined {
    const length = InputLengthDecoder.decode(
        Object.getOwnPropertyDescriptor(input, "length")?.value,
    );
    if (length === undefined) return undefined;
    const items: ResponsesInputItem[] = [];
    for (let index = 1; index < length; index += 1) {
        const rawItem: unknown = Object.getOwnPropertyDescriptor(input, String(index))?.value;
        if (!isRequestObject(rawItem)) break;
        const type: unknown = Object.getOwnPropertyDescriptor(rawItem, "type")?.value;
        if (
            Object.getOwnPropertyDescriptor(rawItem, "role")?.value !== "developer" ||
            (type !== undefined && type !== "message")
        ) {
            break;
        }
        const item = JsonObjectDecoder.decode(rawItem);
        if (!item) return undefined;
        items.push(item);
    }
    return items;
}

function isAdditionalToolsRecord(item: unknown): item is object {
    return (
        isRequestObject(item) &&
        Object.getOwnPropertyDescriptor(item, "type")?.value === "additional_tools" &&
        Object.getOwnPropertyDescriptor(item, "role")?.value === "developer"
    );
}

function parseTools(value: unknown): ResponsesTool[] | undefined {
    const rawTools = UnknownArrayDecoder.decode(value);
    if (rawTools === undefined) return undefined;
    const tools: ResponsesTool[] = [];
    for (const item of rawTools) {
        const tool = JsonObjectDecoder.decode(item);
        if (!tool || StringDecoder.decode(tool.type) === undefined) return undefined;
        tools.push(tool);
    }
    return tools;
}

function isRequestObject(value: unknown): value is object {
    try {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    } catch {
        return false;
    }
}

function isInputArray(value: unknown): value is readonly unknown[] {
    try {
        return Array.isArray(value);
    } catch {
        return false;
    }
}

function nonEmptyString(value: unknown): string | undefined {
    const text = StringDecoder.decode(value)?.trim();
    return text && text.length > 0 ? text : undefined;
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
