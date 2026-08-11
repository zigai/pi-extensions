import { emptyComponent } from "../../../rendering/core.ts";
import {
    shouldDeferSimpleToolCall,
    type ToolLabelMode,
    type ToolLifecycleLabels,
} from "../../../rendering/status-labels.ts";
import { browserLifecycleLabels } from "../../browser-labels.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "../../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
} from "../../call-rendering.ts";
import { truncateGraphemeText } from "../../../text-boundaries.ts";
import { previewArgsForContext } from "../../previews.ts";
import {
    baseToolName,
    getArray,
    getNonEmptyString,
    isDefined,
    isRecord,
} from "../../tool-values.ts";

const CHROME_DEVTOOLS_PREFIX_PATTERN = /(?:^|__)chrome[-_]?devtools(?:__|_|$)/i;

const MCP_COMMAND_LABELS = new Map<string, string>([
    ["click", "Browser Click"],
    ["close_page", "Browser Close Page"],
    ["drag", "Browser Drag"],
    ["emulate", "Browser Emulate"],
    ["evaluate_script", "Browser Evaluate"],
    ["fill", "Browser Fill"],
    ["fill_form", "Browser Fill Form"],
    ["get_console_message", "Browser Console Message"],
    ["get_network_request", "Browser Network Request"],
    ["handle_dialog", "Browser Dialog"],
    ["hover", "Browser Hover"],
    ["lighthouse_audit", "Browser Lighthouse"],
    ["list_console_messages", "Browser Console"],
    ["list_network_requests", "Browser Network"],
    ["list_pages", "Browser Pages"],
    ["navigate_page", "Browser Navigate"],
    ["new_page", "Browser Open"],
    ["performance_analyze_insight", "Browser Performance Insight"],
    ["performance_start_trace", "Browser Start Trace"],
    ["performance_stop_trace", "Browser Stop Trace"],
    ["press_key", "Browser Key"],
    ["resize_page", "Browser Resize"],
    ["select_page", "Browser Select Page"],
    ["take_heapsnapshot", "Browser Heap Snapshot"],
    ["take_screenshot", "Browser Screenshot"],
    ["take_snapshot", "Browser Snapshot"],
    ["type_text", "Browser Type"],
    ["upload_file", "Browser Upload"],
    ["wait_for", "Browser Wait"],
]);

/** Returns whether a tool name belongs to Chrome DevTools MCP. */
export function hasChromeDevtoolsName(toolName: string): boolean {
    return CHROME_DEVTOOLS_PREFIX_PATTERN.test(toolName);
}

function compactText(value: string, maximum = 220): string | undefined {
    const compact = value.replace(/\s+/gu, " ").trim();
    return compact.length === 0 ? undefined : truncateGraphemeText(compact, maximum);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function parseStructuredArgs(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return value;
    }
}

function summarizeChromeArgs(
    command: string,
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) return previewArgsForContext(args, context);
    const uid = getNonEmptyString(args, "uid");
    const filePath =
        getNonEmptyString(args, "filePath") ??
        getNonEmptyString(args, "outputDirPath") ??
        getNonEmptyString(args, "requestFilePath") ??
        getNonEmptyString(args, "responseFilePath");
    switch (command) {
        case "navigate_page": {
            const navigationType = getNonEmptyString(args, "type") ?? "url";
            const url = getNonEmptyString(args, "url");
            return navigationType === "url" ? url : navigationType;
        }
        case "new_page":
            return getNonEmptyString(args, "url");
        case "click":
            return [uid, args.dblClick === true ? "double click" : undefined]
                .filter(isDefined)
                .join(" · ");
        case "drag":
            return [getNonEmptyString(args, "from_uid"), getNonEmptyString(args, "to_uid")]
                .filter(isDefined)
                .join(" → ");
        case "fill": {
            const value = getNonEmptyString(args, "value");
            return [
                uid,
                value === undefined ? undefined : countLabel(Array.from(value).length, "character"),
            ]
                .filter(isDefined)
                .join(" · ");
        }
        case "fill_form": {
            const elements = getArray(args, "elements");
            return elements === undefined ? undefined : countLabel(elements.length, "field");
        }
        case "type_text": {
            const value = getNonEmptyString(args, "text");
            return [
                value === undefined ? undefined : countLabel(Array.from(value).length, "character"),
                getNonEmptyString(args, "submitKey"),
            ]
                .filter(isDefined)
                .join(" · ");
        }
        case "evaluate_script": {
            const script = getNonEmptyString(args, "function");
            return [script === undefined ? undefined : compactText(script), filePath]
                .filter(isDefined)
                .join(" · ");
        }
        case "resize_page": {
            const width = typeof args.width === "number" ? args.width : undefined;
            const height = typeof args.height === "number" ? args.height : undefined;
            return width === undefined || height === undefined ? undefined : `${width}×${height}`;
        }
        case "select_page":
        case "close_page":
            return typeof args.pageId === "number" ? `page ${args.pageId}` : undefined;
        case "get_console_message":
            return typeof args.msgid === "number" ? `message ${args.msgid}` : undefined;
        case "get_network_request":
            return [
                typeof args.reqid === "number" ? `request ${args.reqid}` : "selected request",
                filePath,
            ]
                .filter(isDefined)
                .join(" · ");
        case "press_key":
            return getNonEmptyString(args, "key");
        case "handle_dialog":
            return getNonEmptyString(args, "action");
        case "wait_for": {
            const values = getArray(args, "text")?.filter(
                (value): value is string => typeof value === "string",
            );
            return values === undefined ? undefined : values.slice(0, 3).join(" · ");
        }
        case "performance_analyze_insight":
            return [getNonEmptyString(args, "insightName"), getNonEmptyString(args, "insightSetId")]
                .filter(isDefined)
                .join(" · ");
        case "emulate":
            return [
                getNonEmptyString(args, "viewport"),
                getNonEmptyString(args, "networkConditions"),
                getNonEmptyString(args, "colorScheme"),
            ]
                .filter(isDefined)
                .join(" · ");
        case "upload_file":
            return [uid, filePath].filter(isDefined).join(" · ");
        case "take_snapshot":
        case "take_screenshot":
        case "take_heapsnapshot":
        case "lighthouse_audit":
        case "performance_start_trace":
        case "performance_stop_trace":
            return filePath ?? previewArgsForContext(args, context);
        default:
            return uid ?? previewArgsForContext(args, context);
    }
}

function summarizeMcpGatewayArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): { readonly label: string; readonly body: string | undefined } {
    if (!isRecord(args)) {
        return { label: "MCP", body: previewArgsForContext(args, context) };
    }

    const tool = getNonEmptyString(args, "tool");
    if (tool !== undefined) {
        const toolArgs = parseStructuredArgs(args.args);
        const command = tool.replace(/^chrome[-_]?devtools(?:__|[_-])?/iu, "");
        return {
            label: MCP_COMMAND_LABELS.get(command) ?? `MCP ${baseToolName(tool)}`,
            body: MCP_COMMAND_LABELS.has(command)
                ? summarizeChromeArgs(command, toolArgs, context)
                : previewArgsForContext(toolArgs, context),
        };
    }

    const operation = (
        [
            ["describe", "MCP Describe"],
            ["search", "MCP Search"],
            ["instructions", "MCP Instructions"],
            ["connect", "MCP Connect"],
        ] as const
    ).find(([key]) => getNonEmptyString(args, key) !== undefined);
    if (operation !== undefined) {
        return { label: operation[1], body: getNonEmptyString(args, operation[0]) };
    }

    const action = getNonEmptyString(args, "action");
    if (action !== undefined) {
        const actionLabel =
            action === "ui-messages"
                ? "MCP Messages"
                : action === "auth-start" || action === "auth-complete"
                  ? "MCP Authenticate"
                  : `MCP ${action}`;
        return { label: actionLabel, body: getNonEmptyString(args, "server") };
    }

    const server = getNonEmptyString(args, "server");
    if (server !== undefined) return { label: "MCP Status", body: server };
    return { label: "MCP Status", body: undefined };
}

function mcpLifecycleLabels(staticLabel: string): ToolLifecycleLabels {
    if (staticLabel.startsWith("Browser ")) {
        return browserLifecycleLabels(staticLabel);
    }
    switch (staticLabel) {
        case "MCP Connect":
            return { static: staticLabel, active: "Connecting MCP", completed: "Connected MCP" };
        case "MCP Search":
            return { static: staticLabel, active: "Searching MCP", completed: "Searched MCP" };
        case "MCP Describe":
            return {
                static: staticLabel,
                active: "Describing MCP Tool",
                completed: "Described MCP Tool",
            };
        case "MCP Instructions":
            return {
                static: staticLabel,
                active: "Reading MCP Instructions",
                completed: "Read MCP Instructions",
            };
        case "MCP Authenticate":
            return {
                static: staticLabel,
                active: "Authenticating MCP",
                completed: "Authenticated MCP",
            };
        case "MCP Messages":
            return {
                static: staticLabel,
                active: "Reading MCP Messages",
                completed: "Read MCP Messages",
            };
        case "MCP Status":
            return { static: staticLabel, active: "Checking MCP", completed: "Checked MCP" };
        default:
            return {
                static: staticLabel,
                active: `Calling ${staticLabel}`,
                completed: `Called ${staticLabel}`,
            };
    }
}

export function createMcpGatewayRenderer(
    _toolName: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            if (shouldDeferSimpleToolCall(context)) return emptyComponent();
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
            if (shouldDeferSimpleToolCall(context)) return emptyComponent();
            const command = baseToolName(toolName).replace(/^chrome[-_]?devtools(?:__|[_-])?/i, "");
            const label = MCP_COMMAND_LABELS.get(command) ?? `MCP ${baseToolName(toolName)}`;
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(labelMode, context, mcpLifecycleLabels(label)),
                body: summarizeChromeArgs(command, args, context),
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            return renderSimpleResult(theme, result, options);
        },
    };
}
