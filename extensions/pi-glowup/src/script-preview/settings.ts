import type { ScriptPreviewHeaderLayout } from "../rendering/core.ts";

export function parseScriptPreviewHeaderLayout(
    value: string | undefined,
): ScriptPreviewHeaderLayout {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "inline" || normalized === "block") {
        return normalized;
    }
    return "auto";
}
