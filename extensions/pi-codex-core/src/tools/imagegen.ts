import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "typebox";

import { compileSchema } from "../schema-parsing.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { CodexCoreConfig } from "../config/config.ts";
import {
    codexToolProviderHeaders,
    resolveCodexToolProvider,
    type CodexToolProvider,
} from "../codex/auth.ts";
import { fetchTextWithRetries } from "../codex/http-retry.ts";
import { imageDetailMarker } from "../images/detail.ts";
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
} from "../codex/failures.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../runtime.ts";
import { imageContentToDataUrl, prepareCodexPromptImageContent } from "../images/codex-prompt.ts";
import {
    generatedPngContent,
    loadImageContent,
    normalizeImageReferencePath,
    saveGeneratedImage,
} from "../images/file-artifacts.ts";
import { recentImageContents } from "../images/recent-session.ts";
import { imagegenGlowupRendering } from "./imagegen-glowup-rendering.ts";

export const IMAGEGEN_TOOL_NAME = "imagegen";

const IMAGEGEN_DESCRIPTION_PATH = fileURLToPath(
    new URL("./imagegen-description.md", import.meta.url),
);
const CODEX_CODE_MODE_IMAGEGEN_GUIDANCE =
    "- imagegen needs a few minutes to finish. In code-mode, use the first-line @exec directive to give the initial call 120 seconds and the same yield for any waits that follow. Once it finishes, return the image with generatedImage(result).";
const PI_IMAGEGEN_GUIDANCE =
    "- imagegen may take a few minutes to finish. Wait for the tool result before continuing.";
let cachedImagegenDescription: string | undefined;

const IMAGEGEN_PARAMETERS = Type.Object(
    {
        prompt: Type.String({ description: "Detailed image generation or edit instruction." }),
        referenced_image_paths: Type.Optional(
            Type.Array(Type.String(), {
                maxItems: 5,
                description: "Local image paths to edit.",
            }),
        ),
        num_last_images_to_include: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: 5,
                description: "Use the last N conversation images for editing.",
            }),
        ),
    },
    { additionalProperties: false },
);

const ImagegenParametersValidator = compileSchema(IMAGEGEN_PARAMETERS);
const ImagegenResponseSchema = compileSchema(
    Type.Object({
        data: Type.Array(Type.Object({ b64_json: Type.Optional(Type.String()) })),
        background: Type.Optional(Type.String()),
        quality: Type.Optional(Type.String()),
        size: Type.Optional(Type.String()),
    }),
);

type ImagegenParams = Static<typeof IMAGEGEN_PARAMETERS>;

type ImageGenerationResponse = {
    readonly images: readonly string[];
    readonly background?: string;
    readonly quality?: string;
    readonly size?: string;
};

type ImageGenerationResponseConstruction = {
    -readonly [Key in keyof ImageGenerationResponse]: ImageGenerationResponse[Key];
};

type SavedImage = {
    readonly path: string;
    readonly absolutePath: string;
    readonly latestPath: string;
    readonly latestAbsolutePath: string;
};

type ImagegenDetails = {
    readonly images: readonly SavedImage[];
    readonly generatedCount: number;
    readonly saveErrors: readonly string[];
    readonly background?: string | undefined;
    readonly quality?: string | undefined;
    readonly size?: string | undefined;
};

type ImagegenOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly runtime?: CodexRuntime | undefined;
    readonly saveImage?: typeof saveGeneratedImage | undefined;
};

export function registerImagegenTool(pi: ExtensionAPI, options: ImagegenOptions): void {
    pi.registerTool(createImagegenTool(options));
}

export function createImagegenTool(options: ImagegenOptions): ToolDefinition<
    typeof IMAGEGEN_PARAMETERS,
    ImagegenDetails
