import { constants as fsConstants } from "node:fs";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { resizeImage, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
    resolveCodexCoreArtifactPath,
    resolveCodexCoreArtifactRoot,
    sanitizeArtifactPathPart,
} from "../artifacts.ts";
import { detectImageMimeType } from "./metadata.ts";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Maximum accepted size for an image loaded from disk. */
export const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_VALIDATION_MAX_BYTES = 8 * 1024 * 1024;

/** A validated image file loaded into memory. */
export type LoadedImage = {
    readonly absolutePath: string;
    readonly bytes: Buffer;
    readonly mimeType: string;
};

/**
 * Resolves and loads an image file after validating its size and signature.
 */
export async function loadImageContent(
    path: string,
    cwd: string,
    options: {
        readonly signal?: AbortSignal | undefined;
        readonly allowOutsideWorkspace?: boolean | undefined;
    } = {},
): Promise<LoadedImage> {
    options.signal?.throwIfAborted();
    const requestedPath = resolve(cwd, path);
    const absolutePath = await authorizeImagePath(requestedPath, cwd, options);
    options.signal?.throwIfAborted();
    const file = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        options.signal?.throwIfAborted();
        const fileStat = await file.stat();
        options.signal?.throwIfAborted();
        if (!fileStat.isFile()) throw new Error(`Image path is not a file: ${path}`);
        if (fileStat.size > MAX_INPUT_IMAGE_BYTES) {
            throw new Error(
                `Image is too large: ${path} (${fileStat.size} bytes; max ${MAX_INPUT_IMAGE_BYTES} bytes).`,
            );
        }
        const bytes = await readBoundedFile(file, MAX_INPUT_IMAGE_BYTES, options);
        options.signal?.throwIfAborted();
        const mimeType = detectImageMimeType(bytes);
        if (!mimeType || !(await imageFullyDecodes(bytes, mimeType, options))) {
            throw new Error(`Unsupported or invalid image file: ${path}`);
        }
        return { absolutePath, bytes, mimeType };
    } finally {
        await file.close();
    }
}

/**
 * Saves one generated PNG under a unique session artifact path and updates the
 * session's latest-image artifact.
 */
export async function saveGeneratedImage(
    args: {
        readonly sessionId: string;
        readonly toolCallId: string;
        readonly index: number;
        readonly base64: string;
        readonly agentDir?: string | undefined;
    },
    options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<{
    readonly path: string;
    readonly absolutePath: string;
    readonly latestPath: string;
    readonly latestAbsolutePath: string;
}> {
    options.signal?.throwIfAborted();
    const fileName = `${sanitizeArtifactPathPart(args.toolCallId, "image")}${args.index > 0 ? `-${args.index + 1}` : ""}.png`;
    const latestAbsolutePath = resolveCodexCoreArtifactPath({
        category: "imagegen",
        sessionId: args.sessionId,
        fileName: "latest.png",
        agentDir: args.agentDir,
    });
    const bytes = decodeGeneratedPng(args.base64);
    return withFileMutationQueue(latestAbsolutePath, async () => {
        options.signal?.throwIfAborted();
        let absolutePath: string | undefined;
        try {
            absolutePath = await writeUniqueGeneratedImage(fileName, bytes, args, options);
            options.signal?.throwIfAborted();
            await writeLatestGeneratedImage(latestAbsolutePath, bytes, options);
            options.signal?.throwIfAborted();
            return {
                path: absolutePath,
                absolutePath,
                latestPath: latestAbsolutePath,
                latestAbsolutePath,
            };
        } catch (cause: unknown) {
            if (absolutePath && options.signal?.aborted) {
                await rm(absolutePath, { force: true });
            }
            throw cause;
        }
    });
}

/** Strictly decode a generated PNG into model-visible Pi image content. */
export function generatedPngContent(base64: string): ImageContent {
    const bytes = decodeGeneratedPng(base64);
    return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" };
}

async function writeUniqueGeneratedImage(
    baseFileName: string,
    bytes: Buffer,
    args: { readonly sessionId: string; readonly agentDir?: string | undefined },
    options: { readonly signal?: AbortSignal | undefined },
): Promise<string> {
    const artifactName = parseArtifactName(baseFileName);
    const firstPath = resolveCodexCoreArtifactPath({
        category: "imagegen",
        sessionId: args.sessionId,
        fileName: baseFileName,
        agentDir: args.agentDir,
    });
    options.signal?.throwIfAborted();
    await mkdir(dirname(firstPath), { recursive: true });
    options.signal?.throwIfAborted();

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
            await writeFile(absolutePath, bytes, { flag: "wx", signal: options.signal });
            options.signal?.throwIfAborted();
            return absolutePath;
        } catch (cause: unknown) {
            if (options.signal?.aborted) {
                await rm(absolutePath, { force: true });
                throw cause;
            }
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

async function authorizeImagePath(
    path: string,
    cwd: string,
    options: {
        readonly signal?: AbortSignal | undefined;
        readonly allowOutsideWorkspace?: boolean | undefined;
    },
): Promise<string> {
    options.signal?.throwIfAborted();
    const realPath = await realpath(path);
    options.signal?.throwIfAborted();
    if (options.allowOutsideWorkspace) return realPath;

    const realCwd = await realpath(cwd);
    options.signal?.throwIfAborted();
    if (isWithinRoot(realPath, realCwd)) return realPath;
    try {
        const artifactRoot = await realpath(resolveCodexCoreArtifactRoot());
        options.signal?.throwIfAborted();
        if (isWithinRoot(realPath, artifactRoot)) return realPath;
    } catch {
        // The artifact root does not exist yet, so it cannot contain this existing file.
    }
    throw new Error(`Image path is outside the workspace: ${path}`);
}

function isWithinRoot(path: string, root: string): boolean {
    const child = relative(root, path);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function readBoundedFile(
    file: Awaited<ReturnType<typeof open>>,
    maxBytes: number,
    options: { readonly signal?: AbortSignal | undefined },
): Promise<Buffer> {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        options.signal?.throwIfAborted();
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Image exceeds the ${maxBytes}-byte read limit.`);
    return buffer.subarray(0, offset);
}

async function imageFullyDecodes(
    bytes: Buffer,
    mimeType: string,
    options: { readonly signal?: AbortSignal | undefined },
): Promise<boolean> {
    options.signal?.throwIfAborted();
    const resized = await resizeImage(bytes, mimeType, {
        maxWidth: 6000,
        maxHeight: 6000,
        maxBytes: IMAGE_VALIDATION_MAX_BYTES,
    });
    options.signal?.throwIfAborted();
    return resized !== null;
}

async function writeLatestGeneratedImage(
    latestAbsolutePath: string,
    bytes: Buffer,
    options: { readonly signal?: AbortSignal | undefined },
): Promise<void> {
    options.signal?.throwIfAborted();
    const temporaryPath = `${latestAbsolutePath}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporaryPath, bytes, { flag: "wx", signal: options.signal });
        options.signal?.throwIfAborted();
        await rename(temporaryPath, latestAbsolutePath);
        options.signal?.throwIfAborted();
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

function decodeGeneratedPng(base64: string): Buffer {
    const normalized = base64.trim();
    if (
        normalized.length === 0 ||
        normalized.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
        throw new Error("Generated image payload is not valid base64.");
    }
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.toString("base64") !== normalized || detectImageMimeType(bytes) !== "image/png") {
        throw new Error("Generated image payload is not a valid PNG.");
    }
    return bytes;
}
