import { createHash } from "node:crypto";

/**
 * Opaque revision token for the exact settings sources observed during loading or an update.
 *
 * Revisions contain no settings values. Callers should only retain and pass them back through
 * `expectedRevision`; their string representation is not a stable persistence format.
 */
export type PiSettingsRevision = `sha256:${string}`;

/** Hash length-prefixed sources so missing files and arbitrary contents cannot be ambiguous. */
export function createSettingsRevision(
    ...sources: readonly (string | undefined)[]
): PiSettingsRevision {
    const hash = createHash("sha256");
    for (const source of sources) {
        if (source === undefined) {
            hash.update("missing\0");
            continue;
        }
        const content = Buffer.from(source, "utf8");
        hash.update(`present:${content.byteLength}\0`);
        hash.update(content);
    }
    return `sha256:${hash.digest("hex")}`;
}
