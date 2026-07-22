import { Type } from "typebox";

import { compileSchema, parseWithSchema } from "../../schema-parsing.ts";
import { StringEnum, type ImageContent } from "@earendil-works/pi-ai";
import {
    Container,
    getImageDimensions,
    Image,
    imageFallback,
    Spacer,
    Text,
    type Component,
} from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { defaultCapabilitiesProvider, type CapabilitiesProvider } from "./capabilities.ts";
import { resolveCodexRequestModel, type CodexCoreConfig } from "../../config/config.ts";
import {
    codexToolProviderHeaders,
    resolveCodexResponsesUrl,
    resolveCodexToolProvider,
} from "../../codex/auth.ts";
import {
    CodexHttpRequestFailed,
    CodexInvalidJson,
    CodexNetworkUnavailable,
    CodexRequestCancelled,
    CodexUnexpectedResponse,
    codexFailureToError,
    fail,
    isAbortCause,
    ok,
    type CodexResult,
} from "../../codex/failures.ts";
import {
    imageContentToDataUrl,
    modelSupportsImages,
    prepareCodexPromptImageContent,
    type ImageDetail,
} from "../../images/codex-prompt.ts";
import { loadImageContent, type LoadedImage } from "../../images/file-artifacts.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../../runtime.ts";
import {
    CODEX_RESPONSES_LITE_HEADER,
    rewriteCodexResponsesPayload,
} from "../../codex/responses-compat.ts";
import { codexModelRequestProfile } from "../../codex/models.ts";
import { fetchTextWithRetries } from "../../codex/http-retry.ts";
import { imageDetailMarker, isImageDetailMarker } from "../../images/detail.ts";
import { viewImageGlowupRendering } from "./glowup-rendering.ts";

const IMAGE_DESCRIPTION_PROMPT =
    "Describe this image in detail. Output only the image description, no other commentary.";

const ImageContentBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
);
const TextContentBlockSchema = compileSchema(
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
);
const ViewImageArgumentsSchema = compileSchema(
    Type.Object({
        path: Type.Optional(Type.String()),
        file_path: Type.Optional(Type.String()),
        image_path: Type.Optional(Type.String()),
        detail: Type.Optional(StringEnum(["high", "original"] as const)),
    }),
);
const DescriptionResponseSchema = compileSchema(
    Type.Object({
        output_text: Type.Optional(Type.String()),
        output: Type.Optional(
            Type.Array(
                Type.Object({
                    content: Type.Optional(
                        Type.Array(Type.Object({ text: Type.Optional(Type.String()) })),
                    ),
                }),
            ),
        ),
    }),
);

const VIEW_IMAGE_PARAMETERS = Type.Object(
    {
        path: Type.String({ description: "Local filesystem path to an image file." }),
        detail: Type.Optional(
            StringEnum(["high", "original"] as const, {
                description:
                    "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
            }),
        ),
    },
    { additionalProperties: false },
);

type ViewImageParams = {
    readonly path: string;
    readonly detail?: "high" | "original";
};

type ViewImageDetails = {
    readonly path: string;
    readonly absolutePath: string;
    readonly described: boolean;
    readonly mimeType?: string | undefined;
    readonly detail?: "high" | "original" | undefined;
};

type ViewImageRenderState = {
    preview?: ImageContent | null;
};

type ViewImageComponentFactory = (args: {
    readonly image: ImageContent;
    readonly path: string;
    readonly theme: { fg(color: "toolOutput", text: string): string };
}) => Component;

type ViewImageToolOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly runtime?: CodexRuntime | undefined;
    readonly capabilities?: CapabilitiesProvider | undefined;
    readonly imageComponentFactory?: ViewImageComponentFactory | undefined;
};

export const VIEW_IMAGE_TOOL_NAME = "view_image";

export function registerViewImageTool(pi: ExtensionAPI, options: ViewImageToolOptions): void {
    pi.registerTool(createViewImageTool(options));
}

export function createViewImageTool(options: ViewImageToolOptions): ToolDefinition<
    typeof VIEW_IMAGE_PARAMETERS,
    ViewImageDetails,
    ViewImageRenderState
