import { createHash } from "node:crypto";

/** Returns a deterministic content identity suitable for persisted renderer cache keys. */
export function diffContentDigest(content: string): string {
    return createHash("sha256").update(content).digest("base64url");
}

/** Returns a deterministic identity for JSON-compatible restored diff metadata. */
export function diffMetadataDigest(metadata: unknown): string | undefined {
    try {
        return diffContentDigest(JSON.stringify(metadata));
    } catch {
        return undefined;
    }
}