> & {
    readonly glowupRendering: typeof imagegenGlowupRendering;
} {
    return {
        name: IMAGEGEN_TOOL_NAME,
        label: "Image Generation",
        description: readImagegenDescription(),
        promptSnippet: "Generate or edit images through Codex image generation.",
        promptGuidelines: [
            "Use imagegen for requested images and image edits; omit both image selectors for a new image.",
            "For edits, use referenced_image_paths when every target has a local path, and inspect unfamiliar local images with view_image first.",
            "Use num_last_images_to_include only when a target has no local path; choose the smallest count that includes every target, up to 5.",
            "Never provide both image selectors. If neither can include every target, ask the user to attach the missing images again.",
            "Generate directly without reconfirmation unless required images are missing. Always use imagegen for image editing unless the user explicitly requests another method.",
            "Generated images are already displayed to the user; do not render them again in the final response as Markdown images or file links.",
        ],
        glowupRendering: imagegenGlowupRendering,
        parameters: IMAGEGEN_PARAMETERS,
        prepareArguments: prepareImagegenArguments,
        renderCall(args, theme, _context) {
            const prompt = quoteDisplayText(args.prompt);
            const optionsSummary = summarizeImagegenOptions(args);
            let text =
                theme.fg("toolTitle", theme.bold("imagegen ")) +
                theme.fg(args.prompt ? "accent" : "dim", prompt);
            if (optionsSummary) text += `\n${theme.fg("dim", optionsSummary)}`;
            return new Text(text, 0, 0);
        },
        renderResult(result, { expanded, isPartial }, theme, _context) {
            if (isPartial) return new Text(theme.fg("warning", "Generating image..."), 0, 0);
            const images = result.details.images;
            const count = result.details.generatedCount;
            const firstImage = images.at(0);
            const metadata = imagegenMetadata(result.details);
            let text = theme.fg("success", `Generated ${count} image${count === 1 ? "" : "s"}`);
            if (firstImage) text += theme.fg("dim", ` → ${firstImage.latestPath}`);
            if (metadata) text += theme.fg("dim", ` (${metadata})`);
            if (expanded) {
                for (const image of images) {
                    text += `\n${theme.fg("dim", `image: ${image.path}`)}`;
                    text += `\n${theme.fg("dim", `latest: ${image.latestPath}`)}`;
                }
                for (const error of result.details.saveErrors) {
                    text += `\n${theme.fg("warning", `save warning: ${error}`)}`;
                }
            }
            return new Text(text, 0, 0);
        },
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            const config = options.getConfig();
            const editImages = await resolveEditImages(params, ctx, { signal });
            const response = await requestImageGeneration(
                params.prompt,
                editImages,
                config,
                ctx,
                signal,
                options.runtime ?? defaultCodexRuntime,
            );
            if (response.isErr()) throw codexFailureToError(response.error);
            const saveImage = options.saveImage ?? saveGeneratedImage;
            const savedImages: SavedImage[] = [];
            const saveErrors: string[] = [];
            const generatedImages = response.value.images.map(generatedPngContent);
            for (const [index, image] of generatedImages.entries()) {
                signal?.throwIfAborted();
                try {
                    savedImages.push(
                        await saveImage(
                            {
                                sessionId: ctx.sessionManager.getSessionId(),
                                toolCallId,
                                index,
                                base64: image.data,
                            },
                            { signal },
                        ),
                    );
                } catch (cause: unknown) {
                    if (signal?.aborted || isAbortCause(cause)) throw cause;
                    saveErrors.push(cause instanceof Error ? cause.message : String(cause));
                }
            }
            const text = formatImagegenOutput(savedImages, saveErrors, response.value);
            return {
                content: [
                    ...generatedImages,
                    { type: "text" as const, text: imageDetailMarker("original") },
                    ...(text ? [{ type: "text" as const, text }] : []),
                ],
                details: {
                    images: savedImages,
                    generatedCount: generatedImages.length,
                    saveErrors,
                    background: response.value.background,
                    quality: response.value.quality,
                    size: response.value.size,
                },
            };
        },
    };
}

