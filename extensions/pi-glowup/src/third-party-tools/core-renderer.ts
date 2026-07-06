import { emptyComponent, renderCodexOutput, type CodexRenderTheme } from "../rendering/core.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "./types.ts";
import { createAskUserQuestionRenderer } from "./ask-user-question-renderer.ts";
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
import { callState, renderSimpleResult, renderThirdPartyCall } from "./call-rendering.ts";
import { previewArgsForContext } from "./previews.ts";
import { baseToolName, displayToolName } from "./tool-values.ts";

const CORE_TOOL_LABELS = new Map<string, string>([
    ["web_run", "Web Search"],
    ["imagegen", "Image Generate"],
    ["view_image", "View Image"],
    ["finalize_plan", "Plan Finalized"],
    ["ask_user_question", "Asked User"],
]);

/** Returns whether a tool name belongs to core Codex/Pi utilities. */
export function isCoreTool(toolName: string): boolean {
    return CORE_TOOL_LABELS.has(baseToolName(toolName));
}

function coreCallLabel(toolName: string): string {
    return CORE_TOOL_LABELS.get(baseToolName(toolName)) ?? `Called ${displayToolName(toolName)}`;
}

function coreCallBody(
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

function coreResultSummary(
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

function coreResultPreviewLines(toolName: string): number {
    return baseToolName(toolName) === "web_run" ? WEB_RUN_COLLAPSED_SOURCE_LIMIT + 2 : 2;
}

function createFinalizePlanRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(_args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: coreCallLabel(toolName),
                body: undefined,
                maxRenderedLines: 1,
                expanded: context.expanded,
                expandable: false,
            });
        },
        renderResult(result, options, theme, context) {
            if (context.isError || options.isPartial) {
                return renderSimpleResult(theme, result, options);
            }
            return emptyComponent();
        },
    };
}

export function createCoreRenderer(toolName: string): ThirdPartyToolRenderer {
    if (baseToolName(toolName) === "finalize_plan") {
        return createFinalizePlanRenderer(toolName);
    }
    if (baseToolName(toolName) === "ask_user_question") {
        return createAskUserQuestionRenderer(coreCallLabel(toolName));
    }

    return {
        renderCall(args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: coreCallLabel(toolName),
                body: coreCallBody(toolName, args, theme, context),
                maxRenderedLines: 4,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            const summary = coreResultSummary(toolName, result, theme, {
                expanded: options.expanded,
            });
            if (summary !== undefined && summary.length > 0) {
                return renderCodexOutput(theme, summary, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: coreResultPreviewLines(toolName),
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}
