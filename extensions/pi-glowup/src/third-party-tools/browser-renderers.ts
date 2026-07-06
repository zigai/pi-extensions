import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "./types.ts";
import {
    callState,
    renderSimpleResult,
    renderThirdPartyCall,
    type CallSummary,
} from "./call-rendering.ts";
import { previewArgs, previewArgsForContext } from "./previews.ts";
import { baseToolName, getArray, getNonEmptyString, isDefined, isRecord } from "./tool-values.ts";

const CHROME_DEVTOOLS_PREFIX_PATTERN = /(?:^|__)chrome[-_]?devtools(?:__|_|$)/i;

const BROWSER_COMMAND_LABELS = new Map<string, string>([
    ["open", "Browser Open"],
    ["snapshot", "Browser Snapshot"],
    ["click", "Browser Click"],
    ["fill", "Browser Fill"],
    ["type", "Browser Type"],
    ["select", "Browser Select"],
    ["wait", "Browser Wait"],
    ["screenshot", "Browser Screenshot"],
    ["qa", "Browser QA"],
    ["sourceLookup", "Browser Source Lookup"],
    ["networkSourceLookup", "Browser Network Lookup"],
    ["electron", "Electron"],
    ["evaluate", "Browser Evaluate"],
    ["eval", "Browser Evaluate"],
]);

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

function summarizeBrowserArgs(args: unknown, context: ThirdPartyToolRenderContext): CallSummary {
    if (!isRecord(args)) {
        return { label: "Browser", body: previewArgsForContext(args, context) };
    }

    if (isRecord(args.electron)) {
        const action = getNonEmptyString(args.electron, "action");
        const appName =
            getNonEmptyString(args.electron, "appName") ??
            getNonEmptyString(args.electron, "bundleId");
        const summary = [action, appName].filter(isDefined).join(" ");
        return {
            label: BROWSER_COMMAND_LABELS.get("electron") ?? "Electron",
            body: summary.length > 0 ? summary : previewArgsForContext(args.electron, context),
        };
    }

    for (const key of [
        "qa",
        "job",
        "semanticAction",
        "sourceLookup",
        "networkSourceLookup",
    ] as const) {
        if (args[key] !== undefined) {
            return {
                label: BROWSER_COMMAND_LABELS.get(key) ?? "Browser",
                body: previewArgsForContext(args[key], context),
            };
        }
    }

    const commandArgs = getArray(args, "args");
    const rawCommand = commandArgs?.[0];
    const command =
        typeof rawCommand === "string" && rawCommand.length > 0 ? rawCommand : undefined;
    if (command !== undefined && commandArgs !== undefined) {
        return {
            label: BROWSER_COMMAND_LABELS.get(command) ?? `Browser ${command}`,
            body:
                context.isPartial || !context.argsComplete
                    ? `${Math.max(0, commandArgs.length - 1)} args`
                    : previewArgs(commandArgs.slice(1)),
        };
    }

    return { label: "Browser", body: previewArgsForContext(args, context) };
}

function summarizeMcpArgs(args: unknown, context: ThirdPartyToolRenderContext): CallSummary {
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

export function createBrowserRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const summary =
                toolName === "mcp"
                    ? summarizeMcpArgs(args, context)
                    : summarizeBrowserArgs(args, context);
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

export function createMcpToolRenderer(toolName: string): ThirdPartyToolRenderer {
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
