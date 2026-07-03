import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
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

import { resolveCodexCoreArtifactPath, sanitizeArtifactPathPart } from "./artifacts.ts";
import { compileSchema, parseWithSchema } from "./schema-parsing.ts";

const ImageContentSchema = compileSchema(
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
);
const MessageWithArrayContentSchema = compileSchema(
    Type.Object({ content: Type.Array(Type.Unknown()) }),
);
const ImagegenArtifactDetailsSchema = compileSchema(
    Type.Object({
        details: Type.Object({ images: Type.Array(Type.Object({ path: Type.String() })) }),
    }),
);

export type ImageDetail = "auto" | "high" | "original";

export type LoadedImage = {
    readonly absolutePath: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
};

type ImageDimensions = {
    readonly width: number;
    readonly height: number;
};

type CodexPromptImageResizeLimits = {
    readonly maxDimension: number;
    readonly maxPatches: number;
};

export const MAX_INPUT_IMAGE_BYTES = 25 * 1024 * 1024;

const IMAGE_HEADER_BYTE_COUNT = 32;
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
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error(`Image path is not a file: ${path}`);
    if (fileStat.size > MAX_INPUT_IMAGE_BYTES) {
        throw new Error(
            `Image is too large: ${path} (${fileStat.size} bytes; max ${MAX_INPUT_IMAGE_BYTES} bytes).`,
        );
    }
    const header = await readFirstBytes(absolutePath, IMAGE_HEADER_BYTE_COUNT);
    const mimeType = detectImageMimeType(header);
    if (!mimeType) throw new Error(`Unsupported or invalid image file: ${path}`);
    return {
        absolutePath,
        bytes: await readFile(absolutePath),
        mimeType,
    };
}

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
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly index: number;
    readonly base64: string;
    readonly agentDir?: string | undefined;
}): Promise<{
    readonly path: string;
    readonly absolutePath: string;
    readonly latestPath: string;
    readonly latestAbsolutePath: string;
}> {
    const fileName = `${sanitizeArtifactPathPart(args.toolCallId, "image")}${args.index > 0 ? `-${args.index + 1}` : ""}.png`;
    const latestAbsolutePath = resolveCodexCoreArtifactPath({
        category: "imagegen",
        sessionId: args.sessionId,
        fileName: "latest.png",
        agentDir: args.agentDir,
    });
    const bytes = Buffer.from(args.base64.trim(), "base64");
    return withFileMutationQueue(latestAbsolutePath, async () => {
        const absolutePath = await writeUniqueGeneratedImage(fileName, bytes, args);
        await writeFile(latestAbsolutePath, bytes);
        return {
            path: absolutePath,
            absolutePath,
            latestPath: latestAbsolutePath,
            latestAbsolutePath,
        };
    });
}

async function writeUniqueGeneratedImage(
    baseFileName: string,
    bytes: Buffer,
    args: { readonly sessionId: string; readonly agentDir?: string | undefined },
): Promise<string> {
    const artifactName = parseArtifactName(baseFileName);
    const firstPath = resolveCodexCoreArtifactPath({
        category: "imagegen",
        sessionId: args.sessionId,
        fileName: baseFileName,
        agentDir: args.agentDir,
    });
    await mkdir(dirname(firstPath), { recursive: true });

    for (let attempt = 0; attempt < 100; attempt += 1) {
        const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
        const fileName = `${artifactName.stem}${suffix}${artifactName.ext}`;
        const absolutePath = resolveCodexCoreArtifactPath({
            category: "imagegen",
            sessionId: args.sessionId,
            fileName,
            agentDir: args.agentDir,
        });
        try {
            await writeFile(absolutePath, bytes, { flag: "wx" });
            return absolutePath;
        } catch (cause: unknown) {
            if (!hasNodeErrorCode(cause, "EEXIST")) throw cause;
        }
    }

    throw new Error("Unable to allocate a unique image artifact path.");
}

function parseArtifactName(fileName: string): { readonly stem: string; readonly ext: string } {
    const ext = extname(fileName);
    return { stem: fileName.slice(0, fileName.length - ext.length), ext };
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    return isNodeError(cause) && cause.code === code;
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
    return typeof cause === "object" && cause !== null && "code" in cause;
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

function imageContentFromBytes(bytes: Buffer, mimeType: string): ImageContent {
    return { type: "image", data: bytes.toString("base64"), mimeType };
}

function imageDimensionsFromBytes(bytes: Buffer, mimeType: string): ImageDimensions {
    const dimensions = getImageDimensions(bytes.toString("base64"), mimeType);
    if (!dimensions) throw new Error(`Unable to read image dimensions for ${mimeType}`);
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

type RecentImageRef =
    | { readonly kind: "inline"; readonly content: ImageContent }
    | { readonly kind: "artifact"; readonly path: string };

export async function recentImageContents(
    ctx: ExtensionContext,
    count: number,
): Promise<ImageContent[]> {
    const imageRefs: RecentImageRef[] = [];
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0 && imageRefs.length < count; index -= 1) {
        const entry = branch[index];
        if (!entry) continue;
        for (const imageRef of extractImageRefsFromEntry(entry).reverse()) {
            imageRefs.push(imageRef);
            if (imageRefs.length >= count) break;
        }
    }

    const images: ImageContent[] = [];
    for (const imageRef of imageRefs.reverse()) {
        if (imageRef.kind === "inline") {
            images.push(imageRef.content);
            continue;
        }
        images.push(
            await prepareCodexPromptImageContent(await loadImageContent(imageRef.path, ctx.cwd)),
        );
    }
    return images;
}

function extractImageRefsFromEntry(entry: SessionEntry): RecentImageRef[] {
    if (entry.type !== "message") return [];
    return [
        ...extractInlineImageRefs(entry.message),
        ...extractImagegenArtifactRefs(entry.message),
    ];
}

function extractInlineImageRefs(message: unknown): RecentImageRef[] {
    const parsed = parseWithSchema(MessageWithArrayContentSchema, message);
    return parsed
        ? parsed.content
              .filter(isImageContent)
              .map((content): RecentImageRef => ({ kind: "inline", content }))
        : [];
}

function extractImagegenArtifactRefs(message: unknown): RecentImageRef[] {
    const parsed = parseWithSchema(ImagegenArtifactDetailsSchema, message);
    return parsed
        ? parsed.details.images.map(
              (image): RecentImageRef => ({ kind: "artifact", path: image.path }),
          )
        : [];
}

function isImageContent(value: unknown): value is ImageContent {
    return parseWithSchema(ImageContentSchema, value) !== undefined;
}

async function readFirstBytes(path: string, byteCount: number): Promise<Buffer> {
    const file = await open(path, "r");
    try {
        const buffer = Buffer.alloc(byteCount);
        const result = await file.read(buffer, 0, byteCount, 0);
        return buffer.subarray(0, result.bytesRead);
    } finally {
        await file.close();
    }
}

function detectImageMimeType(bytes: Buffer): string | undefined {
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
    return undefined;
}

function stripAtPrefix(path: string): string {
    return path.startsWith("@") ? path.slice(1) : path;
}
