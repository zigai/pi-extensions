import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { Type } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
    resizeImage,
    withFileMutationQueue,
    type ExtensionContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";

import { sanitizeArtifactPathPart } from "./artifacts.ts";
import { compileSchema, parseWithSchema } from "./schema-parsing.ts";

const ImageContentSchema = compileSchema(
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
);
const MessageWithArrayContentSchema = compileSchema(
    Type.Object({ content: Type.Array(Type.Unknown()) }),
);

export type ImageDetail = "auto" | "high" | "original";

export type LoadedImage = {
    readonly content: ImageContent;
    readonly absolutePath: string;
    readonly bytes: Buffer;
};

type ImageDimensions = {
    readonly width: number;
    readonly height: number;
};

type CodexPromptImageResizeLimits = {
    readonly maxDimension: number;
    readonly maxPatches: number;
};

const CODEX_PROMPT_IMAGE_PATCH_SIZE = 32;
const CODEX_PROMPT_IMAGE_MAX_BYTES = 1024 * 1024 * 1024;
const CODEX_HIGH_DETAIL_LIMITS: CodexPromptImageResizeLimits = {
    maxDimension: 2048,
    maxPatches: 2_500,
};
const CODEX_ORIGINAL_DETAIL_LIMITS: CodexPromptImageResizeLimits = {
    maxDimension: 6000,
    maxPatches: 10_000,
};

export async function loadImageContent(path: string, cwd: string): Promise<LoadedImage> {
    const absolutePath = resolve(cwd, stripAtPrefix(path));
    const bytes = await readFile(absolutePath);
    const mimeType = detectImageMimeType(bytes, absolutePath);
    if (!mimeType) throw new Error(`Unsupported image type: ${path}`);
    return {
        content: {
            type: "image",
            data: bytes.toString("base64"),
            mimeType,
        },
        absolutePath,
        bytes,
    };
}

