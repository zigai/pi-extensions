import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Message, Tool } from "@earendil-works/pi-ai";
import type { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { getDeclaredTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
    buildSessionProjection,
    convertToLlm,
    getPackageDir,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isModelWithStringApi } from "../codex/auth.ts";
import { compileSchema } from "../schema-parsing.ts";
import { NATIVE_COMPACTION_SHIM_SUMMARY } from "./messages.ts";
import type {
    BuildPromptInputResult,
    FoundNativeCompactionEntry,
    JsonObject,
    JsonValue,
    ResponsesInputItem,
    ResponsesPayload,
} from "./types.ts";

const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const HostProviderModulesDecoder = compileSchema(
    Type.Tuple([
        Type.Object({
            convertResponsesMessages: Type.Unsafe<typeof convertResponsesMessages>(
                Type.Function([], Type.Unknown()),
            ),
        }),
        Type.Object({
            createGrammarToolInputProperties: Type.Unsafe<typeof createGrammarToolInputProperties>(
                Type.Function([], Type.Unknown()),
            ),
        }),
        Type.Object({
            getDeclaredTools: Type.Unsafe<typeof getDeclaredTools>(
                Type.Function([], Type.Unknown()),
            ),
            normalizeContext: Type.Unsafe<typeof normalizeContext>(
                Type.Function([], Type.Unknown()),
            ),
        }),
    ]),
);

const HostProviderManifestDecoder = compileSchema(
    Type.Object({
        exports: Type.Object({
            "./api/*": Type.Object({ import: Type.String() }),
            "./utils/*": Type.Object({ import: Type.String() }),
        }),
    }),
);
const hostPackageUrl = pathToFileURL(join(getPackageDir(), "package.json"));
const providerManifestPath = findPackageJSON("@earendil-works/pi-ai", hostPackageUrl);
if (providerManifestPath === undefined)
    throw new Error("The running Pi does not provide its AI package.");

const rawProviderManifest: unknown = JSON.parse(readFileSync(providerManifestPath, "utf8"));
const providerManifest = HostProviderManifestDecoder.decode(rawProviderManifest);
if (providerManifest === undefined)
    throw new Error("The running Pi does not export the required Responses transcript APIs.");

const providerPackageUrl = pathToFileURL(providerManifestPath);
const requireHost = createRequire(hostPackageUrl);
const hostModules = HostProviderModulesDecoder.decode([
    requireHost(
        fileURLToPath(
            new URL(
                providerManifest.exports["./api/*"].import.replace("*", "openai-responses-shared"),
                providerPackageUrl,
            ),
        ),
    ),
    requireHost(
        fileURLToPath(
            new URL(
                providerManifest.exports["./api/*"].import.replace("*", "constrained-sampling"),
                providerPackageUrl,
            ),
        ),
    ),
    requireHost(
        fileURLToPath(
            new URL(
                providerManifest.exports["./utils/*"].import.replace("*", "transcript"),
                providerPackageUrl,
            ),
        ),
    ),
]);
if (hostModules === undefined)
    throw new Error("The running Pi does not provide the required Responses transcript APIs.");

const [responsesApi, grammarApi, transcriptApi] = hostModules;

const JsonValueSchema = Type.Cyclic(
    {
        JsonValue: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Array(Type.Ref("JsonValue")),
            Type.Record(Type.String(), Type.Union([Type.Ref("JsonValue"), Type.Undefined()])),
        ]),
    },
    "JsonValue",
);
const JsonObjectSchema = Type.Record(
    Type.String(),
    Type.Union([JsonValueSchema, Type.Undefined()]),
);
export const JsonValueDecoder = compileSchema(JsonValueSchema);
export const JsonArrayDecoder = compileSchema(Type.Array(JsonValueSchema));
export const JsonObjectDecoder = compileSchema(JsonObjectSchema);
export const ResponsesPayloadDecoder = compileSchema(
    Type.Intersect([
        JsonObjectSchema,
        Type.Object({ model: Type.String(), input: Type.Array(JsonObjectSchema) }),
    ]),
);
const StringValidator = compileSchema(Type.String());
export const JsonStringDecoder = StringValidator;
export const JsonNumberDecoder = compileSchema(Type.Number());
const DetailedImageDecoder = compileSchema(
    Type.Object({
        type: Type.Literal("image"),
        data: Type.String(),
        mimeType: Type.String(),
        detail: Type.Union([Type.Literal("high"), Type.Literal("original")]),
    }),
);
const UnknownArrayValidator = compileSchema(Type.Array(Type.Unknown()));

export function buildRemoteCompactionPromptInput(
    event: SessionBeforeCompactEvent,
    model: ExtensionContext["model"] | undefined,
    latestNativeCompaction: FoundNativeCompactionEntry | undefined,
): BuildPromptInputResult {
    if (latestNativeCompaction) {
        return {
            input: [
                ...latestNativeCompaction.entry.details.compactedWindow,
                ...serializeEntriesToResponsesInput(
                    model,
                    event.branchEntries.slice(latestNativeCompaction.index + 1),
                    event.branchEntries,
                ),
            ],
            previousCompactionEntryId: latestNativeCompaction.entry.id,
        };
    }

    return {
        input: serializeEntriesToResponsesInput(model, event.branchEntries, event.branchEntries),
    };
}

