import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { codexModelRequestProfile, codexReasoningEffortForRequest } from "../codex/models.ts";
import { buildResponsesLitePrefix } from "../codex/responses-lite-prefix.ts";
import { imageDimensionsFromBytes } from "../images/metadata.ts";
import { CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY } from "../codex/responses-compat.ts";
import type { CodexCoreConfig } from "../config/config.ts";
import {
    isJsonArray,
    isRemoteCompactionOutputItem,
    JsonNumberDecoder,
    JsonObjectDecoder,
    JsonStringDecoder,
    JsonValueDecoder,
    sanitizeSurrogates,
    textFromResponsesContent,
} from "./responses-input.ts";
import type { CodexTokenizer } from "./tokenizer.ts";
import { NATIVE_COMPACTION_SHIM_SUMMARY } from "./messages.ts";
import type {
    JsonObject,
    JsonValue,
    RemoteCompactionPreflightResult,
    ProviderRequestTemplate,
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
const TRUNCATED_TOOL_OUTPUT_MESSAGE =
    "Output exceeded the available model context and was truncated";
const TOKEN_ESTIMATE_CHUNK_CHARS = 512 * 1024;
const TOKEN_ESTIMATE_CACHE_TEXT_MAX_CHARS = 8 * 1024;
const INLINE_IMAGE_TOKEN_ESTIMATE_TEXT = "(inline image data omitted for token estimate)";
const APPROX_BYTES_PER_TOKEN = 4;
const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const RESIZED_IMAGE_TOKEN_ESTIMATE = Math.ceil(
    RESIZED_IMAGE_BYTES_ESTIMATE / APPROX_BYTES_PER_TOKEN,
);
const ORIGINAL_IMAGE_PATCH_SIZE = 32;
const ORIGINAL_IMAGE_MAX_PATCHES = 10_000;
const StringValueSchema = JsonStringDecoder;

type CompactionReasoningResult = {
    readonly reasoning: RemoteCompactionReasoning;
};

type RemoteCompactionV2RequestConstruction = {
    -readonly [Key in keyof RemoteCompactionV2Request]: RemoteCompactionV2Request[Key];
};

type TokenWorkOptions = {
    readonly tokenizer: CodexTokenizer;
    readonly signal?: AbortSignal | undefined;
};

export function buildRemoteCompactionV2Request(input: {
    readonly sessionId: string;
    readonly model: string;
    readonly input: readonly ResponsesInputItem[];
    readonly instructions: string;
    readonly promptCacheKey: string;
    readonly verbosity: string;
    readonly fast: boolean;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
    readonly clientMetadata?: Readonly<Record<string, string>> | undefined;
    readonly requestTemplate?: ProviderRequestTemplate | undefined;
}): RemoteCompactionV2Request {
    const profile = codexModelRequestProfile(input.model);
    const requestTemplate = input.requestTemplate;
    const defaultEffort = profile?.defaultReasoningEffort;
    const defaultReasoning = profile?.useResponsesLite
        ? defaultEffort
            ? { effort: defaultEffort, context: "all_turns" as const }
            : { context: "all_turns" as const }
        : defaultEffort
          ? { effort: defaultEffort, summary: "auto" as const }
          : { summary: "auto" as const };
    const reasoning = input.reasoning ?? requestTemplate?.reasoning ?? defaultReasoning;
    const usePriorityServiceTier =
        (input.fast || requestTemplate?.serviceTier === "priority") &&
        (profile?.supportsPriorityServiceTier ?? true);
    const serviceTier = usePriorityServiceTier ? { service_tier: "priority" as const } : {};
    const tools = input.tools ?? requestTemplate?.tools;
    const promptCacheKey = requestTemplate?.promptCacheKey ?? input.promptCacheKey;
    const include = ["reasoning.encrypted_content"];
    const text = { verbosity: input.verbosity };
    const clientMetadata = { ...input.clientMetadata };
    if (profile?.useResponsesLite) {
        const instructions = sanitizeSurrogates(input.instructions);
        const [additionalToolsItem, ...instructionItems] = buildResponsesLitePrefix(
            input.sessionId,
            tools ?? [],
            instructions,
        );
        return {
            model: input.model,
            input: [
                buildLiteAdditionalToolsItem(requestTemplate, additionalToolsItem),
                ...buildLiteInstructionItems(requestTemplate, instructions, instructionItems),
                ...input.input.map((item) =>
                    stripResponsesLiteImageDetails(stripResponseItemId(item)),
                ),
                { type: "compaction_trigger" },
            ],
            tool_choice: "auto",
            parallel_tool_calls: false,
            store: false,
            stream: true,
            include,
            prompt_cache_key: promptCacheKey,
            text,
            ...serviceTier,
            reasoning,
            client_metadata: {
                ...clientMetadata,
                [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: "true",
            },
        };
    }
    const request: RemoteCompactionV2RequestConstruction = {
        model: input.model,
        instructions: sanitizeSurrogates(input.instructions),
        input: [...input.input.map(stripResponseItemId), { type: "compaction_trigger" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include,
        prompt_cache_key: promptCacheKey,
        text,
        ...serviceTier,
        reasoning,
    };
    if (tools && tools.length > 0) request.tools = tools;
    if (Object.keys(clientMetadata).length > 0) request.client_metadata = clientMetadata;
    return request;
}

function buildLiteAdditionalToolsItem(
    requestTemplate: ProviderRequestTemplate | undefined,
    generated: ResponsesInputItem,
): ResponsesInputItem {
    const base =
        requestTemplate?.layout === "responses-lite"
            ? requestTemplate.additionalToolsItem
            : undefined;
    if (base && JSON.stringify(base.tools) === JSON.stringify(generated.tools)) return base;
    return { ...base, ...generated };
}

function buildLiteInstructionItems(
    requestTemplate: ProviderRequestTemplate | undefined,
    instructions: string,
    generated: readonly ResponsesInputItem[],
): readonly ResponsesInputItem[] {
    if (instructions.length === 0) return [];
    if (
        requestTemplate?.layout === "responses-lite" &&
        requestTemplate.instructions === instructions &&
        requestTemplate.instructionItems
    ) {
        return requestTemplate.instructionItems;
    }
    return generated;
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
    return JsonValueDecoder.decode(value);
}

export async function rewriteRemoteCompactionToolOutputsForContextWindow(
    input: readonly ResponsesInputItem[],
    requestParts: RemoteCompactionRequestParts,
    contextWindow: number | null | undefined,
    cache: TokenEstimateCache,
    options: TokenWorkOptions,
): Promise<RemoteCompactionPreflightResult> {
    options.signal?.throwIfAborted();
    const request = buildRemoteCompactionV2Request({ ...requestParts, input });
    const estimatedTokensBefore =
        (await estimateRemoteCompactionRequestTokens(request, cache, options)) +
        Math.max(0, nestedInputImageTokenCount(input) - nestedInputImageTokenCount(request.input));
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
    options: TokenWorkOptions & {
        readonly imageBudgetInput?: readonly ResponsesInputItem[] | undefined;
    },
): Promise<ResponsesInputItem[]> {
    options.signal?.throwIfAborted();
    const retained = promptInput.filter(isRetainedRemoteCompactionMessage);
    const imageBudgetRetained = (options.imageBudgetInput ?? promptInput).filter(
        isRetainedRemoteCompactionMessage,
    );
    const truncated = await truncateRetainedMessages(
        retained,
        RETAINED_MESSAGE_TOKEN_BUDGET,
        cache,
        options,
        imageBudgetRetained.length === retained.length ? imageBudgetRetained : retained,
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
    imageBudgetItems: readonly ResponsesInputItem[],
): Promise<ResponsesInputItem[]> {
    let remaining = maxTokens;
    const retainedReversed: ResponsesInputItem[] = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (remaining <= 0) continue;
        const item = items[index];
        if (item === undefined) continue;
        const imageBudgetItem = imageBudgetItems[index] ?? item;
        const tokenCount = Math.max(
            1,
            await messageTextTokenCount(imageBudgetItem, cache, options),
        );
        if (tokenCount <= remaining) {
            retainedReversed.push(item);
            remaining -= tokenCount;
        } else {
            const truncated = await truncateMessageTextToTokenBudget(
                imageBudgetItem,
                remaining,
                cache,
                options,
            );
            if (truncated) {
                retainedReversed.push(
                    inputImageCount(item) > 0 && !hasInputImageDetail(item)
                        ? stripResponsesLiteImageDetails(truncated)
                        : truncated,
                );
            }
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
    if (!isJsonArray(content)) {
        const text = JsonStringDecoder.decode(content);
        return text === undefined ? 0 : estimateTextTokens(text, cache, options);
    }
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
    const object = JsonObjectDecoder.decode(part);
    const text = JsonStringDecoder.decode(object?.text);
    if (text !== undefined) return estimateTextTokens(text, cache, options);
    if (object?.type === "input_image") return inputImageTokenCount(object);
    return estimateTokenCount(part, cache, options);
}

function inputImageTokenCount(part: ResponsesInputItem): number {
    const imageUrl = StringValueSchema.decode(part.image_url);
    if (part.detail !== "original" || !imageUrl) return RESIZED_IMAGE_TOKEN_ESTIMATE;
    const dataUrl = parseBase64ImageDataUrl(imageUrl);
    if (!dataUrl) return RESIZED_IMAGE_TOKEN_ESTIMATE;
    try {
        const dimensions = imageDimensionsFromBytes(
            Buffer.from(dataUrl.base64, "base64"),
            dataUrl.mimeType,
        );
        const patchesWide = Math.ceil(dimensions.width / ORIGINAL_IMAGE_PATCH_SIZE);
        const patchesHigh = Math.ceil(dimensions.height / ORIGINAL_IMAGE_PATCH_SIZE);
        return Math.min(patchesWide * patchesHigh, ORIGINAL_IMAGE_MAX_PATCHES);
    } catch {
        return RESIZED_IMAGE_TOKEN_ESTIMATE;
    }
}

function parseBase64ImageDataUrl(
    imageUrl: string,
): { readonly mimeType: string; readonly base64: string } | undefined {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(imageUrl);
    const mimeType = match?.[1];
    const base64 = match?.[2];
    return mimeType && base64 ? { mimeType, base64 } : undefined;
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
    const textContent = JsonStringDecoder.decode(content);
    if (textContent !== undefined) {
        const text = await options.tokenizer.truncate(textContent, maxTokens, options);
        return text.length > 0 ? { ...cloned, content: text } : undefined;
    }
    if (!isJsonArray(content)) return cloned;

    let remaining = maxTokens;
    const retainedReversed: JsonValue[] = [];
    for (let index = content.length - 1; index >= 0; index -= 1) {
        const part = content[index];
        if (part === undefined) continue;
        const object = JsonObjectDecoder.decode(part);
        if (object?.type === "input_image") {
            const tokenCount = inputImageTokenCount(object);
            if (tokenCount <= remaining) {
                retainedReversed.push(object);
                remaining -= tokenCount;
            } else {
                // Do not backfill older content after an atomic image exhausts the boundary.
                remaining = 0;
            }
            continue;
        }
        if (remaining <= 0) continue;
        const partText = JsonStringDecoder.decode(object?.text);
        if (partText !== undefined) {
            const tokenCount = await estimateTextTokens(partText, cache, options);
            const text =
                tokenCount <= remaining
                    ? partText
                    : await options.tokenizer.truncate(partText, remaining, options);
            remaining -= Math.min(tokenCount, remaining);
            if (text.length > 0 && object !== undefined) retainedReversed.push({ ...object, text });
            continue;
        }
        const tokenCount = await estimateTokenCount(part, cache, options);
        if (tokenCount <= remaining) {
            retainedReversed.push(part);
            remaining -= tokenCount;
        } else {
            remaining = 0;
        }
    }
    if (retainedReversed.length === 0) return undefined;
    retainedReversed.reverse();
    return { ...cloned, content: retainedReversed };
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
): CompactionReasoningResult {
    const profile = codexModelRequestProfile(modelId);
    const configuredEffort = config.openai.compactionReasoning;
    const effort =
        configuredEffort === "current"
            ? profile?.defaultReasoningEffort
            : codexReasoningEffortForRequest(configuredEffort);
    if (profile?.useResponsesLite) {
        return { reasoning: effort ? { effort, context: "all_turns" } : { context: "all_turns" } };
    }
    return { reasoning: effort ? { effort, summary: "auto" } : { summary: "auto" } };
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
    const object = JsonObjectDecoder.decode(value);
    if (object !== undefined) return stripResponsesLiteJsonObject(object);
    return value;
}

function inputImageCount(item: ResponsesInputItem): number {
    const content = item.content;
    if (!isJsonArray(content)) return 0;
    return content.filter((part) => JsonObjectDecoder.decode(part)?.type === "input_image").length;
}

function hasInputImageDetail(item: ResponsesInputItem): boolean {
    const content = item.content;
    if (!isJsonArray(content)) return false;
    return content.some((part) => {
        const object = JsonObjectDecoder.decode(part);
        return object?.type === "input_image" && object.detail !== undefined;
    });
}

function compactRequestBudget(contextWindow: number | null | undefined): number | undefined {
    const parsed = JsonNumberDecoder.decode(contextWindow);
    return parsed === undefined || parsed <= 0
        ? undefined
        : Math.floor(parsed * COMPACTION_REQUEST_BUDGET_RATIO);
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
    const object = JsonObjectDecoder.decode(value) ?? (Array.isArray(value) ? value : undefined);
    if (cache && object !== undefined) {
        return cachedObjectTokenCount(object, cache, () => {
            const serialized = JSON.stringify(sanitizeForTokenEstimate(value)) ?? "";
            return estimateTextTokens(serialized, cache, options);
        });
    }
    const serialized =
        JsonStringDecoder.decode(value) ?? JSON.stringify(sanitizeForTokenEstimate(value)) ?? "";
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
    return cachedObjectTokenCount(item, cache, async () => {
        const serializedTokens = await estimateTokenParts(
            responsesInputItemTokenParts(item),
            cache,
            options,
        );
        return serializedTokens + nestedInputImageTokenCount(item);
    });
}

function* responsesInputItemTokenParts(item: ResponsesInputItem): Generator<string> {
    const output = JsonStringDecoder.decode(item.output);
    if (item.type === "function_call_output" && output !== undefined) {
        yield JSON.stringify(sanitizeForTokenEstimate({ ...item, output: "" })) ?? "";
        yield output;
        return;
    }
    yield JSON.stringify(sanitizeForTokenEstimate(item)) ?? "";
}

function nestedInputImageTokenCount(value: JsonValue | undefined): number {
    if (isJsonArray(value)) {
        let total = 0;
        for (const nested of value) total += nestedInputImageTokenCount(nested);
        return total;
    }
    const object = JsonObjectDecoder.decode(value);
    if (object === undefined) return 0;
    let total = object.type === "input_image" ? inputImageTokenCount(object) : 0;
    for (const nested of Object.values(object)) total += nestedInputImageTokenCount(nested);
    return total;
}

function sanitizeForTokenEstimate(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sanitizeForTokenEstimate);
    const object = JsonObjectDecoder.decode(value);
    if (object === undefined) return value;

    const next: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(object)) {
        if (nested === undefined) continue;
        next[key] =
            key === "image_url" && JsonStringDecoder.decode(nested)?.startsWith("data:") === true
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

async function cachedObjectTokenCount<Value extends object>(
    value: Value,
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
