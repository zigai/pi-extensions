import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
    getAgentDir,
    withFileMutationQueue,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { resolveCodexCoreArtifactPath, sanitizeArtifactPathPart } from "./artifacts.ts";

export type LoadedImage = {
    readonly content: ImageContent;
    readonly absolutePath: string;
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
    };
}

export async function saveGeneratedImage(args: {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly index: number;
    readonly base64: string;
}): Promise<{
    readonly path: string;
    readonly absolutePath: string;
    readonly latestPath: string;
    readonly latestAbsolutePath: string;
    readonly archivePath: string;
    readonly archiveAbsolutePath: string;
}> {
    const sessionPathPart = sanitizeArtifactPathPart(args.sessionId, "session");
    const fileName = `${sanitizeArtifactPathPart(args.toolCallId, "image")}${args.index > 0 ? `-${args.index + 1}` : ""}.png`;
    const absolutePath = resolveCodexCoreArtifactPath({
        category: "imagegen",
        sessionId: args.sessionId,
        fileName,
    });
    const latestAbsolutePath = resolveCodexCoreArtifactPath({
        category: "imagegen",
        sessionId: args.sessionId,
        fileName: "latest.png",
    });
    const archiveAbsolutePath = join(getAgentDir(), "generated_images", sessionPathPart, fileName);
    const bytes = Buffer.from(args.base64.trim(), "base64");
    return withFileMutationQueue(latestAbsolutePath, () =>
        withFileMutationQueue(archiveAbsolutePath, () =>
            withFileMutationQueue(absolutePath, async () => {
                await mkdir(dirname(absolutePath), { recursive: true });
                await mkdir(dirname(archiveAbsolutePath), { recursive: true });
                await writeFile(absolutePath, bytes);
                await writeFile(latestAbsolutePath, bytes);
                await writeFile(archiveAbsolutePath, bytes);
                return {
                    path: absolutePath,
                    absolutePath,
                    latestPath: latestAbsolutePath,
                    latestAbsolutePath,
                    archivePath: archiveAbsolutePath,
                    archiveAbsolutePath,
                };
            }),
        ),
    );
}

export function imageContentToDataUrl(content: ImageContent): string {
    return `data:${content.mimeType};base64,${content.data}`;
}

export function modelSupportsImages(model: ExtensionContext["model"]): boolean {
    return Array.isArray(model?.input) && model.input.includes("image");
}

export function recentImageContents(ctx: ExtensionContext, count: number): ImageContent[] {
    const images: ImageContent[] = [];
    const branch = ctx.sessionManager.getBranch() as readonly unknown[];
    for (let index = branch.length - 1; index >= 0 && images.length < count; index -= 1) {
        const entry = branch[index];
        for (const image of extractImagesFromEntry(entry).reverse()) {
            images.push(image);
            if (images.length >= count) break;
        }
    }
    return images.reverse();
}

function extractImagesFromEntry(entry: unknown): ImageContent[] {
    if (!isRecord(entry) || entry.type !== "message") return [];
    const message = entry.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    return message.content.filter(isImageContent);
}

function isImageContent(value: unknown): value is ImageContent {
    return (
        isRecord(value) &&
        value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"
    );
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
