import type { Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    formatPathTarget,
    renderCodexCall,
    renderCodexOutput,
    renderMutationCall,
    type CodexRenderTheme,
} from "./rendering.ts";

const MAX_WRITE_PREVIEW_BYTES = 64 * 1024;
const WRITE_PREVIEW_TRUNCATION_SUFFIX = "\n… write preview truncated";

type WriteCallContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly dynamicStatusLabels?: boolean;
    readonly mutationLabelColumnWidth?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(args: unknown, key: string): string | undefined {
    if (!isRecord(args)) {
        return undefined;
    }
    const value = args[key];
    return typeof value === "string" ? value : undefined;
}

function countContentLines(content: string): number {
    if (content.length === 0) {
        return 0;
    }

    let lineCount = content.endsWith("\n") ? 0 : 1;
    for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 10) {
            lineCount += 1;
        }
    }
    return lineCount;
}

function truncateUtf8(text: string, maxBytes: number): string {
    let byteLength = 0;
    let endIndex = 0;
    for (const char of text) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (byteLength + charBytes > maxBytes) {
            break;
        }
        byteLength += charBytes;
        endIndex += char.length;
    }
    return text.slice(0, endIndex);
}

function boundedWriteContentPreview(content: string): string {
    if (Buffer.byteLength(content, "utf8") <= MAX_WRITE_PREVIEW_BYTES) {
        return content;
    }

    const maxContentBytes = Math.max(
        0,
        MAX_WRITE_PREVIEW_BYTES - Buffer.byteLength(WRITE_PREVIEW_TRUNCATION_SUFFIX, "utf8"),
    );
    return `${truncateUtf8(content, maxContentBytes)}${WRITE_PREVIEW_TRUNCATION_SUFFIX}`;
}

/** Returns the built-in write tool content argument when it is available to render. */
export function writeContentFromArgs(args: unknown): string | undefined {
    return stringField(args, "content");
}

/** Renders a built-in write call with a bounded preview of the content being written. */
export function renderWriteCallPreview(
    args: unknown,
    theme: CodexRenderTheme,
    context: WriteCallContext,
): Component {
    const path = stringField(args, "path") ?? "";
    const content = writeContentFromArgs(args);
    const dynamicStatusLabels = context.dynamicStatusLabels === true;
    if (content === undefined || context.isError) {
        return renderCodexCall(theme, {
            state: context.isError ? "error" : context.isPartial ? "muted" : "success",
            statusText: dynamicStatusLabels && !context.isPartial ? "Wrote" : "Write",
            body: formatPathTarget(theme, path),
        });
    }

    return renderMutationCall(
        theme,
        {
            label: dynamicStatusLabels ? (context.isPartial ? "Writing" : "Wrote") : "Write",
            path,
            added: countContentLines(content),
            removed: 0,
        },
        {
            ...(context.mutationLabelColumnWidth === undefined
                ? {}
                : { labelColumnWidth: context.mutationLabelColumnWidth }),
            body: renderCodexOutput(theme, boundedWriteContentPreview(content), {
                expanded: context.expanded,
                mode: "head",
                maxPreviewLines: 20,
                prefixFirst: "  │ ",
                prefixRest: "  │ ",
                noOutputLabel: "(empty file)",
                syntax: { path },
            }),
        },
    );
}

/** Returns an empty successful write result when the call renderer already showed content. */
export function renderSuccessfulWriteResultFallback(args: unknown): Component | undefined {
    return writeContentFromArgs(args) === undefined ? undefined : emptyComponent();
}
