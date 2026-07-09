import { Type } from "typebox";

import { codexModelRequestProfile, codexReasoningEffortForRequest } from "./codex-models.ts";
import { compileSchema, parseWithSchema } from "./schema-parsing.ts";

export const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY =
    "ws_request_header_x_openai_internal_codex_responses_lite";

const UnknownRecordSchema = compileSchema(Type.Record(Type.String(), Type.Unknown()));

/** Rewrites a GPT-5.6 Responses payload to the Responses Lite wire layout. */
export function rewriteCodexResponsesPayload(
    payload: unknown,
    expectedModelId?: string,
): Record<string, unknown> | undefined {
    const request = parseWithSchema(UnknownRecordSchema, payload);
    if (!request || typeof request.model !== "string" || !Array.isArray(request.input)) {
        return undefined;
    }
    if (expectedModelId !== undefined && request.model !== expectedModelId) return undefined;

    const profile = codexModelRequestProfile(request.model);
    if (!profile?.useResponsesLite) return undefined;

    const rewrittenInput = request.input.map(stripInputImageDetail);
    const alreadyUsesLiteLayout = isAdditionalToolsItem(rewrittenInput[0]);
    const tools = Array.isArray(request.tools) ? request.tools : [];
    const instructions = typeof request.instructions === "string" ? request.instructions : "";
    const input = alreadyUsesLiteLayout
        ? rewrittenInput
        : [
              { type: "additional_tools", role: "developer", tools },
              ...(instructions.length > 0
                  ? [
                        {
                            type: "message",
                            role: "developer",
                            content: [{ type: "input_text", text: instructions }],
                        },
                    ]
                  : []),
              ...rewrittenInput,
          ];
    const clientMetadata = parseWithSchema(UnknownRecordSchema, request.client_metadata) ?? {};
    const reasoning = responsesLiteReasoning(request.reasoning, profile.defaultReasoningEffort);

    const rewritten = Object.fromEntries(
        Object.entries(request).filter(
            ([key]) =>
                key !== "instructions" &&
                key !== "tools" &&
                key !== "input" &&
                key !== "parallel_tool_calls" &&
                key !== "reasoning" &&
                key !== "client_metadata" &&
                key !== "service_tier",
        ),
    );
    return {
        ...rewritten,
        input,
        parallel_tool_calls: false,
        reasoning,
        client_metadata: {
            ...clientMetadata,
            [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
        },
        ...(request.service_tier === "priority" ? { service_tier: "priority" } : {}),
    };
}

function responsesLiteReasoning(
    value: unknown,
    defaultEffort: string | undefined,
): Record<string, unknown> {
    const current = parseWithSchema(UnknownRecordSchema, value) ?? {};
    const effort =
        typeof current.effort === "string" && current.effort.trim().length > 0
            ? codexReasoningEffortForRequest(current.effort)
            : defaultEffort;
    const summary =
        typeof current.summary === "string" && current.summary !== "none"
            ? current.summary
            : undefined;
    const reasoning = Object.fromEntries(
        Object.entries(current).filter(
            ([key]) => key !== "effort" && key !== "summary" && key !== "context",
        ),
    );
    return {
        ...reasoning,
        ...(effort ? { effort } : {}),
        ...(summary ? { summary } : {}),
        context: "all_turns",
    };
}

function stripInputImageDetail(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripInputImageDetail);
    const record = parseWithSchema(UnknownRecordSchema, value);
    if (!record) return value;
    return Object.fromEntries(
        Object.entries(record)
            .filter(([key]) => record.type !== "input_image" || key !== "detail")
            .map(([key, item]) => [key, stripInputImageDetail(item)]),
    );
}

function isAdditionalToolsItem(value: unknown): boolean {
    const item = parseWithSchema(UnknownRecordSchema, value);
    return item?.type === "additional_tools";
}
