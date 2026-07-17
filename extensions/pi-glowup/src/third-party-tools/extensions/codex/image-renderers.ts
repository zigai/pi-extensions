import {
    formatPathTarget,
    toolExpandHint,
    type GlowupRenderTheme,
} from "../../../rendering/core.ts";
import { isActiveToolCall } from "../../../rendering/status-labels.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolResult } from "../../types.ts";
import { previewArgsForContext } from "../../previews.ts";
import {
    getArray,
    getNumber,
    getString,
    isDefined,
    isNonEmptyString,
    isRecord,
} from "../../tool-values.ts";

const IMAGEGEN_PROMPT_WRAP_CHARS = 88;
const COLLAPSED_IMAGEGEN_PROMPT_LINES = 5;
const PARTIAL_IMAGEGEN_PROMPT_SCAN_CHARS = 8 * 1024;
const EXPANDED_IMAGEGEN_PROMPT_CHARS = 64 * 1024;

function wrapPromptLine(line: string): string[] {
    const words = line.trim().split(/\s+/u).filter(isNonEmptyString);
    if (words.length === 0) {
        return [""];
    }

    const lines: string[] = [];
    let current = "";
    for (const word of words) {
        if (current.length === 0 && word.length <= IMAGEGEN_PROMPT_WRAP_CHARS) {
            current = word;
            continue;
        }
        if (current.length > 0 && current.length + word.length + 1 <= IMAGEGEN_PROMPT_WRAP_CHARS) {
            current += ` ${word}`;
            continue;
        }
        if (current.length > 0) {
            lines.push(current);
            current = "";
        }
        if (word.length <= IMAGEGEN_PROMPT_WRAP_CHARS) {
            current = word;
            continue;
        }
        for (let start = 0; start < word.length; start += IMAGEGEN_PROMPT_WRAP_CHARS) {
            const chunk = word.slice(start, start + IMAGEGEN_PROMPT_WRAP_CHARS);
            if (chunk.length === IMAGEGEN_PROMPT_WRAP_CHARS) {
                lines.push(chunk);
            } else {
                current = chunk;
            }
        }
    }
    if (current.length > 0) {
        lines.push(current);
    }
    return lines;
}

function wrappedPromptLines(text: string): string[] {
    const lines = text
        .replace(/\r\n/gu, "\n")
        .replace(/\r/gu, "\n")
        .split("\n")
        .flatMap(wrapPromptLine);
    while (lines.length > 0 && lines[0]?.length === 0) {
        lines.shift();
    }
    while (lines.length > 0 && lines.at(-1)?.length === 0) {
        lines.pop();
    }
    return lines;
}

function expandedImagegenPromptLines(text: string): string[] {
    if (text.length <= EXPANDED_IMAGEGEN_PROMPT_CHARS) {
        return wrappedPromptLines(text);
    }
    const sideChars = Math.floor(EXPANDED_IMAGEGEN_PROMPT_CHARS / 2);
    return [
        ...wrappedPromptLines(text.slice(0, sideChars)),
        "… prompt truncated at 64 KiB",
        ...wrappedPromptLines(text.slice(-sideChars)),
    ];
}

function activeImagegenPromptLines(text: string): string[] {
    const start = Math.max(0, text.length - PARTIAL_IMAGEGEN_PROMPT_SCAN_CHARS);
    const lines = wrappedPromptLines(text.slice(start));
    const omitted = start > 0 || lines.length > COLLAPSED_IMAGEGEN_PROMPT_LINES;
    if (!omitted) {
        return lines;
    }
    return [
        `… earlier prompt (${toolExpandHint()})`,
        ...lines.slice(-(COLLAPSED_IMAGEGEN_PROMPT_LINES - 1)),
    ];
}

function completedImagegenPromptLines(text: string): string[] {
    const lines = expandedImagegenPromptLines(text);
    if (lines.length <= COLLAPSED_IMAGEGEN_PROMPT_LINES) {
        return lines;
    }
    return [...lines.slice(0, 2), `… prompt omitted (${toolExpandHint()})`, ...lines.slice(-2)];
}

function imagegenPromptPreview(
    text: string | undefined,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (text === undefined || text.trim().length === 0) {
        return undefined;
    }
    const lines = context.expanded
        ? expandedImagegenPromptLines(text)
        : isActiveToolCall(context)
          ? activeImagegenPromptLines(text)
          : completedImagegenPromptLines(text);
    return lines.length === 0 ? undefined : lines.join("\n");
}

export function summarizeImagegenArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }
    const rawPrompt = getString(args, "prompt");
    const prompt = imagegenPromptPreview(rawPrompt, context);
    const referenced = getArray(args, "referenced_image_paths") ?? getArray(args, "images");
    const recentCount = getNumber(args, "num_last_images_to_include");
    const metadata = [
        referenced !== undefined && referenced.length > 0 ? `${referenced.length} refs` : undefined,
        recentCount === undefined ? undefined : `${recentCount} recent`,
    ].filter(isDefined);
    const summary = [prompt, metadata.join(" • ")].filter(isNonEmptyString).join("\n");
    return summary.length > 0 ? `\n${summary}` : undefined;
}

export function summarizeViewImageArgs(
    args: unknown,
    theme: GlowupRenderTheme,
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
    return `Generated ${images.length} image${images.length === 1 ? "" : "s"}`;
}