function readImagegenDescription(): string {
    cachedImagegenDescription ??= readFileSync(IMAGEGEN_DESCRIPTION_PATH, "utf8")
        .trim()
        .replaceAll("`image_gen.imagegen`", "`imagegen`")
        .replace(CODEX_CODE_MODE_IMAGEGEN_GUIDANCE, PI_IMAGEGEN_GUIDANCE)
        .replaceAll("the `python` tool", "Python");
    return cachedImagegenDescription;
}

export function prepareImagegenArguments(args: unknown): ImagegenParams {
    const input = ImagegenParametersValidator.decode(args);
    if (!input) throw new Error("Invalid imagegen arguments.");
    const prompt = input.prompt.trim();
    if (prompt.length === 0) throw new Error("imagegen requires a non-empty prompt.");
    const prepared: ImagegenParams = { prompt };
    if (input.referenced_image_paths) {
        prepared.referenced_image_paths = input.referenced_image_paths.map(
            normalizeImageReferencePath,
        );
    }
    if (input.num_last_images_to_include !== undefined) {
        prepared.num_last_images_to_include = input.num_last_images_to_include;
    }
    return prepared;
}

function summarizeImagegenOptions(args: ImagegenParams): string {
    const parts: string[] = [];
    const referencedPaths = args.referenced_image_paths ?? [];
    if (referencedPaths.length > 0) parts.push(`refs=${referencedPaths.length}`);
    if (args.num_last_images_to_include !== undefined)
        parts.push(`recent=${args.num_last_images_to_include}`);
    return parts.join(" • ");
}

function imagegenMetadata(details: {
    readonly size?: string | undefined;
    readonly quality?: string | undefined;
}): string {
    return [
        details.size ? `size=${details.size}` : undefined,
        details.quality ? `quality=${details.quality}` : undefined,
    ]
        .filter((item): item is string => Boolean(item))
        .join(", ");
}

function quoteDisplayText(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return JSON.stringify(normalized || "...");
}

