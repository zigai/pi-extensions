import type { ImageContent } from "@earendil-works/pi-ai";
import { resizeImage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedImage } from "./file-artifacts.ts";
import { imageDimensionsFromBytes, type ImageDimensions } from "./metadata.ts";

/** Image detail policy accepted by current Codex image prompts. */
export type ImageDetail = "high" | "original";

type CodexPromptImageResizeLimits = {
    readonly maxDimension: number;
    readonly maxPatches: number;
};

const CODEX_PROMPT_IMAGE_PATCH_SIZE = 32;
const CODEX_PROMPT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CODEX_HIGH_DETAIL_LIMITS: CodexPromptImageResizeLimits = {
    maxDimension: 2048,
    maxPatches: 2_500,
};
const CODEX_ORIGINAL_DETAIL_LIMITS: CodexPromptImageResizeLimits = {
    maxDimension: 6000,
    maxPatches: 10_000,
};

/**
 * Converts a loaded image into Codex prompt content, resizing it when required
 * by the selected detail policy.
 */
export async function prepareCodexPromptImageContent(
    image: LoadedImage,
    detail: ImageDetail = "high",
): Promise<ImageContent> {
    const limits = codexPromptImageResizeLimits(detail);
    const dimensions = imageDimensionsFromBytes(image.bytes, image.mimeType);
    const target = codexPromptImageTargetDimensions(dimensions.width, dimensions.height, limits);
    if (target.width === dimensions.width && target.height === dimensions.height) {
        return imageContentFromBytes(image.bytes, image.mimeType);
    }

    const resized = await resizeImage(image.bytes, image.mimeType, {
        maxWidth: target.width,
        maxHeight: target.height,
        maxBytes: CODEX_PROMPT_IMAGE_MAX_BYTES,
    });
    if (!resized) throw new Error(`Unable to resize image for view_image: ${image.absolutePath}`);
    return { type: "image", data: resized.data, mimeType: resized.mimeType };
}

/**
 * Computes dimensions that satisfy Codex's maximum dimension and patch budget.
 */
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

/** Converts image content to a base64 data URL. */
export function imageContentToDataUrl(content: ImageContent): string {
    return `data:${content.mimeType};base64,${content.data}`;
}

/** Reports whether the active model accepts image input. */
export function modelSupportsImages(model: ExtensionContext["model"]): boolean {
    return Array.isArray(model?.input) && model.input.includes("image");
}

function codexPromptImageResizeLimits(detail: ImageDetail): CodexPromptImageResizeLimits {
    return detail === "original" ? CODEX_ORIGINAL_DETAIL_LIMITS : CODEX_HIGH_DETAIL_LIMITS;
}

function imageContentFromBytes(bytes: Buffer, mimeType: string): ImageContent {
    return { type: "image", data: bytes.toString("base64"), mimeType };
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
