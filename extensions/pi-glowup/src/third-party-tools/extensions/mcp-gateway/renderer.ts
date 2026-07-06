import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "../../types.ts";
import { callState, renderSimpleResult, renderThirdPartyCall } from "../../call-rendering.ts";
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

export function createMcpGatewayRenderer(_toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const summary = summarizeMcpGatewayArgs(args, context);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: summary.label,
                body: summary.body,
                maxRenderedLines: 4,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            return renderSimpleResult(theme, result, options);
        },
    };
}

export function createChromeDevtoolsMcpRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const command = baseToolName(toolName).replace(/^chrome[-_]?devtools(?:__|[_-])?/i, "");
            const label = MCP_COMMAND_LABELS.get(command) ?? `MCP ${baseToolName(toolName)}`;
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: label,
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
