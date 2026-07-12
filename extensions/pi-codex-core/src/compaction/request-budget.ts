import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

import { codexModelRequestProfile, codexReasoningEffortForRequest } from "../codex/models.ts";
import { CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY } from "../codex/responses-compat.ts";
import type { CodexCoreConfig } from "../config/config.ts";
import {
    isJsonArray,
    isRemoteCompactionOutputItem,
    sanitizeSurrogates,
    textFromResponsesContent,
} from "./responses-input.ts";
import type { CodexTokenizer } from "./tokenizer.ts";
import { NATIVE_COMPACTION_SHIM_SUMMARY } from "./messages.ts";
import type {
    JsonObject,
    JsonValue,
    RemoteCompactionPreflightResult,
    RemoteCompactionReasoning,
    RemoteCompactionRequestParts,
    RemoteCompactionV2Request,
    ResponsesInputItem,
    ResponsesTool,
    ShrinkRemoteCompactionRequestResult,
    TokenEstimateCache,
} from "./types.ts";

const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
const COMPACTION_REQUEST_BUDGET_RATIO = 0.8;
const TRUNCATED_TOOL_OUTPUT_MESSAGE = "[truncated]";
const TOKEN_ESTIMATE_CHUNK_CHARS = 512 * 1024;
const TOKEN_ESTIMATE_CACHE_TEXT_MAX_CHARS = 8 * 1024;
const INLINE_IMAGE_TOKEN_ESTIMATE_TEXT = "(inline image data omitted for token estimate)";

type TokenWorkOptions = {
    readonly tokenizer: CodexTokenizer;
    readonly signal?: AbortSignal | undefined;
};