> & {
    readonly glowupRendering: typeof viewImageGlowupRendering;
} {
    return {
        name: VIEW_IMAGE_TOOL_NAME,
        label: "View Image",
        description:
            "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk. For text-only models, Codex-generated descriptions can be enabled.",
        promptSnippet: "View a local image file by path.",
        promptGuidelines: [
            "Use view_image when the user asks to inspect a local image file; pass the path exactly and do not use it for text files.",
            "Use read for text files and as a fallback for image files when view_image is unavailable.",
        ],
        glowupRendering: viewImageGlowupRendering,
        parameters: VIEW_IMAGE_PARAMETERS,
        prepareArguments: prepareViewImageArguments,
        renderCall(args, theme, _context) {
            const parts = [args.path || "..."];
            if (args.detail) parts.push(`detail=${args.detail}`);
            const text =
                theme.fg("toolTitle", theme.bold("view_image ")) +
                theme.fg(args.path ? "accent" : "dim", parts.join(" • "));
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme, context) {
            if (isPartial) return new Text(theme.fg("warning", "Loading image..."), 0, 0);
            const path = result.details.path || context.args.path || "image";
            const displayedImage = firstImageContent(result.content);
            const capabilities = (
                options.capabilities ?? defaultCapabilitiesProvider
            ).getCapabilities();
            const lines: string[] = [];
            if (!displayedImage) lines.push(theme.fg("toolOutput", `Image saved at ${path}`));
            if (displayedImage && (!capabilities.images || !context.showImages)) {
                const dimensions =
                    getImageDimensions(displayedImage.data, displayedImage.mimeType) ?? undefined;
                lines.push(
                    theme.fg(
                        "toolOutput",
                        imageFallback(displayedImage.mimeType, dimensions, path),
                    ),
                );
            }
            const rawDescription = firstTextContent(result.content);
            const description =
                rawDescription && !isImageDetailMarker(rawDescription) ? rawDescription : undefined;
            if (description) {
                lines.push(
                    theme.fg("toolOutput", expanded ? description : compactText(description, 180)),
                );
            }
            if (!displayedImage || !capabilities.images || !context.showImages) {
                if (lines.length === 0) return new Container();
                return new Text(lines.join("\n"), 0, 0);
            }
            const container = new Container();
            if (lines.length > 0) {
                container.addChild(new Text(lines.join("\n"), 0, 0));
                container.addChild(new Spacer(1));
            }
            container.addChild(
                (options.imageComponentFactory ?? defaultViewImageComponentFactory)({
                    image: displayedImage,
                    path,
                    theme,
                }),
            );
            return container;
        },
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const image = await loadImageContent(params.path, ctx.cwd, {
                signal,
                allowOutsideWorkspace: true,
            });
            const detail = params.detail ?? "high";
            if (modelSupportsImages(ctx.model)) {
                if (
                    detail === "original" &&
                    codexModelRequestProfile(ctx.model?.id)?.supportsImageDetailOriginal !== true
                ) {
                    throw new Error(
                        `view_image detail "original" is not supported by ${ctx.model?.id ?? "the active model"}.`,
                    );
                }
                const content = await prepareCodexPromptImageContent(image, detail, { signal });
                return {
                    content: [content, { type: "text", text: imageDetailMarker(detail) }],
                    details: {
                        path: params.path,
                        absolutePath: image.absolutePath,
                        described: false,
                        mimeType: content.mimeType,
                        detail,
                    },
                };
            }

            const config = options.getConfig();
            if (!config.tools.viewImageDescriptions) {
                throw new Error(
                    "view_image requires an image-capable model, or enable /codex image descriptions.",
                );
            }

            const description = await describeImage(
                image,
                detail,
                ctx,
                config,
                signal,
                options.runtime ?? defaultCodexRuntime,
            );
            if (description.isErr()) throw codexFailureToError(description.error);
            return {
                content: [{ type: "text", text: description.value }],
                details: {
                    path: params.path,
                    absolutePath: image.absolutePath,
                    described: true,
                    mimeType: image.mimeType,
                    detail,
                },
            };
        },
    };
}

function defaultViewImageComponentFactory(args: {
    readonly image: ImageContent;
    readonly path: string;
    readonly theme: { fg(color: "toolOutput", text: string): string };
}): Component {
    return new Image(
        args.image.data,
        args.image.mimeType,
        { fallbackColor: (value: string) => args.theme.fg("toolOutput", value) },
        { maxWidthCells: 60, filename: args.path },
    );
}

export function prepareViewImageArguments(args: unknown): ViewImageParams {
    const input = parseWithSchema(ViewImageArgumentsSchema, args);
    if (!input) throw new Error("Invalid view_image arguments.");
    const path = input.path ?? input.file_path ?? input.image_path ?? "";
    if (path.trim().length === 0) throw new Error("view_image requires a path.");
    return input.detail ? { path, detail: input.detail } : { path };
}

