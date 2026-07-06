import { renderCodexOutput, type CodexRenderTheme } from "../../../rendering/core.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "../../types.ts";
import {
    imagegenResultSummary,
    summarizeImagegenArgs,
    summarizeViewImageArgs,
} from "./image-renderers.ts";
import {
    summarizeWebRunArgs,
    webRunResultSummary,
    WEB_RUN_COLLAPSED_SOURCE_LIMIT,
} from "./web-run-renderer.ts";
import { callState, renderSimpleResult, renderThirdPartyCall } from "../../call-rendering.ts";
import { previewArgsForContext } from "../../previews.ts";
import { baseToolName, displayToolName } from "../../tool-values.ts";

const CODEX_TOOL_LABELS = new Map<string, string>([
    ["web_run", "Web Search"],
    ["imagegen", "Image Generate"],
    ["view_image", "View Image"],
]);

/** Returns whether a tool name belongs to Codex-provided tools. */
export function isCodexTool(toolName: string): boolean {
    return CODEX_TOOL_LABELS.has(baseToolName(toolName));
}

function codexCallLabel(toolName: string): string {
    return CODEX_TOOL_LABELS.get(baseToolName(toolName)) ?? `Called ${displayToolName(toolName)}`;
}

function codexCallBody(
    toolName: string,
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    const normalized = baseToolName(toolName);
    if (normalized === "web_run") {
        return summarizeWebRunArgs(args, theme, context);
    }
    if (normalized === "imagegen") {
        return summarizeImagegenArgs(args, context);
    }
    if (normalized === "view_image") {
        return summarizeViewImageArgs(args, theme, context);
    }
    return previewArgsForContext(args, context);
}

function codexResultSummary(
    toolName: string,
    result: ThirdPartyToolResult,
    theme: CodexRenderTheme,
    options: { readonly expanded: boolean },
): string | undefined {
    const normalized = baseToolName(toolName);
    if (normalized === "web_run") {
        return webRunResultSummary(theme, result, options);
    }
    if (normalized === "imagegen") {
        return imagegenResultSummary(result);
    }
    return undefined;
}

function codexResultPreviewLines(toolName: string): number {
    return baseToolName(toolName) === "web_run" ? WEB_RUN_COLLAPSED_SOURCE_LIMIT + 2 : 2;
}

export function createCodexRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: codexCallLabel(toolName),
                body: codexCallBody(toolName, args, theme, context),
                maxRenderedLines: 4,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            const summary = codexResultSummary(toolName, result, theme, {
                expanded: options.expanded,
            });
            if (summary !== undefined && summary.length > 0) {
                return renderCodexOutput(theme, summary, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: codexResultPreviewLines(toolName),
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}
