import { emptyComponent } from "../../../rendering/core.ts";
import {
    shouldDeferSimpleToolCall,
    toolStatusLabel,
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
} from "../../call-rendering.ts";
import { compactWhitespaceText, previewArgsForContext } from "../../previews.ts";
import {
    baseToolName,
    countLabel,
    getArray,
    getNonEmptyString,
    getNumber,
    isDefined,
    jsonObjectParser,
    type JsonValue,
} from "../../tool-values.ts";
import { jsonValueParser } from "../../../json-value.ts";
import { stringParser } from "../../../json-scalar.ts";

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

function parseStructuredArgs(value: JsonValue): JsonValue {
    const text = stringParser.parse(value);
    if (text === undefined) return value;
    try {
        return jsonValueParser.parse(JSON.parse(text)) ?? value;
    } catch {
        return value;
    }
}

function summarizeChromeArgs(
    command: string,
    args: JsonValue,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    const record = jsonObjectParser.parse(args);
    if (record === undefined) return previewArgsForContext(args, context);
    const uid = getNonEmptyString(record, "uid");
    const filePath =
        getNonEmptyString(record, "filePath") ??
        getNonEmptyString(record, "outputDirPath") ??
        getNonEmptyString(record, "requestFilePath") ??
        getNonEmptyString(record, "responseFilePath");
    switch (command) {
        case "navigate_page": {
            const navigationType = getNonEmptyString(record, "type") ?? "url";
            const url = getNonEmptyString(record, "url");
            return navigationType === "url" ? url : navigationType;
        }
        case "new_page":
            return getNonEmptyString(record, "url");
        case "click":
            return [uid, record.dblClick === true ? "double click" : undefined]
                .filter(isDefined)
                .join(" · ");
        case "drag":
            return [getNonEmptyString(record, "from_uid"), getNonEmptyString(record, "to_uid")]
                .filter(isDefined)
                .join(" → ");
        case "fill": {
            const value = getNonEmptyString(record, "value");
            return [
                uid,
                value === undefined ? undefined : countLabel(Array.from(value).length, "character"),
            ]
                .filter(isDefined)
                .join(" · ");
        }
        case "fill_form": {
            const elements = getArray(record, "elements");
            return elements === undefined ? undefined : countLabel(elements.length, "field");
        }
        case "type_text": {
            const value = getNonEmptyString(record, "text");
            return [
                value === undefined ? undefined : countLabel(Array.from(value).length, "character"),
                getNonEmptyString(record, "submitKey"),
            ]
                .filter(isDefined)
                .join(" · ");
        }
        case "evaluate_script": {
            const script = getNonEmptyString(record, "function");
            return [script === undefined ? undefined : compactWhitespaceText(script, 220), filePath]
                .filter(isDefined)
                .join(" · ");
        }
        case "resize_page": {
            const width = getNumber(record, "width");
            const height = getNumber(record, "height");
            return width === undefined || height === undefined ? undefined : `${width}×${height}`;
        }
        case "select_page":
        case "close_page":
            return getNumber(record, "pageId") === undefined
                ? undefined
                : `page ${getNumber(record, "pageId")}`;
        case "get_console_message":
            return getNumber(record, "msgid") === undefined
                ? undefined
                : `message ${getNumber(record, "msgid")}`;
        case "get_network_request":
            return [
                getNumber(record, "reqid") === undefined
                    ? "selected request"
                    : `request ${getNumber(record, "reqid")}`,
                filePath,
            ]
                .filter(isDefined)
                .join(" · ");
        case "press_key":
            return getNonEmptyString(record, "key");
        case "handle_dialog":
            return getNonEmptyString(record, "action");
        case "wait_for": {
            const values = getArray(record, "text")
                ?.map((value) => stringParser.parse(value))
                .filter(isDefined);
            return values === undefined ? undefined : values.slice(0, 3).join(" · ");
        }
        case "performance_analyze_insight":
            return [
                getNonEmptyString(record, "insightName"),
                getNonEmptyString(record, "insightSetId"),
            ]
                .filter(isDefined)
                .join(" · ");
        case "emulate":
            return [
                getNonEmptyString(record, "viewport"),
                getNonEmptyString(record, "networkConditions"),
                getNonEmptyString(record, "colorScheme"),
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

type McpGatewayArgsSummary = {
    readonly label: string;
    readonly body: string | undefined;
};

function summarizeMcpGatewayArgs(
    args: JsonValue | undefined,
    context: ThirdPartyToolRenderContext,
): McpGatewayArgsSummary {
    const record = jsonObjectParser.parse(args);
    if (record === undefined) {
        return { label: "MCP", body: previewArgsForContext(args, context) };
    }

    const tool = getNonEmptyString(record, "tool");
    if (tool !== undefined) {
        const toolArgs = parseStructuredArgs(record.args ?? null);
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
    ).find(([key]) => getNonEmptyString(record, key) !== undefined);
    if (operation !== undefined) {
        return { label: operation[1], body: getNonEmptyString(record, operation[0]) };
    }

    const action = getNonEmptyString(record, "action");
    if (action !== undefined) {
        const actionLabel =
            action === "ui-messages"
                ? "MCP Messages"
                : action === "auth-start" || action === "auth-complete"
                  ? "MCP Authenticate"
                  : `MCP ${action}`;
        return { label: actionLabel, body: getNonEmptyString(record, "server") };
    }

    const server = getNonEmptyString(record, "server");
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
            const summary = summarizeMcpGatewayArgs(jsonValueParser.parse(args), context);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: toolStatusLabel(labelMode, context, mcpLifecycleLabels(summary.label)),
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
            const parsedArgs = jsonValueParser.parse(args);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: toolStatusLabel(labelMode, context, mcpLifecycleLabels(label)),
                body:
                    parsedArgs === undefined
                        ? previewArgsForContext(args, context)
                        : summarizeChromeArgs(command, parsedArgs, context),
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            return renderSimpleResult(theme, result, options);
        },
    };
}
