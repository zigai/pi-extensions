import type { Component } from "@earendil-works/pi-tui";
import { emptyComponent, toolExpandHint } from "../rendering/component.ts";
import { renderGlowupCall } from "../rendering/tool-header.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../rendering/output.ts";
import { type GlowupCallState, type GlowupRenderTheme } from "../rendering/theme.ts";
import {
    shouldDeferSimpleToolCall,
    toolStatusLabel,
    type ToolLabelMode,
} from "../rendering/status-labels.ts";
import { detectStructuredOutputLanguage } from "../rendering/syntax/code-component.ts";
import { takeGraphemePrefix, takeGraphemeSuffix } from "../text-boundaries.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "./types.ts";
import { displayToolName } from "./tool-values.ts";
import { detailsOutput, previewArgsForContext, textOutput } from "./previews.ts";

export const DEFAULT_TOOL_CALL_PREVIEW_LINES = 6;
const MAX_EXPANDED_RESULT_CHARACTERS = 200_000;
const MAX_EXPANDED_RESULT_LINES = 400;

export type CallSummary = {
    readonly label: string;
    readonly body: string | undefined;
};

export type ThirdPartyCallOptions = {
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

function boundedExpandedResult(output: string | undefined): string | undefined {
    if (output === undefined) return undefined;

    const halfCharacterBudget = Math.floor(MAX_EXPANDED_RESULT_CHARACTERS / 2);
    const characterBounded =
        output.length <= MAX_EXPANDED_RESULT_CHARACTERS
            ? output
            : `${takeGraphemePrefix(output, halfCharacterBudget)}\n… output truncated …\n${takeGraphemeSuffix(output, halfCharacterBudget)}`;
    const lines = characterBounded.replace(/\r\n?/gu, "\n").split("\n");
    if (lines.length <= MAX_EXPANDED_RESULT_LINES) return characterBounded;

    const headCount = Math.ceil(MAX_EXPANDED_RESULT_LINES / 2);
    const tailCount = Math.floor(MAX_EXPANDED_RESULT_LINES / 2);
    return [
        ...lines.slice(0, headCount),
        `… +${lines.length - MAX_EXPANDED_RESULT_LINES} lines (expanded output bounded)`,
        ...lines.slice(-tailCount),
    ].join("\n");
}

export function renderSimpleResult(
    theme: GlowupRenderTheme,
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
): Component {
    const rawOutput = textOutput(result) ?? detailsOutput(result);
    const output = options.expanded ? boundedExpandedResult(rawOutput) : rawOutput;
    const language = detectStructuredOutputLanguage(output);
    let renderOptions: GlowupOutputRenderOptions = {
        expanded: options.expanded,
        mode: "headTail",
        maxPreviewLines: 4,
        noOutputLabel: null,
    };
    if (language !== undefined) {
        renderOptions = { ...renderOptions, syntax: { language } };
    }

    return renderGlowupOutput(theme, output, renderOptions);
}

export function renderThirdPartyCall(
    theme: GlowupRenderTheme,
    options: ThirdPartyCallOptions,
): Component {
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
                statusText: toolStatusLabel(labelMode, context, {
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
