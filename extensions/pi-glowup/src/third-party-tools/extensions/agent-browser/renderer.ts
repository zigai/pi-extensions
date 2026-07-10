import type { ToolLabelMode } from "../../../rendering/status-labels.ts";
import { browserLifecycleLabels } from "../../browser-labels.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "../../types.ts";
import {
    callState,
    renderSimpleResult,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
    type CallSummary,
} from "../../call-rendering.ts";
import { previewArgs, previewArgsForContext } from "../../previews.ts";
import { getArray, getNonEmptyString, isDefined, isRecord } from "../../tool-values.ts";

const AGENT_BROWSER_COMMAND_LABELS = new Map<string, string>([
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

function summarizeAgentBrowserArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): CallSummary {
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
            label: AGENT_BROWSER_COMMAND_LABELS.get("electron") ?? "Electron",
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
                label: AGENT_BROWSER_COMMAND_LABELS.get(key) ?? "Browser",
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
            label: AGENT_BROWSER_COMMAND_LABELS.get(command) ?? `Browser ${command}`,
            body:
                context.isPartial || !context.argsComplete
                    ? `${Math.max(0, commandArgs.length - 1)} args`
                    : previewArgs(commandArgs.slice(1)),
        };
    }

    return { label: "Browser", body: previewArgsForContext(args, context) };
}

export function createAgentBrowserRenderer(
    _toolName: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const summary = summarizeAgentBrowserArgs(args, context);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(
                    labelMode,
                    context,
                    browserLifecycleLabels(summary.label),
                ),
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