export async function prepareCodexPromptImageContent(
    image: LoadedImage,
    detail: ImageDetail = "high",
): Promise<ImageContent> {
    const limits = codexPromptImageResizeLimits(detail);
    const dimensions = imageDimensions(image.content);
    const target = codexPromptImageTargetDimensions(dimensions.width, dimensions.height, limits);
    if (target.width === dimensions.width && target.height === dimensions.height) {
        return image.content;
    }

    const resized = await resizeImage(image.bytes, image.content.mimeType, {
        maxWidth: target.width,
        maxHeight: target.height,
        maxBytes: CODEX_PROMPT_IMAGE_MAX_BYTES,
    });
    if (!resized) throw new Error(`Unable to resize image for view_image: ${image.absolutePath}`);
    return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

export function codexPromptImageTargetDimensions(
    width: number,
    height: number,
    limits: CodexPromptImageResizeLimits = CODEX_HIGH_DETAIL_LIMITS,
): ImageDimensions {
    let targetWidth = Math.max(1, Math.floor(width));
    let targetHeight = Math.max(1, Math.floor(height));
    if (codexPromptImageDimensionsFit(targetWidth, targetHeight, limits)) {
        return { width: targetWidth, height: targetHeight };
    }

    const maxDimensionScale = Math.min(
        limits.maxDimension / Math.max(targetWidth, targetHeight),
        1,
    );
    targetWidth = Math.max(1, Math.round(targetWidth * maxDimensionScale));
    targetHeight = Math.max(1, Math.round(targetHeight * maxDimensionScale));
    if (codexPromptImageDimensionsFit(targetWidth, targetHeight, limits)) {
        return { width: targetWidth, height: targetHeight };
    }

    const patchSize = CODEX_PROMPT_IMAGE_PATCH_SIZE;
    let scale = Math.sqrt((patchSize * patchSize * limits.maxPatches) / targetWidth / targetHeight);
    const scaledPatchesWide = (targetWidth * scale) / patchSize;
    const scaledPatchesHigh = (targetHeight * scale) / patchSize;
    scale *= Math.min(
        Math.floor(scaledPatchesWide) / scaledPatchesWide,
        Math.floor(scaledPatchesHigh) / scaledPatchesHigh,
    );

    return {
        width: Math.max(1, Math.floor(targetWidth * scale)),
        height: Math.max(1, Math.floor(targetHeight * scale)),
    };
}

export async function saveGeneratedImage(args: {
    readonly cwd: string;
    readonly toolCallId: string;
    readonly index: number;
    readonly base64: string;
}): Promise<{
    readonly path: string;
    readonly absolutePath: string;
    readonly latestPath: string;
    readonly latestAbsolutePath: string;
}> {
    const fileName = `${sanitizeArtifactPathPart(args.toolCallId, "image")}${args.index > 0 ? `-${args.index + 1}` : ""}.png`;
    const absolutePath = resolve(args.cwd, fileName);
    const latestAbsolutePath = resolve(args.cwd, "latest.png");
    const bytes = Buffer.from(args.base64.trim(), "base64");
    return withFileMutationQueue(latestAbsolutePath, () =>
        withFileMutationQueue(absolutePath, async () => {
            await mkdir(dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, bytes);
            await writeFile(latestAbsolutePath, bytes);
            return {
                path: absolutePath,
                absolutePath,
                latestPath: latestAbsolutePath,
                latestAbsolutePath,
            };
        }),
    );
}

export function imageContentToDataUrl(content: ImageContent): string {
    return `data:${content.mimeType};base64,${content.data}`;
}

export function modelSupportsImages(model: ExtensionContext["model"]): boolean {
    return Array.isArray(model?.input) && model.input.includes("image");
}

function codexPromptImageResizeLimits(detail: ImageDetail): CodexPromptImageResizeLimits {
    return detail === "original" ? CODEX_ORIGINAL_DETAIL_LIMITS : CODEX_HIGH_DETAIL_LIMITS;
}

function imageDimensions(content: ImageContent): ImageDimensions {
    const dimensions = getImageDimensions(content.data, content.mimeType);
    if (!dimensions) throw new Error(`Unable to read image dimensions for ${content.mimeType}`);
    return { width: dimensions.widthPx, height: dimensions.heightPx };
}

function codexPromptImageDimensionsFit(
    width: number,
    height: number,
    limits: CodexPromptImageResizeLimits,
): boolean {
    const patchesWide = Math.ceil(width / CODEX_PROMPT_IMAGE_PATCH_SIZE);
    const patchesHigh = Math.ceil(height / CODEX_PROMPT_IMAGE_PATCH_SIZE);
    return (
        width <= limits.maxDimension &&
        height <= limits.maxDimension &&
        patchesWide * patchesHigh <= limits.maxPatches
    );
}

export function recentImageContents(ctx: ExtensionContext, count: number): ImageContent[] {
    const images: ImageContent[] = [];
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0 && images.length < count; index -= 1) {
        const entry = branch[index];
        if (!entry) continue;
        for (const image of extractImagesFromEntry(entry).reverse()) {
            images.push(image);
            if (images.length >= count) break;
        }
    }
    return images.reverse();
}

function extractImagesFromEntry(entry: SessionEntry): ImageContent[] {
    if (entry.type !== "message") return [];
    const message = parseWithSchema(MessageWithArrayContentSchema, entry.message);
    return message ? message.content.filter(isImageContent) : [];
}

function isImageContent(value: unknown): value is ImageContent {
    return parseWithSchema(ImageContentSchema, value) !== undefined;
}

function detectImageMimeType(bytes: Buffer, absolutePath: string): string | undefined {
    if (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return "image/jpeg";
    if (bytes.length >= 6) {
        const header = bytes.subarray(0, 6).toString("ascii");
        if (header === "GIF87a" || header === "GIF89a") return "image/gif";
    }
    if (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return "image/webp";
    }
    switch (extname(absolutePath).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        default:
            return undefined;
    }
}

function stripAtPrefix(path: string): string {
    return path.startsWith("@") ? path.slice(1) : path;
}