export function serializeEntriesToResponsesInput(
    model: ExtensionContext["model"] | undefined,
    entries: readonly SessionEntry[],
    contextEntries: readonly SessionEntry[],
): ResponsesInputItem[] {
    const selectedIds = new Set(entries.map((entry) => entry.id));
    const projection = buildSessionProjection([...contextEntries]);
    const messages = convertToLlm(
        projection.entries
            .filter((entry) => selectedIds.has(entry.sourceEntry.id))
            .flatMap((entry) => entry.messages),
    );
    const declaredTools = transcriptApi.getDeclaredTools(convertToLlm(projection.messages));
    return serializeMessagesToResponsesInput(
        model,
        messages,
        entries[0]?.parentId === null,
        declaredTools,
    );
}

function serializeMessagesToResponsesInput(
    model: ExtensionContext["model"] | undefined,
    messages: Message[],
    initialTranscript: boolean,
    declaredTools: Tool[],
): ResponsesInputItem[] {
    if (!isModelWithStringApi(model)) {
        throw new Error("Codex compaction requires a registered Responses model.");
    }

    let transcriptMessages = messages;
    if (!initialTranscript) {
        transcriptMessages = [{ role: "system", content: "", timestamp: 0 }, ...messages];
    }

    const context = transcriptApi.normalizeContext({ messages: transcriptMessages });
    const compat = JsonObjectDecoder.decode(model.compat);
    const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools === true;
    const converted = responsesApi.convertResponsesMessages(
        model,
        context,
        CODEX_TOOL_CALL_PROVIDERS,
        {
            includeSystemPrompt: false,
            grammarToolInputProperties: grammarApi.createGrammarToolInputProperties(
                declaredTools,
                supportsOpenAIGrammarTools,
            ),
            supportsMidConvoSystemMessages: compat?.supportsMidConvoSystemMessages === true,
            supportsAdditionalTools: compat?.supportsAdditionalTools === true,
            supportsToolSearch: compat?.supportsToolSearch === true,
            toolOptions: {
                strict: null,
                supportsStrictMode: compat?.supportsStrictMode !== false,
                supportsOpenAIGrammarTools,
            },
        },
    );
    const input = parseResponsesInputItems(converted);
    if (!input) throw new Error("Pi produced an invalid Responses transcript.");

    const imageDetails = new Map<string, "high" | "original">();
    for (const message of messages) {
        const content = JsonArrayDecoder.decode(message.content);
        if (content === undefined) continue;

        for (const block of content) {
            const image = DetailedImageDecoder.decode(block);
            if (image !== undefined) {
                imageDetails.set(`data:${image.mimeType};base64,${image.data}`, image.detail);
            }
        }
    }

    if (imageDetails.size === 0) return input;
    return input.map((item) => restoreImageDetails(item, imageDetails));
}

function restoreImageDetails(
    item: ResponsesInputItem,
    imageDetails: ReadonlyMap<string, "high" | "original">,
): ResponsesInputItem {
    const result: Record<string, JsonValue | undefined> = {};
    for (const [key, value] of Object.entries(item)) {
        if (isJsonArray(value)) {
            result[key] = value.map((part) => {
                const object = JsonObjectDecoder.decode(part);
                if (object) return restoreImageDetails(object, imageDetails);
                return part;
            });
        } else {
            const object = JsonObjectDecoder.decode(value);
            if (object) result[key] = restoreImageDetails(object, imageDetails);
            else result[key] = value;
        }
    }

    const imageUrl = JsonStringDecoder.decode(item.image_url);
    if (item.type === "input_image" && imageUrl !== undefined) {
        const detail = imageDetails.get(imageUrl);
        if (detail !== undefined) result.detail = detail;
    }

    return result;
}

export function parseResponsesPayload(value: unknown): ResponsesPayload | undefined {
    return ResponsesPayloadDecoder.decode(value);
}

export function parseResponsesInputItems(value: unknown): ResponsesInputItem[] | undefined {
    const rawItems = UnknownArrayValidator.decode(value);
    if (rawItems === undefined) return undefined;

    const items: ResponsesInputItem[] = [];
    for (const item of rawItems) {
        const inputItem = parseJsonObject(item);
        if (!inputItem) return undefined;

        items.push(inputItem);
    }

    return items;
}

export function isInstructionItem(item: ResponsesInputItem | undefined): boolean {
    return item !== undefined && (item.role === "system" || item.role === "developer");
}

export function isRemoteCompactionOutputItem(
    item: ResponsesInputItem | undefined,
): item is ResponsesInputItem & { readonly encrypted_content: string } {
    return (
        item !== undefined &&
        (item.type === "compaction" || item.type === "compaction_summary") &&
        StringValidator.decode(item.encrypted_content) !== undefined
    );
}

export function itemContainsShimSummary(item: ResponsesInputItem): boolean {
    return textFromResponsesContent(item.content).includes(NATIVE_COMPACTION_SHIM_SUMMARY);
}

export function textFromResponsesContent(content: JsonValue | undefined): string {
    const textContent = StringValidator.decode(content);
    if (textContent !== undefined) return textContent;
    if (!isJsonArray(content)) return "";
    return content
        .flatMap((item) => {
            const text = parseJsonObject(item)?.text;
            const parsed = StringValidator.decode(text);
            return parsed === undefined ? [] : [parsed];
        })
        .join("\n");
}

export function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
    return Array.isArray(value);
}

export function sanitizeSurrogates(text: string): string {
    return text.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        "",
    );
}

function parseJsonObject(value: unknown): JsonObject | undefined {
    return JsonObjectDecoder.decode(value);
}
