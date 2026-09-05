import { codexModelRequestProfile, codexReasoningEffortForRequest } from "./models.ts";
import { buildResponsesLitePrefix } from "./responses-lite-prefix.ts";
import {
    JsonArrayDecoder,
    JsonObjectDecoder,
    JsonStringDecoder,
} from "../compaction/responses-input.ts";
import type { JsonObject, JsonValue } from "../compaction/types.ts";

type JsonObjectConstruction = Record<string, JsonValue | undefined>;

export const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY =
    "ws_request_header_x_openai_internal_codex_responses_lite";

/** Rewrites a supported Codex Responses payload to the Responses Lite wire layout. */
export function rewriteCodexResponsesPayload(
    payload: unknown,
    sessionId: string,
    expectedModelId?: string,
): JsonObject | undefined {
    const request = JsonObjectDecoder.decode(payload);
    if (!request) return undefined;
    const model = JsonStringDecoder.decode(request.model);
    const requestInput = JsonArrayDecoder.decode(request.input);
    if (model === undefined || requestInput === undefined) return undefined;
    if (expectedModelId !== undefined && model !== expectedModelId) return undefined;

    const profile = codexModelRequestProfile(model);
    if (!profile?.useResponsesLite) return undefined;

    const rewrittenInput = requestInput.map(stripInputImageDetail);
    const alreadyUsesLiteLayout = isAdditionalToolsItem(rewrittenInput[0]);
    const tools = JsonArrayDecoder.decode(request.tools) ?? [];
    const instructions = JsonStringDecoder.decode(request.instructions) ?? "";
    const input = alreadyUsesLiteLayout
        ? rewrittenInput
        : [...buildResponsesLitePrefix(sessionId, tools, instructions), ...rewrittenInput];
    const clientMetadata = JsonObjectDecoder.decode(request.client_metadata) ?? {};
    const reasoning = responsesLiteReasoning(request.reasoning, profile.defaultReasoningEffort);

    const rewritten = omitJsonObjectKeys(
        request,
        new Set([
            "instructions",
            "tools",
            "input",
            "parallel_tool_calls",
            "reasoning",
            "client_metadata",
            "service_tier",
        ]),
    );
    const result: JsonObjectConstruction = {};
    for (const [key, value] of Object.entries(rewritten)) result[key] = value;
    result.input = input;
    result.parallel_tool_calls = false;
    result.reasoning = reasoning;
    result.client_metadata = {
        ...clientMetadata,
        [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
    };
    if (request.service_tier === "priority") result.service_tier = "priority";
    return result;
}

/** Removes the visible reasoning summary request while preserving hidden reasoning controls. */
export function omitReasoningSummary(
    payload: unknown,
    expectedModelId?: string,
): JsonObject | undefined {
    const request = JsonObjectDecoder.decode(payload);
    if (!request) return undefined;
    const model = JsonStringDecoder.decode(request.model);
    if (model === undefined) return undefined;
    if (expectedModelId !== undefined && model !== expectedModelId) return undefined;

    const reasoning = JsonObjectDecoder.decode(request.reasoning);
    if (!reasoning || !Object.hasOwn(reasoning, "summary")) return undefined;
    return { ...request, reasoning: omitJsonObjectKeys(reasoning, new Set(["summary"])) };
}

function responsesLiteReasoning(
    value: JsonValue | undefined,
    defaultEffort: string | undefined,
): JsonObject {
    const current = JsonObjectDecoder.decode(value) ?? {};
    const currentEffort = JsonStringDecoder.decode(current.effort)?.trim();
    const effort =
        currentEffort && currentEffort.length > 0
            ? codexReasoningEffortForRequest(currentEffort)
            : defaultEffort;
    const currentSummary = JsonStringDecoder.decode(current.summary);
    const summary = currentSummary === "none" ? undefined : currentSummary;
    const reasoning: JsonObjectConstruction = omitJsonObjectKeys(
        current,
        new Set(["effort", "summary", "context"]),
    );
    if (effort) reasoning.effort = effort;
    if (summary) reasoning.summary = summary;
    reasoning.context = "all_turns";
    return reasoning;
}

function stripInputImageDetail(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(stripInputImageDetail);
    const record = JsonObjectDecoder.decode(value);
    if (!record) return value;
    const stripped: JsonObjectConstruction = {};
    for (const [key, item] of Object.entries(record)) {
        if (record.type === "input_image" && key === "detail") continue;
        stripped[key] = item === undefined ? undefined : stripInputImageDetail(item);
    }
    return stripped;
}

function isAdditionalToolsItem(value: JsonValue | undefined): boolean {
    return JsonObjectDecoder.decode(value)?.type === "additional_tools";
}

function omitJsonObjectKeys(object: JsonObject, excluded: ReadonlySet<string>): JsonObject {
    const filtered: JsonObjectConstruction = {};
    for (const [key, value] of Object.entries(object)) {
        if (!excluded.has(key)) filtered[key] = value;
    }
    return filtered;
}
