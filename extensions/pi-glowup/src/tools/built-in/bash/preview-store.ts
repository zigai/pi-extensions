import { PreviewStore } from "../file-previews.ts";
import type { ScriptInvocation } from "./invocation.ts";
import { truncateUtf8ByGrapheme } from "../../../text-boundaries.ts";

const MAX_SCRIPT_PREVIEW_ENTRIES = 300;
const MAX_SCRIPT_PREVIEW_BYTES = 64 * 1024;
const MAX_SCRIPT_PREVIEW_TOTAL_BYTES = 4 * 1024 * 1024;
const SCRIPT_PREVIEW_TRUNCATION_SUFFIX = "\n… preview truncated";

/** Creates the bounded script preview cache used by bash call rendering. */
export function createScriptPreviewStore(): PreviewStore<ScriptInvocation> {
    return new PreviewStore<ScriptInvocation>({
        maxEntries: MAX_SCRIPT_PREVIEW_ENTRIES,
        maxBytes: MAX_SCRIPT_PREVIEW_TOTAL_BYTES,
        measureBytes: scriptPreviewBytes,
    });
}

/** Returns a script preview capped to the per-entry render budget. */
export function boundedScriptPreview(preview: ScriptInvocation): ScriptInvocation {
    if (Buffer.byteLength(preview.code, "utf8") <= MAX_SCRIPT_PREVIEW_BYTES) {
        return preview;
    }
    const maxCodeBytes = Math.max(
        0,
        MAX_SCRIPT_PREVIEW_BYTES - Buffer.byteLength(SCRIPT_PREVIEW_TRUNCATION_SUFFIX, "utf8"),
    );
    return {
        ...preview,
        code: `${truncateUtf8ByGrapheme(preview.code, maxCodeBytes)}${SCRIPT_PREVIEW_TRUNCATION_SUFFIX}`,
    };
}

function scriptPreviewBytes(preview: ScriptInvocation): number {
    return (
        Buffer.byteLength(preview.label, "utf8") +
        Buffer.byteLength(preview.language, "utf8") +
        Buffer.byteLength(preview.code, "utf8")
    );
}