export function buildRemoteCompactionV2Request(input: {
    readonly model: string;
    readonly input: readonly ResponsesInputItem[];
    readonly instructions: string;
    readonly promptCacheKey: string;
    readonly verbosity: string;
    readonly fast: boolean;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
    readonly clientMetadata?: Readonly<Record<string, string>> | undefined;
}): RemoteCompactionV2Request {
    const profile = codexModelRequestProfile(input.model);
    const serviceTier =
        input.fast && (profile?.supportsPriorityServiceTier ?? true)
            ? { service_tier: "priority" as const }
            : {};
    if (profile?.useResponsesLite) {
        const instructions = sanitizeSurrogates(input.instructions);
        return {
            model: input.model,
            input: [
                {
                    type: "additional_tools",
                    role: "developer",
                    tools: (input.tools ?? []).map((tool) => ({ ...tool })),
                },
                ...(instructions.length > 0
                    ? [
                          {
                              type: "message",
                              role: "developer",
                              content: [{ type: "input_text", text: instructions }],
                          },
                      ]
                    : []),
                ...input.input.map((item) =>
                    stripResponsesLiteImageDetails(stripResponseItemId(item)),
                ),
                { type: "compaction_trigger" },
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
            stream: true,
            include: input.reasoning ? ["reasoning.encrypted_content"] : [],
            prompt_cache_key: input.promptCacheKey,
            text: { verbosity: input.verbosity },
            ...serviceTier,
            ...(input.reasoning ? { reasoning: input.reasoning } : {}),
            client_metadata: {
                ...input.clientMetadata,
                [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
            },
        };
    }
    return {
        model: input.model,
        instructions: sanitizeSurrogates(input.instructions),
        input: [...input.input.map(stripResponseItemId), { type: "compaction_trigger" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: input.reasoning ? ["reasoning.encrypted_content"] : [],
        prompt_cache_key: input.promptCacheKey,
        text: { verbosity: input.verbosity },
        ...serviceTier,
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
        ...(input.clientMetadata ? { client_metadata: input.clientMetadata } : {}),
    };
}

export function buildCompactionTools(pi: ExtensionAPI): ResponsesTool[] | undefined {
    const activeToolNames = new Set(pi.getActiveTools());
    const tools = pi
        .getAllTools()
        .filter((tool) => activeToolNames.has(tool.name))
        .map(toolInfoToResponsesTool);
    return tools.length > 0 ? tools : undefined;
}

function toolInfoToResponsesTool(tool: ToolInfo): ResponsesTool {
    return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: parseToolParameterValue(tool.parameters) ?? {},
        strict: null,
    };
}

function parseToolParameterValue(value: unknown): JsonValue | undefined {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
        const items: JsonValue[] = [];
        for (const item of value) {
            const parsed = parseToolParameterValue(item);
            if (parsed === undefined) return undefined;
            items.push(parsed);
        }
        return items;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const record: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const nested: unknown = descriptor?.value;
        const parsed = parseToolParameterValue(nested);
        if (parsed === undefined) return undefined;
        record[key] = parsed;
    }
    return record;
}

function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function rewriteRemoteCompactionToolOutputsForContextWindow(
    input: readonly ResponsesInputItem[],
    requestParts: RemoteCompactionRequestParts,
    contextWindow: number | null | undefined,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<RemoteCompactionPreflightResult> {
    options.signal?.throwIfAborted();
    const estimatedTokensBefore = await estimateRemoteCompactionRequestTokens(
        buildRemoteCompactionV2Request({ ...requestParts, input }),
        cache,
        options,
    );
    const budgetTokens = compactRequestBudget(contextWindow);
    if (budgetTokens === undefined || estimatedTokensBefore <= budgetTokens) {
        return {
            input,
            rewrittenToolOutputs: 0,
            estimatedTokensBefore,
            estimatedTokensAfter: estimatedTokensBefore,
        };
    }

    const rewrittenInput = [...input];
    let rewrittenToolOutputs = 0;
    let estimatedTokensAfter = estimatedTokensBefore;
    for (
        let index = rewrittenInput.length - 1;
        index >= 0 && estimatedTokensAfter > budgetTokens;
        index -= 1
    ) {
        const item = rewrittenInput[index];
        if (!item || !isRewritableToolOutputItem(item)) continue;
        const rewrittenItem = rewriteToolOutputItem(item);
        rewrittenInput[index] = rewrittenItem;
        rewrittenToolOutputs += 1;
        const [beforeTokens, afterTokens] = await Promise.all([
            estimateResponsesInputItemTokens(item, cache, options),
            estimateResponsesInputItemTokens(rewrittenItem, cache, options),
        ]);
        estimatedTokensAfter += afterTokens - beforeTokens;
    }

    return {
        input: rewrittenToolOutputs === 0 ? input : rewrittenInput,
        rewrittenToolOutputs,
        estimatedTokensBefore,
        estimatedTokensAfter,
    };
}

export async function shrinkRemoteCompactionRequestForContextWindow(
    request: RemoteCompactionV2Request,
    contextWindow: number | null | undefined,
    cache: TokenEstimateCache,
    options: TokenWorkOptions & {
        readonly preflight?: RemoteCompactionPreflightResult | undefined;
    },
): Promise<ShrinkRemoteCompactionRequestResult> {
    options.signal?.throwIfAborted();
    const { preflight } = options;
    const budgetTokens = compactRequestBudget(contextWindow);
    const estimatedTokensBefore =
        preflight?.estimatedTokensBefore ??
        (await estimateRemoteCompactionRequestTokens(request, cache, options));
    let rewrittenToolOutputs = preflight?.rewrittenToolOutputs ?? 0;
    let estimatedTokensAfter = preflight?.estimatedTokensAfter ?? estimatedTokensBefore;
    const promptInput = request.input.filter((item) => item.type !== "compaction_trigger");
    if (budgetTokens === undefined || estimatedTokensAfter <= budgetTokens) {
        return {
            kind: "ok",
            request,
            promptInput,
            rewrittenToolOutputs,
            estimatedTokensBefore,
            estimatedTokensAfter,
            budgetTokens,
        };
    }

    const input = [...request.input];
    for (let index = 0; index < input.length && estimatedTokensAfter > budgetTokens; index += 1) {
        const item = input[index];
        if (!item || !isRewritableToolOutputItem(item)) continue;
        const rewrittenItem = rewriteToolOutputItem(item);
        input[index] = rewrittenItem;
        rewrittenToolOutputs += 1;
        const [beforeTokens, afterTokens] = await Promise.all([
            estimateResponsesInputItemTokens(item, cache, options),
            estimateResponsesInputItemTokens(rewrittenItem, cache, options),
        ]);
        estimatedTokensAfter += afterTokens - beforeTokens;
    }

    if (estimatedTokensAfter > budgetTokens) {
        return {
            kind: "too_large",
            rewrittenToolOutputs,
            estimatedTokensBefore,
            estimatedTokensAfter,
            budgetTokens,
        };
    }

    const shrunkRequest = { ...request, input };
    return {
        kind: "ok",
        request: shrunkRequest,
        promptInput: shrunkRequest.input.filter((item) => item.type !== "compaction_trigger"),
        rewrittenToolOutputs,
        estimatedTokensBefore,
        estimatedTokensAfter,
        budgetTokens,
    };
}

export async function buildRemoteCompactionV2Window(
    promptInput: readonly ResponsesInputItem[],
    compactionOutput: ResponsesInputItem,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<ResponsesInputItem[]> {
    options.signal?.throwIfAborted();
    const retained = promptInput.filter(isRetainedRemoteCompactionMessage);
    const truncated = await truncateRetainedMessages(
        retained,
        RETAINED_MESSAGE_TOKEN_BUDGET,
        cache,
        options,
    );
    return [...truncated, compactionOutput];
}

function isRetainedRemoteCompactionMessage(item: ResponsesInputItem): boolean {
    if (item.role !== "user") return false;
    const text = textFromResponsesContent(item.content).trim();
    if (text.includes(NATIVE_COMPACTION_SHIM_SUMMARY)) return false;
    if (/^<environment_context>[\s\S]*<\/environment_context>$/i.test(text)) return false;
    if (/^Previous compaction summary:/i.test(text)) return false;
    if (/^The conversation history before this point was compacted/i.test(text)) return false;
    return text.length > 0 || inputImageCount(item) > 0;
}

async function truncateRetainedMessages(
    items: readonly ResponsesInputItem[],
    maxTokens: number,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<ResponsesInputItem[]> {
    let remaining = maxTokens;
    const retainedReversed: ResponsesInputItem[] = [];
    for (const item of [...items].reverse()) {
        if (remaining <= 0) continue;
        const tokenCount = Math.max(1, await messageTextTokenCount(item, cache, options));
        if (tokenCount <= remaining) {
            retainedReversed.push(item);
            remaining -= tokenCount;
        } else {
            const truncated = await truncateMessageTextToTokenBudget(
                item,
                remaining,
                cache,
                options,
            );
            if (truncated) retainedReversed.push(truncated);
            remaining = 0;
        }
    }
    return retainedReversed.reverse();
}

async function messageTextTokenCount(
    item: ResponsesInputItem,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<number> {
    const content = item.content;
    if (!isJsonArray(content))
        return typeof content === "string" ? estimateTextTokens(content, cache, options) : 0;
    let tokenCount = 0;
    for (const part of content) {
        tokenCount += await retainedContentPartTokenCount(part, cache, options);
    }
    return tokenCount;
}

async function retainedContentPartTokenCount(
    part: JsonValue,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<number> {
    if (isResponsesTextPart(part)) return estimateTextTokens(part.text, cache, options);
    if (isInputImagePart(part)) return 0;
    return estimateTokenCount(part, cache, options);
}

function isResponsesTextPart(
    part: JsonValue,
): part is ResponsesInputItem & { readonly text: string } {
    return isJsonObjectValue(part) && typeof part.text === "string";
}

function isInputImagePart(
    part: JsonValue,
): part is ResponsesInputItem & { readonly type: "input_image" } {
    return isJsonObjectValue(part) && part.type === "input_image";
}

async function truncateMessageTextToTokenBudget(
    item: ResponsesInputItem,
    maxTokens: number,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<ResponsesInputItem | undefined> {
    if (maxTokens <= 0) return undefined;
    const cloned = structuredClone(item);
    const content = cloned.content;
    if (typeof content === "string") {
        const text = await options.tokenizer.truncate(content, maxTokens, options);
        return text.length > 0 ? { ...cloned, content: text } : undefined;
    }
    if (!isJsonArray(content)) return cloned;

    let remaining = maxTokens;
    const nextContent: JsonValue[] = [];
    for (const part of content) {
        if (isInputImagePart(part)) {
            nextContent.push(part);
            continue;
        }
        if (remaining <= 0) continue;
        if (isResponsesTextPart(part)) {
            const tokenCount = await estimateTextTokens(part.text, cache, options);
            const text =
                tokenCount <= remaining
                    ? part.text
                    : await options.tokenizer.truncate(part.text, remaining, options);
            remaining -= Math.min(tokenCount, remaining);
            if (text.length > 0) nextContent.push({ ...part, text });
            continue;
        }
        const tokenCount = await estimateTokenCount(part, cache, options);
        if (tokenCount <= remaining) {
            nextContent.push(part);
            remaining -= tokenCount;
        }
    }
    if (nextContent.length === 0) return undefined;
    return { ...cloned, content: nextContent };
}

export function hasCompactionOutputItem(compactedWindow: readonly ResponsesInputItem[]): boolean {
    return compactedWindow.some(isRemoteCompactionOutputItem);
}

export function buildCompactionInstructions(
    systemPrompt: string,
    customInstructions?: string,
): string {
    const guidance = customInstructions?.trim();
    return guidance
        ? `${systemPrompt}\n\nAdditional user guidance for this manual /compact request:\n${guidance}`
        : systemPrompt;
}

export function buildReasoning(
    config: CodexCoreConfig,
    modelId: string,
): { readonly reasoning?: RemoteCompactionReasoning } {
    const profile = codexModelRequestProfile(modelId);
    const configuredEffort = config.openai.compactionReasoning;
    const effort =
        configuredEffort === "current"
            ? profile?.defaultReasoningEffort
            : codexReasoningEffortForRequest(configuredEffort);
    if (!effort) return {};
    return profile?.useResponsesLite
        ? { reasoning: { effort, context: "all_turns" } }
        : { reasoning: { effort, summary: "auto" } };
}

export function resolveCompactionTargetModel(
    ctx: ExtensionContext,
    modelId: string,
): ExtensionContext["model"] | undefined {
    if (ctx.model?.provider === "openai-codex" && ctx.model.id === modelId) return ctx.model;
    return ctx.modelRegistry.find?.("openai-codex", modelId);
}

function stripResponsesLiteImageDetails(item: ResponsesInputItem): ResponsesInputItem {
    return stripResponsesLiteJsonObject(item);
}

function stripResponseItemId(item: ResponsesInputItem): ResponsesInputItem {
    return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id"));
}

function stripResponsesLiteJsonObject(value: JsonObject): JsonObject {
    const rewritten: Record<string, JsonValue | undefined> = {};
    for (const [key, item] of Object.entries(value)) {
        if (value.type === "input_image" && key === "detail") continue;
        rewritten[key] = stripResponsesLiteJsonValue(item);
    }
    return rewritten;
}

function stripResponsesLiteJsonValue(value: JsonValue | undefined): JsonValue | undefined {
    if (isJsonArray(value)) return value.map((item) => stripResponsesLiteJsonValue(item) ?? null);
    if (isJsonObjectValue(value)) return stripResponsesLiteJsonObject(value);
    return value;
}

function inputImageCount(item: ResponsesInputItem): number {
    const content = item.content;
    if (!isJsonArray(content)) return 0;
    return content.filter((part) => isJsonObjectValue(part) && part.type === "input_image").length;
}

function compactRequestBudget(contextWindow: number | null | undefined): number | undefined {
    if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0)
        return undefined;
    return Math.floor(contextWindow * COMPACTION_REQUEST_BUDGET_RATIO);
}

function isRewritableToolOutputItem(item: ResponsesInputItem): boolean {
    return item.type === "function_call_output" && item.output !== TRUNCATED_TOOL_OUTPUT_MESSAGE;
}

function rewriteToolOutputItem(item: ResponsesInputItem): ResponsesInputItem {
    return { ...item, output: TRUNCATED_TOOL_OUTPUT_MESSAGE };
}

export function createTokenEstimateCache(): TokenEstimateCache {
    return { objectTokens: new WeakMap(), textTokens: new Map() };
}

function estimateTokenCount(
    value: JsonValue,
    cache: TokenEstimateCache | undefined,
    options: TokenWorkOptions,
): Promise<number> {
    if (cache && typeof value === "object" && value !== null) {
        return cachedObjectTokenCount(value, cache, () => {
            const serialized = JSON.stringify(sanitizeForTokenEstimate(value)) ?? "";
            return estimateTextTokens(serialized, cache, options);
        });
    }
    const serialized =
        typeof value === "string" ? value : (JSON.stringify(sanitizeForTokenEstimate(value)) ?? "");
    return estimateTextTokens(serialized, cache, options);
}

async function estimateRemoteCompactionRequestTokens(
    request: RemoteCompactionV2Request,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<number> {
    let total = await estimateTextTokens(
        JSON.stringify({ ...request, input: [] }) ?? "",
        cache,
        options,
    );
    for (const item of request.input) {
        total += await estimateResponsesInputItemTokens(item, cache, options);
    }
    return total;
}

async function estimateResponsesInputItemTokens(
    item: ResponsesInputItem,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<number> {
    return cachedObjectTokenCount(item, cache, () =>
        estimateTokenParts(responsesInputItemTokenParts(item), cache, options),
    );
}

function* responsesInputItemTokenParts(item: ResponsesInputItem): Generator<string> {
    if (item.type === "function_call_output" && typeof item.output === "string") {
        yield JSON.stringify(sanitizeForTokenEstimate({ ...item, output: "" })) ?? "";
        yield item.output;
        return;
    }
    yield JSON.stringify(sanitizeForTokenEstimate(item)) ?? "";
}

function sanitizeForTokenEstimate(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sanitizeForTokenEstimate);
    if (typeof value !== "object" || value === null) return value;

    const next: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
        if (nested === undefined) continue;
        next[key] =
            key === "image_url" && typeof nested === "string" && nested.startsWith("data:")
                ? INLINE_IMAGE_TOKEN_ESTIMATE_TEXT
                : sanitizeForTokenEstimate(nested);
    }
    return next;
}

async function estimateTokenParts(
    parts: Iterable<string>,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<number> {
    let total = 0;
    let chunk = "";
    for (const part of parts) {
        if (part.length >= TOKEN_ESTIMATE_CHUNK_CHARS) {
            if (chunk.length > 0) {
                total += await estimateTextTokens(chunk, cache, options);
                chunk = "";
            }
            total += await estimateTextTokens(part, cache, options);
            continue;
        }
        if (chunk.length + part.length > TOKEN_ESTIMATE_CHUNK_CHARS) {
            total += await estimateTextTokens(chunk, cache, options);
            chunk = "";
        }
        chunk += part;
    }
    return chunk.length > 0 ? total + (await estimateTextTokens(chunk, cache, options)) : total;
}

async function cachedObjectTokenCount(
    value: object,
    cache: TokenEstimateCache,
    compute: () => Promise<number>,
): Promise<number> {
    const cached = cache.objectTokens.get(value);
    if (cached !== undefined) return cached;
    const count = await compute();
    cache.objectTokens.set(value, count);
    return count;
}

async function estimateTextTokens(
    text: string,
    cache: TokenEstimateCache | undefined,
    options: TokenWorkOptions,
): Promise<number> {
    options.signal?.throwIfAborted();
    if (!cache || text.length > TOKEN_ESTIMATE_CACHE_TEXT_MAX_CHARS) {
        return options.tokenizer.count(text, options);
    }
    const cached = cache.textTokens.get(text);
    if (cached !== undefined) return cached;
    const count = await options.tokenizer.count(text, options);
    cache.textTokens.set(text, count);
    return count;
}
