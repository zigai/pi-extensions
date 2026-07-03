import { Type } from "typebox";

import { compileSchema, parseWithSchema } from "../schema-parsing.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { CodexCoreConfig } from "../config.ts";
import { codexToolProviderHeaders, resolveCodexToolProvider } from "../codex-auth.ts";
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
} from "../failures.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../runtime.ts";
import {
    imageContentToDataUrl,
    loadImageContent,
    prepareCodexPromptImageContent,
    recentImageContents,
    saveGeneratedImage,
} from "../image-content.ts";

export const IMAGEGEN_TOOL_NAME = "imagegen";

const IMAGEGEN_PARAMETERS = Type.Object({
    prompt: Type.String({ description: "Detailed image generation or edit instruction." }),
    referenced_image_paths: Type.Optional(
        Type.Array(Type.String(), { description: "Local image paths to edit." }),
    ),
    num_last_images_to_include: Type.Optional(
        Type.Number({ description: "Use the last N conversation images for editing, 1 to 5." }),
    ),
    images: Type.Optional(
        Type.Array(Type.String(), {
            description: "Compatibility alias for referenced_image_paths.",
        }),
    ),
    action: Type.Optional(
        Type.String({
            description: "Compatibility field; generation/edit is inferred from image inputs.",
        }),
    ),
});

const UnknownRecordSchema = compileSchema(Type.Record(Type.String(), Type.Unknown()));
const ImagegenResponseSchema = compileSchema(
    Type.Object({
        data: Type.Array(Type.Object({ b64_json: Type.Optional(Type.String()) })),
        background: Type.Optional(Type.String()),
        quality: Type.Optional(Type.String()),
        size: Type.Optional(Type.String()),
    }),
);

type ImagegenParams = {
    readonly prompt: string;
    readonly referenced_image_paths?: string[];
    readonly num_last_images_to_include?: number;
    readonly images?: string[];
    readonly action?: string;
};

type SavedImage = {
    readonly path: string;
    readonly absolutePath: string;
    readonly latestPath: string;
    readonly latestAbsolutePath: string;
};

type ImagegenDetails = {
    readonly images: readonly SavedImage[];
    readonly background?: string | undefined;
    readonly quality?: string | undefined;
    readonly size?: string | undefined;
};

type ImagegenOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly runtime?: CodexRuntime | undefined;
};

export function registerImagegenTool(pi: ExtensionAPI, options: ImagegenOptions): void {
    pi.registerTool(createImagegenTool(options));
}

export function createImagegenTool(
    options: ImagegenOptions,
): ToolDefinition<typeof IMAGEGEN_PARAMETERS, ImagegenDetails> {
    return {
        name: IMAGEGEN_TOOL_NAME,
        label: "Image Generation",
        description: "Generate images or edit local/recent images through Codex image generation.",
        promptSnippet: "Generate or edit images through Codex image generation.",
        promptGuidelines: [
            "Use imagegen directly when the user requests a new image or an image edit; do not ask for confirmation unless required source images are missing.",
            "Use imagegen referenced_image_paths for local image edits after inspecting unfamiliar images with view_image.",
        ],
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
            const count = images.length;
            const firstImage = images.at(0);
            const metadata = imagegenResultMetadata(result.details);
            let text = theme.fg("success", `Generated ${count} image${count === 1 ? "" : "s"}`);
            if (firstImage) text += theme.fg("dim", ` → ${firstImage.latestPath}`);
            if (metadata) text += theme.fg("dim", ` (${metadata})`);
            if (expanded) {
                for (const image of images) {
                    text += `\n${theme.fg("dim", `image: ${image.path}`)}`;
                    text += `\n${theme.fg("dim", `latest: ${image.latestPath}`)}`;
                }
            }
            return new Text(text, 0, 0);
        },
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            const config = options.getConfig();
            const editImages = await resolveEditImages(params, ctx);
            const response = await requestImageGeneration(
                params.prompt,
                editImages,
                config,
                ctx,
                signal,
                options.runtime ?? defaultCodexRuntime,
            );
            if (response.isErr()) throw codexFailureToError(response.error);
            const savedImages = await Promise.all(
                response.value.images.map((base64, index) =>
                    saveGeneratedImage({
                        sessionId: ctx.sessionManager.getSessionId(),
                        toolCallId,
                        index,
                        base64,
                    }),
                ),
            );
            const text = formatImagegenOutput(savedImages, response.value);
            return {
                content: [{ type: "text", text }],
                details: {
                    images: savedImages,
                    background: response.value.background,
                    quality: response.value.quality,
                    size: response.value.size,
                },
            };
        },
    };
}

