import type { Component } from "@earendil-works/pi-tui";
import {
    renderCodexCall,
    renderCodexOutput,
    type CodexCallState,
    type CodexRenderTheme,
} from "../rendering/core.ts";
import { detectStructuredOutputLanguage } from "../syntax/code-component.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "./types.ts";
import { displayToolName } from "./tool-values.ts";
import { previewArgsForContext, textOutput } from "./previews.ts";

export type CallSummary = {
    readonly label: string;
    readonly body: string | undefined;
};

type CallOptions = {
    readonly state: CodexCallState;
    readonly statusText: string;
    readonly body: string | undefined;
    readonly maxRenderedLines: number;
    readonly expanded: boolean;
    readonly expandable?: boolean;
};

export function callState(context: ThirdPartyToolRenderContext): CodexCallState {
    if (context.isError) {
        return "error";
    }
    if (context.isPartial || !context.argsComplete) {
        return "running";
    }
    return "success";
}

export function renderSimpleResult(
    theme: CodexRenderTheme,
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
): Component {
    const output = textOutput(result);
    const language = detectStructuredOutputLanguage(output);
    return renderCodexOutput(theme, output, {
        expanded: options.expanded,
        mode: "headTail",
        maxPreviewLines: 4,
        noOutputLabel: null,
        ...(language === undefined ? {} : { syntax: { language } }),
    });
}

export function renderThirdPartyCall(theme: CodexRenderTheme, options: CallOptions): Component {
    const maxRenderedLines =
        options.expanded && options.expandable !== false ? undefined : options.maxRenderedLines;
    if (options.body === undefined) {
        if (maxRenderedLines === undefined) {
            return renderCodexCall(theme, {
                state: options.state,
                statusText: options.statusText,
            });
        }
        return renderCodexCall(theme, {
            state: options.state,
            statusText: options.statusText,
            maxRenderedLines,
        });
    }

    if (maxRenderedLines === undefined) {
        return renderCodexCall(theme, {
            state: options.state,
            statusText: options.statusText,
            body: options.body,
        });
    }
    return renderCodexCall(theme, {
        state: options.state,
        statusText: options.statusText,
        body: options.body,
        maxRenderedLines,
    });
}

export function createGenericRenderer(toolName: string, label?: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: label ?? `Called ${displayToolName(toolName)}`,
                body: previewArgsForContext(args, context),
                maxRenderedLines: 4,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            return renderSimpleResult(theme, result, options);
        },
    };
}
