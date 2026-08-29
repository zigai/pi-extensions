import { Type } from "typebox";

import {
    JsonObjectDecoder,
    JsonValueDecoder,
    textFromResponsesContent,
} from "./responses-input.ts";
import { compileSchema } from "../schema-parsing.ts";
import type {
    JsonObject,
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
const templatesBySessionId = new Map<string, ProviderRequestTemplate>();

/** Capture only static/cache-shaping fields from a provider-ready Responses request. */
export function captureProviderRequestTemplate(
    sessionId: string,
    payload: unknown,
    options: { readonly activeToolNames?: readonly string[] | undefined } = {},
): ProviderRequestTemplate | undefined {
    const request = JsonObjectDecoder.decode(payload);
    const model = StringDecoder.decode(ownValue(request, "model"));
    const input = UnknownArrayDecoder.decode(ownValue(request, "input"));
    if (!request || model === undefined || input === undefined) {
        templatesBySessionId.delete(sessionId);
        return undefined;
    }

    const rawFirstInput = input[0];
    const rawFirstRecord = JsonObjectDecoder.decode(rawFirstInput);
    const additionalToolsItem = isAdditionalToolsRecord(rawFirstRecord)
        ? JsonObjectDecoder.decode(rawFirstInput)
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
        : (StringDecoder.decode(standardInstructions) ?? "");
    const tools = parseTools(additionalToolsItem?.tools ?? ownValue(request, "tools"));
    const promptCacheKey = nonEmptyString(ownValue(request, "prompt_cache_key"));
    const reasoning = JsonObjectDecoder.decode(ownValue(request, "reasoning"));
    const serviceTier = nonEmptyString(ownValue(request, "service_tier"));

    const template: ProviderRequestTemplateConstruction = options.activeToolNames
        ? { model, layout, activeToolNames: [...options.activeToolNames], instructions }
        : { model, layout, instructions };
    if (tools) template.tools = tools;
    if (additionalToolsItem) template.additionalToolsItem = additionalToolsItem;
    if (instructionItems && instructionItems.length > 0) {
        template.instructionItems = instructionItems;
    }
    if (promptCacheKey) template.promptCacheKey = promptCacheKey;
    if (reasoning) template.reasoning = reasoning;
    if (serviceTier) template.serviceTier = serviceTier;
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
        const rawRecord = JsonObjectDecoder.decode(rawItem);
        if (
            ownValue(rawRecord, "role") !== "developer" ||
            (ownValue(rawRecord, "type") !== undefined && ownValue(rawRecord, "type") !== "message")
        ) {
            break;
        }
        const item = JsonObjectDecoder.decode(rawItem);
        if (!item) break;
        items.push(item);
    }
    return items;
}

function isAdditionalToolsRecord(item: JsonObject | undefined): boolean {
    return ownValue(item, "type") === "additional_tools" && ownValue(item, "role") === "developer";
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

function ownValue(record: JsonObject | undefined, key: string): JsonObject[string] {
    return JsonValueDecoder.decode(
        record ? Object.getOwnPropertyDescriptor(record, key)?.value : undefined,
    );
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
