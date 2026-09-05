/** Pixel dimensions read from an image header. */
export type ImageDimensions = {
    readonly width: number;
    readonly height: number;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detects a supported image MIME type from its signature bytes.
 */
export function detectImageMimeType(bytes: Buffer): string | undefined {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
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

/**
 * Reads image dimensions directly from supported format headers.
 */
export function imageDimensionsFromBytes(bytes: Buffer, mimeType: string): ImageDimensions {
    const dimensions = readImageDimensionsFromHeaders(bytes, mimeType);
    if (!dimensions) throw new Error(`Unable to read image dimensions for ${mimeType}`);
    return dimensions;
}

function readImageDimensionsFromHeaders(
    bytes: Buffer,
    mimeType: string,
): ImageDimensions | undefined {
    if (mimeType === "image/png") return readPngDimensions(bytes);
    if (mimeType === "image/jpeg") return readJpegDimensions(bytes);
    if (mimeType === "image/gif") return readGifDimensions(bytes);
    if (mimeType === "image/webp") return readWebpDimensions(bytes);
    return undefined;
}

function readPngDimensions(bytes: Buffer): ImageDimensions | undefined {
    if (bytes.length < 24) return undefined;
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
    if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readGifDimensions(bytes: Buffer): ImageDimensions | undefined {
    if (bytes.length < 10) return undefined;
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header !== "GIF87a" && header !== "GIF89a") return undefined;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | undefined {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
    let offset = 2;
    while (offset < bytes.length) {
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) return undefined;
        const marker = bytes[offset];
        offset += 1;
        if (marker === undefined || marker === 0xd9 || marker === 0xda) return undefined;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > bytes.length) return undefined;
        const segmentLength = bytes.readUInt16BE(offset);
        if (segmentLength < 2) return undefined;
        if (isJpegStartOfFrameMarker(marker)) {
            if (segmentLength < 7 || offset + segmentLength > bytes.length) return undefined;
            return {
                width: bytes.readUInt16BE(offset + 5),
                height: bytes.readUInt16BE(offset + 3),
            };
        }
        offset += segmentLength;
    }
    return undefined;
}

function isJpegStartOfFrameMarker(marker: number): boolean {
    return (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
    );
}

function readWebpDimensions(bytes: Buffer): ImageDimensions | undefined {
    if (
        bytes.length < 20 ||
        bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
        bytes.subarray(8, 12).toString("ascii") !== "WEBP"
    ) {
        return undefined;
    }

    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const chunkType = bytes.subarray(offset, offset + 4).toString("ascii");
        const chunkSize = bytes.readUInt32LE(offset + 4);
        const dataOffset = offset + 8;
        if (dataOffset + chunkSize > bytes.length) return undefined;
        const dimensions = readWebpChunkDimensions(bytes, chunkType, dataOffset, chunkSize);
        if (dimensions) return dimensions;
        offset = dataOffset + chunkSize + (chunkSize % 2);
    }
    return undefined;
}

function readWebpChunkDimensions(
    bytes: Buffer,
    chunkType: string,
    dataOffset: number,
    chunkSize: number,
): ImageDimensions | undefined {
    if (chunkType === "VP8X" && chunkSize >= 10) {
        return {
            width: bytes.readUIntLE(dataOffset + 4, 3) + 1,
            height: bytes.readUIntLE(dataOffset + 7, 3) + 1,
        };
    }
    if (chunkType === "VP8L" && chunkSize >= 5 && bytes[dataOffset] === 0x2f) {
        const byte1 = bytes[dataOffset + 1] ?? 0;
        const byte2 = bytes[dataOffset + 2] ?? 0;
        const byte3 = bytes[dataOffset + 3] ?? 0;
        const byte4 = bytes[dataOffset + 4] ?? 0;
        return {
            width: 1 + (((byte2 & 0x3f) << 8) | byte1),
            height: 1 + (((byte4 & 0x0f) << 10) | (byte3 << 2) | ((byte2 & 0xc0) >> 6)),
        };
    }
    if (
        chunkType === "VP8 " &&
        chunkSize >= 10 &&
        bytes[dataOffset + 3] === 0x9d &&
        bytes[dataOffset + 4] === 0x01 &&
        bytes[dataOffset + 5] === 0x2a
    ) {
        return {
            width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
            height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
        };
    }
    return undefined;
}
