import { createHash } from "node:crypto";
import type { FileDiffMetadata } from "@pierre/diffs";

/** Returns a deterministic content identity suitable for persisted renderer cache keys. */
export function diffContentDigest(content: string): string {
    return createHash("sha256").update(content).digest("base64url");
}

type DigestibleDiffMetadata = Omit<FileDiffMetadata, "cacheKey"> & {
    readonly cacheKey?: string | undefined;
};

/** Returns a deterministic identity for JSON-compatible restored diff metadata. */
export function diffMetadataDigest(metadata: DigestibleDiffMetadata): string | undefined {
    try {
        return diffContentDigest(JSON.stringify(metadata));
    } catch {
        return undefined;
    }
}
