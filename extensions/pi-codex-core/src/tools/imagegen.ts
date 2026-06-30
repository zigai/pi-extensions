import { Type } from "typebox";
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
    imageContentToDataUrl,
    loadImageContent,
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
    readonly archivePath: string;
    readonly archiveAbsolutePath: string;
};

type ImagegenDetails = {
    readonly images: readonly SavedImage[];
    readonly background?: string | undefined;
    readonly quality?: string | undefined;
    readonly size?: string | undefined;
};

type ImagegenOptions = {
    readonly getConfig: () => CodexCoreConfig;
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
                    text += `\n${theme.fg("dim", `archive: ${image.archivePath}`)}`;
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
            );
            const savedImages = await Promise.all(
                response.images.map((base64, index) =>
                    saveGeneratedImage({
                        sessionId: ctx.sessionManager.getSessionId(),
                        toolCallId,
                        index,
                        base64,
                    }),
                ),
            );
            const imageContent = response.images.map(
                (data): ImageContent => ({ type: "image", data, mimeType: "image/png" }),
            );
            const text = formatImagegenOutput(savedImages, response);
            return {
                content: [{ type: "text", text }, ...imageContent],
                details: {
                    images: savedImages,
                    background: response.background,
                    quality: response.quality,
                    size: response.size,
                },
            };
        },
    };
}

export function prepareImagegenArguments(args: unknown): ImagegenParams {
    if (!isRecord(args)) return { prompt: "" };
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const referencedPaths =
        parseStringArray(args.referenced_image_paths) ?? parseStringArray(args.images);
    const recentCount =
        typeof args.num_last_images_to_include === "number"
            ? args.num_last_images_to_include
            : undefined;
    const action = typeof args.action === "string" ? args.action : undefined;
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
        const loaded = await Promise.all(paths.map((path) => loadImageContent(path, ctx.cwd)));
        return loaded.map((image) => image.content);
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
): Promise<{
    readonly images: readonly string[];
    readonly background?: string;
    readonly quality?: string;
    readonly size?: string;
}> {
    const provider = await resolveCodexToolProvider(ctx);
    const headers = codexToolProviderHeaders(provider);
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

    const response = await fetch(`${provider.baseUrl}/${path}`, {
        method: "POST",
        headers,
        ...(signal ? { signal } : {}),
        body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok)
        throw new Error(
            `imagegen failed (${response.status}): ${responseText || response.statusText}`,
        );
    return parseImageResponse(JSON.parse(responseText) as unknown);
}

function parseImageResponse(value: unknown): {
    readonly images: readonly string[];
    readonly background?: string;
    readonly quality?: string;
    readonly size?: string;
} {
    if (!isRecord(value) || !Array.isArray(value.data))
        throw new Error("imagegen response did not contain image data.");
    const images = value.data.flatMap((item) =>
        isRecord(item) && typeof item.b64_json === "string" ? [item.b64_json] : [],
    );
    if (images.length === 0) throw new Error("imagegen returned no image data.");
    return {
        images,
        ...(typeof value.background === "string" ? { background: value.background } : {}),
        ...(typeof value.quality === "string" ? { quality: value.quality } : {}),
        ...(typeof value.size === "string" ? { size: value.size } : {}),
    };
}

function formatImagegenOutput(
    savedImages: readonly SavedImage[],
    response: { readonly background?: string; readonly quality?: string; readonly size?: string },
): string {
    const lines = ["Generated image output:"];
    for (const image of savedImages) {
        lines.push(`- image: ${image.path}`);
        lines.push(`- latest image: ${image.latestPath}`);
        lines.push(`- Codex-style archive: ${image.archivePath}`);
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

function parseStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const strings = value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    return strings.length > 0 ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