type TextContentBlock = {
    readonly type: "text";
    readonly text: string;
};

function firstImageContent(content: readonly unknown[]): ImageContent | undefined {
    return content.find(isImageContentBlock);
}

function firstTextContent(content: readonly unknown[]): string | undefined {
    for (const item of content) {
        if (isTextContentBlock(item)) {
            const text = item.text.trim();
            if (text.length > 0) return text;
        }
    }
    return undefined;
}

function isImageContentBlock(value: unknown): value is ImageContent {
    return parseWithSchema(ImageContentBlockSchema, value) !== undefined;
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
    return parseWithSchema(TextContentBlockSchema, value) !== undefined;
}

function compactText(value: string, maxCharacters: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    const limit = Math.max(4, maxCharacters);
    return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

async function describeImage(
    image: LoadedImage,
    detail: ImageDetail,
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    signal: AbortSignal | undefined,
    runtime: CodexRuntime,
): Promise<CodexResult<string>> {
    const promptImage = await prepareCodexPromptImageContent(image, detail, { signal });
    const provider = await resolveCodexToolProvider(ctx);
    if (provider.isErr()) return provider;
    const headers = codexToolProviderHeaders(provider.value);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("accept", "application/json");

    const model = resolveCodexRequestModel(
        config.openai.imageDescriptionModel,
        provider.value.model,
    );
    if (codexModelRequestProfile(model)?.useResponsesLite) {
        headers.set(CODEX_RESPONSES_LITE_HEADER, "true");
    }

    const requestBody = {
        model,
        store: false,
        stream: false,
        instructions: IMAGE_DESCRIPTION_PROMPT,
        text: { verbosity: "low" },
        reasoning: { effort: "low", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        tool_choice: "auto",
        parallel_tool_calls: true,
        input: [
            {
                role: "user",
                content: [
                    { type: "input_text", text: "Describe the image." },
                    {
                        type: "input_image",
                        image_url: imageContentToDataUrl(promptImage),
                        detail,
                    },
                ],
            },
        ],
    };
    const compatibleRequestBody = rewriteCodexResponsesPayload(requestBody, model) ?? requestBody;

    let response: Response;
    let responseText: string;
    try {
        const fetched = await fetchTextWithRetries(
            runtime,
            resolveCodexResponsesUrl(provider.value.baseUrl),
            { method: "POST", headers, body: JSON.stringify(compatibleRequestBody) },
            { signal },
        );
        response = fetched.response;
        responseText = fetched.text;
    } catch (cause: unknown) {
        if (isAbortCause(cause) || signal?.aborted) {
            return fail(
                new CodexRequestCancelled({
                    operation: "viewImageDescription",
                    message: "view_image description request was cancelled.",
                    cause,
                }),
            );
        }
        return fail(
            new CodexNetworkUnavailable({
                operation: "viewImageDescription",
                provider: "openai-codex",
                message: "view_image description network request failed.",
                cause,
            }),
        );
    }

    if (!response.ok) {
        return fail(
            new CodexHttpRequestFailed({
                operation: "viewImageDescription",
                provider: "openai-codex",
                status: response.status,
                message: `view_image description failed with HTTP ${response.status}.`,
            }),
        );
    }
    let rawDescriptionPayload: unknown;
    try {
        rawDescriptionPayload = JSON.parse(responseText);
    } catch (cause: unknown) {
        return fail(
            new CodexInvalidJson({
                operation: "viewImageDescription",
                provider: "openai-codex",
                message: "view_image description response was not valid JSON.",
                cause,
            }),
        );
    }
    const description = extractOutputText(rawDescriptionPayload);
    if (!description) {
        return fail(
            new CodexUnexpectedResponse({
                operation: "viewImageDescription",
                provider: "openai-codex",
                message: "view_image description returned no text.",
            }),
        );
    }
    return ok(description);
}

function extractOutputText(value: unknown): string | undefined {
    const response = parseWithSchema(DescriptionResponseSchema, value);
    if (!response) return undefined;
    if (response.output_text && response.output_text.trim().length > 0)
        return response.output_text.trim();
    const parts: string[] = [];
    for (const item of response.output ?? []) {
        for (const content of item.content ?? []) {
            if (content.text) parts.push(content.text);
        }
    }
    const text = parts.join("").trim();
    return text.length > 0 ? text : undefined;
}
