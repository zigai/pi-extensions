import { PreviewStore } from "../file-previews.ts";
import type { ScriptInvocation } from "./invocation.ts";

export const MAX_SCRIPT_PREVIEW_ENTRIES = 300;
const MAX_SCRIPT_PREVIEW_TOTAL_BYTES = 4 * 1024 * 1024;

/** Creates the bounded script preview cache used by bash call rendering. */
export function createScriptPreviewStore(): PreviewStore<ScriptInvocation> {
    return new PreviewStore<ScriptInvocation>({
        maxEntries: MAX_SCRIPT_PREVIEW_ENTRIES,
        maxBytes: MAX_SCRIPT_PREVIEW_TOTAL_BYTES,
        measureBytes: scriptPreviewBytes,
    });
}

function scriptPreviewBytes(preview: ScriptInvocation): number {
    return Math.min(
        MAX_SCRIPT_PREVIEW_TOTAL_BYTES,
        Buffer.byteLength(preview.label, "utf8") +
            Buffer.byteLength(preview.language, "utf8") +
            Buffer.byteLength(preview.code, "utf8") +
            Buffer.byteLength(preview.launcher ?? "", "utf8"),
    );
}