async function resolveEditImages(
    params: ImagegenParams,
    ctx: ExtensionContext,
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<ImageContent[]> {
    options.signal?.throwIfAborted();
    const paths = params.referenced_image_paths ?? [];
    if (paths.length > 0 && params.num_last_images_to_include !== undefined) {
        throw new Error(
            "Provide only one of referenced_image_paths or num_last_images_to_include.",
        );
    }
    if (paths.length > 5) throw new Error("imagegen supports at most 5 edit images.");
    if (paths.length > 0) {
        const editImages: ImageContent[] = [];
        for (const path of paths) {
            options.signal?.throwIfAborted();
            const image = await loadImageContent(path, ctx.cwd, {
                ...options,
                allowOutsideWorkspace: true,
            });
            editImages.push(await prepareCodexPromptImageContent(image, "original", options));
        }
        return editImages;
    }
    if (params.num_last_images_to_include === undefined) return [];
    const count = Math.trunc(params.num_last_images_to_include);
    if (count < 1 || count > 5)
        throw new Error("num_last_images_to_include must be between 1 and 5.");
    const recent = await recentImageContents(ctx, count, options);
    if (recent.length !== count)
        throw new Error(`Requested ${count} recent image(s), but only found ${recent.length}.`);
    return recent;
}

async function requestImageGeneration(
    prompt: string,
    editImages: readonly ImageContent[],
    config: CodexCoreConfig,
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    runtime: CodexRuntime,
): Promise<
    CodexResult<{
        readonly images: readonly string[];
        readonly background?: string;
        readonly quality?: string;
        readonly size?: string;
    }>
> {
    const provider = await resolveImageGenerationProvider(ctx);
    if (provider.isErr()) return provider;
    const headers = codexToolProviderHeaders(provider.value);
    headers.set("accept", "application/json");
    const isEdit = editImages.length > 0;
    const path = isEdit ? "images/edits" : "images/generations";
    const body = isEdit
        ? {
              images: editImages.map((image) => ({ image_url: imageContentToDataUrl(image) })),
              prompt,
              background: "auto",
              model: config.openai.imageModel,
              quality: "auto",
              size: "auto",
          }
        : {
              prompt,
              background: "auto",
              model: config.openai.imageModel,
              quality: "auto",
              size: "auto",
          };

    let response: Response;
    let responseText: string;
    try {
        const fetched = await fetchTextWithRetries(
            runtime,
            `${provider.value.baseUrl}/${path}`,
            { method: "POST", headers, body: JSON.stringify(body) },
            { signal },
        );
        response = fetched.response;
        responseText = fetched.text;
    } catch (cause: unknown) {
        if (isAbortCause(cause) || signal?.aborted) {
            return fail(
                new CodexRequestCancelled({
                    operation: "imagegen",
                    message: "imagegen request was cancelled.",
                    cause,
                }),
            );
        }
        return fail(
            new CodexNetworkUnavailable({
                operation: "imagegen",
                provider: "openai-codex",
                message: "imagegen network request failed.",
                cause,
            }),
        );
    }

    if (!response.ok) {
        return fail(
            new CodexHttpRequestFailed({
                operation: "imagegen",
                provider: "openai-codex",
                status: response.status,
                message: `imagegen failed with HTTP ${response.status}.`,
            }),
        );
    }
    let rawImagePayload: unknown;
    try {
        rawImagePayload = JSON.parse(responseText);
    } catch (cause: unknown) {
        return fail(
            new CodexInvalidJson({
                operation: "imagegen",
                provider: "openai-codex",
                message: "imagegen response was not valid JSON.",
                cause,
            }),
        );
    }
    return parseImageResponse(rawImagePayload);
}

async function resolveImageGenerationProvider(
    ctx: ExtensionContext,
): Promise<CodexResult<CodexToolProvider>> {
    if (
        String(ctx.model?.api ?? "")
            .toLowerCase()
            .includes("responses")
    ) {
        const activeProvider = await resolveCodexToolProvider(ctx, { useActiveModel: true });
        if (activeProvider.isOk()) return activeProvider;
    }
    return resolveCodexToolProvider(ctx);
}

function parseImageResponse(value: unknown): CodexResult<ImageGenerationResponse> {
    const response = ImagegenResponseSchema.decode(value);
    if (!response) {
        return fail(
            new CodexUnexpectedResponse({
                operation: "imagegen",
                provider: "openai-codex",
                message: "imagegen response did not contain image data.",
            }),
        );
    }
    const images = response.data.flatMap((item) => (item.b64_json ? [item.b64_json] : []));
    if (images.length === 0) {
        return fail(
            new CodexUnexpectedResponse({
                operation: "imagegen",
                provider: "openai-codex",
                message: "imagegen returned no image data.",
            }),
        );
    }
    const imageResponse: ImageGenerationResponseConstruction = { images };
    if (response.background) imageResponse.background = response.background;
    if (response.quality) imageResponse.quality = response.quality;
    if (response.size) imageResponse.size = response.size;
    return ok(imageResponse);
}

function formatImagegenOutput(
    savedImages: readonly SavedImage[],
    saveErrors: readonly string[],
    response: { readonly background?: string; readonly quality?: string; readonly size?: string },
): string {
    const lines: string[] = [];
    if (savedImages.length > 0) lines.push("Generated image output:");
    for (const image of savedImages) {
        lines.push(`- image: ${image.path}`);
        lines.push(`- latest image: ${image.latestPath}`);
    }
    for (const error of saveErrors) lines.push(`- save warning: ${error}`);
    const metadata = imagegenMetadata(response);
    if (metadata) lines.push(`- ${metadata}`);
    return lines.join("\n");
}
