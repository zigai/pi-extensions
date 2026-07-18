import type { Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    renderGlowupCall,
    renderGlowupOutput,
    toolExpandHint,
    type GlowupCallState,
    type GlowupRenderTheme,
} from "../rendering/core.ts";
import {
    shouldDeferSimpleToolCall,
    toolStatusLabel,
    type ToolLabelMode,
    type ToolLifecycleLabels,
} from "../rendering/status-labels.ts";
import { detectStructuredOutputLanguage } from "../syntax/code-component.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "./types.ts";
import { displayToolName } from "./tool-values.ts";
import { detailsOutput, previewArgsForContext, textOutput } from "./previews.ts";

export const DEFAULT_TOOL_CALL_PREVIEW_LINES = 6;

export type CallSummary = {
    readonly label: string;
    readonly body: string | undefined;
};

type CallOptions = {
    readonly state: GlowupCallState;
    readonly statusText: string;
    readonly body: string | undefined;
    readonly maxRenderedLines: number;
    readonly expanded: boolean;
    readonly expandable?: boolean;
};

export function callState(context: ThirdPartyToolRenderContext): GlowupCallState {
    if (context.isError) {
        return "error";
    }
    if (context.isPartial || !context.argsComplete) {
        return "running";
    }
    return "success";
}

export function thirdPartyStatusLabel(
    mode: ToolLabelMode,
    context: ThirdPartyToolRenderContext,
    labels: ToolLifecycleLabels,
): string {
    return toolStatusLabel(mode, context, labels);
}

export function renderSimpleResult(
    theme: GlowupRenderTheme,
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
): Component {
    const output = textOutput(result) ?? detailsOutput(result);
    const language = detectStructuredOutputLanguage(output);
    return renderGlowupOutput(theme, output, {
        expanded: options.expanded,
        mode: "headTail",
        maxPreviewLines: 4,
        noOutputLabel: null,
        ...(language === undefined ? {} : { syntax: { language } }),
    });
}

export function renderThirdPartyCall(theme: GlowupRenderTheme, options: CallOptions): Component {
    const maxRenderedLines =
        options.expanded && options.expandable !== false ? undefined : options.maxRenderedLines;
    if (options.body === undefined) {
        if (maxRenderedLines === undefined) {
            return renderGlowupCall(theme, {
                state: options.state,
                statusText: options.statusText,
            });
        }
        return renderGlowupCall(theme, {
            state: options.state,
            statusText: options.statusText,
            maxRenderedLines,
            omittedHint: options.expandable === false ? "truncated" : toolExpandHint(),
        });
    }

    if (maxRenderedLines === undefined) {
        return renderGlowupCall(theme, {
            state: options.state,
            statusText: options.statusText,
            body: options.body,
        });
    }
    return renderGlowupCall(theme, {
        state: options.state,
        statusText: options.statusText,
        body: options.body,
        maxRenderedLines,
        omittedHint: options.expandable === false ? "truncated" : toolExpandHint(),
    });
}

export function createGenericRenderer(
    toolName: string,
    label?: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            if (shouldDeferSimpleToolCall(context)) {
                return emptyComponent();
            }
            const staticLabel = label ?? displayToolName(toolName);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(labelMode, context, {
                    static: staticLabel,
                    active: `Calling ${staticLabel}`,
                    completed: `Called ${staticLabel}`,
                }),
                body: previewArgsForContext(args, context),
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            return renderSimpleResult(theme, result, options);
        },
    };
}
