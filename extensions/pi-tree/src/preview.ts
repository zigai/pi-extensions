import { truncateToWidth } from "@earendil-works/pi-tui";

import type { TreeNode } from "./tree-node.ts";

const MIN_PREVIEW_TOTAL_WIDTH = 80;
const MIN_PREVIEW_WIDTH = 24;
const MIN_TREE_WIDTH = 32;

function normalizePreviewText(value: string): string {
    return value
        .replace(/[\t ]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

type TextContentBlock = {
    readonly type: "text";
    readonly text: string;
};

type PreviewContent =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "blocks"; readonly blocks: readonly TextContentBlock[] }
    | { readonly kind: "empty" };

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
    if (typeof value !== "object" || value === null) return false;
    return (
        Object.getOwnPropertyDescriptor(value, "type")?.value === "text" &&
        isString(Object.getOwnPropertyDescriptor(value, "text")?.value)
    );
}

const previewContentParser = {
    parse(content: unknown): PreviewContent {
        if (isString(content)) return { kind: "text", text: content };
        if (!Array.isArray(content)) return { kind: "empty" };

        return { kind: "blocks", blocks: content.filter(isTextContentBlock) };
    },
};

function extractTextContent(content: PreviewContent, maxLength: number): string {
    if (content.kind === "text") return content.text.slice(0, maxLength);
    if (content.kind === "empty") return "";

    let result = "";
    for (const block of content.blocks) {
        result += block.text;
        if (result.length >= maxLength) return result.slice(0, maxLength);
    }

    return result;
}

export function getPreviewText(node: TreeNode | undefined): string {
    const entry = node?.entry;
    if (entry === undefined) {
        return "";
    }

    if (entry.type === undefined) {
        return "";
    }

    switch (entry.type) {
        case "message": {
            const message = entry.message;
            const textContent = normalizePreviewText(
                extractTextContent(previewContentParser.parse(message?.content), 4000),
            );
            if (textContent.length > 0) {
                return textContent;
            }

            if (message?.role === "bashExecution") {
                return normalizePreviewText(message.command ?? "");
            }

            if (message?.errorMessage !== undefined && message.errorMessage.length > 0) {
                return normalizePreviewText(message.errorMessage);
            }

            if (message?.stopReason === "aborted") {
                return "(aborted)";
            }

            if (message?.role === "toolResult") {
                return `[${message.toolName ?? "tool"}]`;
            }

            return "(no content)";
        }
        case "custom_message":
            return normalizePreviewText(
                extractTextContent(previewContentParser.parse(entry.content), 4000),
            );
        case "branch_summary":
            return normalizePreviewText(entry.summary ?? "");
        case "compaction":
            return `compaction: ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens`;
        case "context_edit": {
            let action = "replace";
            if (entry.replacement === null) action = "omit";

            return `[context ${action}: ${entry.targetId ?? ""}]`;
        }
        case "model_change":
            return `model: ${entry.modelId ?? ""}`;
        case "thinking_level_change":
            return `thinking: ${entry.thinkingLevel ?? ""}`;
        case "custom":
            return `custom: ${entry.customType ?? ""}`;
        case "label":
            return `label: ${entry.label ?? "(cleared)"}`;
        case "session_info":
            return `title: ${entry.name ?? "empty"}`;
        default:
            return "";
    }
}

export function calculatePreviewLayout(
    width: number,
): { leftWidth: number; rightWidth: number } | null {
    if (width < MIN_PREVIEW_TOTAL_WIDTH) {
        return null;
    }

    const separatorWidth = 3;
    const preferredLeftWidth = Math.max(MIN_TREE_WIDTH, Math.floor(width * 0.42));
    const maxLeftWidth = width - separatorWidth - MIN_PREVIEW_WIDTH;
    if (maxLeftWidth < MIN_TREE_WIDTH) {
        return null;
    }

    const leftWidth = Math.min(preferredLeftWidth, maxLeftWidth);
    return { leftWidth, rightWidth: width - separatorWidth - leftWidth };
}

export function padToWidth(text: string, width: number): string {
    return truncateToWidth(text, width, "...", true);
}
