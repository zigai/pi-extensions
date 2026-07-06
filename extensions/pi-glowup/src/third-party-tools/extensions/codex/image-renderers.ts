import { formatPathTarget, type CodexRenderTheme } from "../../../rendering/core.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolResult } from "../../types.ts";
import { compactQuotedText, previewArgsForContext } from "../../previews.ts";
import {
    getArray,
    getNumber,
    getString,
    isDefined,
    isNonEmptyString,
    isRecord,
} from "../../tool-values.ts";

export function summarizeImagegenArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }
    const prompt = compactQuotedText(getString(args, "prompt"), 140);
    const referenced = getArray(args, "referenced_image_paths") ?? getArray(args, "images");
    const recentCount = getNumber(args, "num_last_images_to_include");
    const metadata = [
        referenced !== undefined && referenced.length > 0 ? `${referenced.length} refs` : undefined,
        recentCount === undefined ? undefined : `${recentCount} recent`,
    ].filter(isDefined);
    const summary = [prompt, metadata.join(" • ")].filter(isNonEmptyString).join("\n");
    return summary.length > 0 ? summary : undefined;
}

export function summarizeViewImageArgs(
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }
    const path =
        getString(args, "path") ?? getString(args, "file_path") ?? getString(args, "image_path");
    const detail = getString(args, "detail");
    const pathText = isNonEmptyString(path) ? formatPathTarget(theme, path) : undefined;
    const detailText = isNonEmptyString(detail) ? `detail: ${detail}` : undefined;
    const summary = [pathText, detailText].filter(isDefined).join(" · ");
    return summary.length > 0 ? summary : undefined;
}

export function imagegenResultSummary(result: ThirdPartyToolResult): string | undefined {
    if (!isRecord(result.details)) {
        return undefined;
    }
    const images = getArray(result.details, "images");
    if (images === undefined || images.length === 0) {
        return undefined;
    }
    const first = images[0];
    const path = isRecord(first)
        ? (getString(first, "latestPath") ?? getString(first, "path"))
        : undefined;
    return `Generated ${images.length} image${images.length === 1 ? "" : "s"}${isNonEmptyString(path) ? ` → ${path}` : ""}`;
}