export function prepareImagegenArguments(args: unknown): ImagegenParams {
    const input = parseWithSchema(UnknownRecordSchema, args);
    if (!input) throw new Error("Invalid imagegen arguments.");
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt.length === 0) throw new Error("imagegen requires a non-empty prompt.");
    const referencedPaths =
        parseOptionalStringArray(input.referenced_image_paths, "referenced_image_paths") ??
        parseOptionalStringArray(input.images, "images");
    const recentCount = parseOptionalNumber(
        input.num_last_images_to_include,
        "num_last_images_to_include",
    );
    const action = parseOptionalString(input.action, "action");
    return {
        prompt,
        ...(referencedPaths ? { referenced_image_paths: referencedPaths } : {}),
        ...(recentCount !== undefined ? { num_last_images_to_include: recentCount } : {}),
        ...(action ? { action } : {}),
    };
}

function summarizeImagegenOptions(args: ImagegenParams): string {
    const parts: string[] = [];
    const referencedPaths = args.referenced_image_paths ?? args.images ?? [];
    if (referencedPaths.length > 0) parts.push(`refs=${referencedPaths.length}`);
    if (args.num_last_images_to_include !== undefined)
        parts.push(`recent=${args.num_last_images_to_include}`);
    if (args.action) parts.push(`action=${args.action}`);
    return parts.join(" • ");
}

function imagegenResultMetadata(details: ImagegenDetails): string {
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
): Promise<ImageContent[]> {
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
            const image = await loadImageContent(path, ctx.cwd);
            editImages.push(await prepareCodexPromptImageContent(image));
        }
        return editImages;
    }
    if (params.num_last_images_to_include === undefined) return [];
    const count = Math.trunc(params.num_last_images_to_include);
    if (count < 1 || count > 5)
        throw new Error("num_last_images_to_include must be between 1 and 5.");
    const recent = recentImageContents(ctx, count);
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
    const provider = await resolveCodexToolProvider(ctx);
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
    try {
        response = await runtime.fetch(`${provider.value.baseUrl}/${path}`, {
            method: "POST",
            headers,
            ...(signal ? { signal } : {}),
            body: JSON.stringify(body),
        });
    } catch (cause: unknown) {
        if (isAbortCause(cause)) {
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

    const responseText = await response.text();
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
        rawImagePayload = JSON.parse(responseText) as unknown;
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

function parseImageResponse(value: unknown): CodexResult<{
    readonly images: readonly string[];
    readonly background?: string;
    readonly quality?: string;
    readonly size?: string;
}> {
    const response = parseWithSchema(ImagegenResponseSchema, value);
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
    return ok({
        images,
        ...(response.background ? { background: response.background } : {}),
        ...(response.quality ? { quality: response.quality } : {}),
        ...(response.size ? { size: response.size } : {}),
    });
}

function formatImagegenOutput(
    savedImages: readonly SavedImage[],
    response: { readonly background?: string; readonly quality?: string; readonly size?: string },
): string {
    const lines = ["Generated image output:"];
    for (const image of savedImages) {
        lines.push(`- image: ${image.path}`);
        lines.push(`- latest image: ${image.latestPath}`);
    }
    const metadata = [
        response.size ? `size=${response.size}` : undefined,
        response.quality ? `quality=${response.quality}` : undefined,
    ]
        .filter((item): item is string => Boolean(item))
        .join(", ");
    if (metadata) lines.push(`- ${metadata}`);
    return lines.join("\n");
}

function parseOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`imagegen ${fieldName} must be an array of strings.`);
    }
    return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseOptionalNumber(value: unknown, fieldName: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number") throw new Error(`imagegen ${fieldName} must be a number.`);
    return value;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`imagegen ${fieldName} must be a string.`);
    const text = value.trim();
    return text.length > 0 ? text : undefined;
}
