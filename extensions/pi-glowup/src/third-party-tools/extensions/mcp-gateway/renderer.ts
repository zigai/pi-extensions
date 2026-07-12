import type { ToolLabelMode, ToolLifecycleLabels } from "../../../rendering/status-labels.ts";
import { browserLifecycleLabels } from "../../browser-labels.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "../../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
} from "../../call-rendering.ts";
import { previewArgsForContext } from "../../previews.ts";
import { baseToolName, getNonEmptyString, isRecord } from "../../tool-values.ts";

const CHROME_DEVTOOLS_PREFIX_PATTERN = /(?:^|__)chrome[-_]?devtools(?:__|_|$)/i;

const MCP_COMMAND_LABELS = new Map<string, string>([
    ["take_snapshot", "Browser Snapshot"],
    ["take_screenshot", "Browser Screenshot"],
    ["click", "Browser Click"],
    ["fill", "Browser Fill"],
    ["hover", "Browser Hover"],
    ["evaluate_script", "Browser Evaluate"],
    ["navigate_page", "Browser Navigate"],
    ["new_page", "Browser Open"],
    ["list_pages", "Browser Pages"],
    ["select_page", "Browser Select Page"],
    ["close_page", "Browser Close Page"],
    ["resize_page", "Browser Resize"],
    ["performance_analyze_insight", "Browser Performance"],
]);

/** Returns whether a tool name belongs to Chrome DevTools MCP. */
export function hasChromeDevtoolsName(toolName: string): boolean {
    return CHROME_DEVTOOLS_PREFIX_PATTERN.test(toolName);
}

function summarizeMcpGatewayArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): { readonly label: string; readonly body: string | undefined } {
    if (!isRecord(args)) {
        return { label: "MCP", body: previewArgsForContext(args, context) };
    }

    const tool =
        getNonEmptyString(args, "tool") ??
        getNonEmptyString(args, "describe") ??
        getNonEmptyString(args, "search");
    if (tool !== undefined) {
        return {
            label: MCP_COMMAND_LABELS.get(tool) ?? `MCP ${tool}`,
            body: previewArgsForContext(args.args ?? args, context),
        };
    }

    const connect = getNonEmptyString(args, "connect") ?? getNonEmptyString(args, "server");
    if (connect !== undefined) {
        return { label: "MCP Connect", body: connect };
    }

    return { label: "MCP", body: previewArgsForContext(args, context) };
}

function mcpLifecycleLabels(staticLabel: string): ToolLifecycleLabels {
    if (staticLabel.startsWith("Browser ")) {
        return browserLifecycleLabels(staticLabel);
    }
    if (staticLabel === "MCP Connect") {
        return { static: staticLabel, active: "Connecting MCP", completed: "Connected MCP" };
    }
    return {
        static: staticLabel,
        active: `Calling ${staticLabel}`,
        completed: `Called ${staticLabel}`,
    };
}

export function createMcpGatewayRenderer(
    _toolName: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const summary = summarizeMcpGatewayArgs(args, context);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(
                    labelMode,
                    context,
                    mcpLifecycleLabels(summary.label),
                ),
                body: summary.body,
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            return renderSimpleResult(theme, result, options);
        },
    };
}

export function createChromeDevtoolsMcpRenderer(
    toolName: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const command = baseToolName(toolName).replace(/^chrome[-_]?devtools(?:__|[_-])?/i, "");
            const label = MCP_COMMAND_LABELS.get(command) ?? `MCP ${baseToolName(toolName)}`;
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(labelMode, context, mcpLifecycleLabels(label)),
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
