import { emptyComponent } from "../../../rendering/core.ts";
import { shouldDeferSimpleToolCall, type ToolLabelMode } from "../../../rendering/status-labels.ts";
import { browserLifecycleLabels } from "../../browser-labels.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "../../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
    type CallSummary,
} from "../../call-rendering.ts";
import { truncateGraphemeText } from "../../../text-boundaries.ts";
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
    ["job", "Browser Job"],
    ["script", "Browser Script"],
    ["semanticAction", "Browser Action"],
    ["sourceLookup", "Browser Source Lookup"],
    ["networkSourceLookup", "Browser Network Lookup"],
    ["electron", "Electron"],
    ["evaluate", "Browser Evaluate"],
    ["eval", "Browser Evaluate"],
]);

function compactText(value: string, maximum = 220): string | undefined {
    const compact = value.replace(/\s+/gu, " ").trim();
    return compact.length === 0 ? undefined : truncateGraphemeText(compact, maximum);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeElectron(value: Readonly<Record<string, unknown>>): string | undefined {
    const action = getNonEmptyString(value, "action");
    const app =
        getNonEmptyString(value, "appName") ??
        getNonEmptyString(value, "bundleId") ??
        getNonEmptyString(value, "executablePath");
    return [action, app].filter(isDefined).join(" · ") || undefined;
}

function summarizeSemanticAction(value: Readonly<Record<string, unknown>>): string | undefined {
    const action = getNonEmptyString(value, "action");
    const locator = getNonEmptyString(value, "locator");
    const target =
        getNonEmptyString(value, "name") ??
        getNonEmptyString(value, "value") ??
        getNonEmptyString(value, "selector");
    const text = getNonEmptyString(value, "text");
    const values = getArray(value, "values");
    return [
        action,
        locator === undefined ? target : `${locator}${target === undefined ? "" : `: ${target}`}`,
        text === undefined ? undefined : countLabel(Array.from(text).length, "character"),
        values === undefined ? undefined : countLabel(values.length, "option"),
    ]
        .filter(isDefined)
        .join(" · ");
}

function summarizeJob(value: Readonly<Record<string, unknown>>): string | undefined {
    const steps = getArray(value, "steps");
    if (steps === undefined) return undefined;
    const actions = steps
        .slice(0, 4)
        .map((step) => (isRecord(step) ? getNonEmptyString(step, "action") : undefined))
        .filter(isDefined);
    const omitted = steps.length - actions.length;
    return `${countLabel(steps.length, "step")}${
        actions.length === 0
            ? ""
            : ` · ${actions.join(" → ")}${omitted > 0 ? ` → … (+${omitted})` : ""}`
    }`;
}

function summarizeQa(value: Readonly<Record<string, unknown>>): string | undefined {
    const target =
        getNonEmptyString(value, "url") ??
        (value.attached === true ? "current browser session" : undefined);
    const checks = [
        value.checkConsole === true ? "console" : undefined,
        value.checkErrors === true ? "errors" : undefined,
        value.checkNetwork === true ? "network" : undefined,
    ].filter(isDefined);
    return [target, checks.length === 0 ? undefined : `check ${checks.join(", ")}`]
        .filter(isDefined)
        .join(" · ");
}

function summarizeSourceLookup(value: Readonly<Record<string, unknown>>): string | undefined {
    return (
        getNonEmptyString(value, "componentName") ??
        getNonEmptyString(value, "selector") ??
        getNonEmptyString(value, "url") ??
        getNonEmptyString(value, "filter") ??
        getNonEmptyString(value, "requestId")
    );
}

function summarizeAgentBrowserArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): CallSummary {
    if (!isRecord(args)) {
        return { label: "Browser", body: previewArgsForContext(args, context) };
    }

    if (typeof args.script === "string") {
        const scriptLines = args.script.replace(/\r\n?/gu, "\n").split("\n");
        const firstLine = scriptLines.map((line) => compactText(line, 120)).find(isDefined);
        const preview =
            firstLine === undefined
                ? undefined
                : `${firstLine}${scriptLines.length > 1 ? " …" : ""}`;
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("script") ?? "Browser Script",
            body: [countLabel(scriptLines.length, "line"), preview].filter(isDefined).join(" · "),
        };
    }

    if (isRecord(args.electron)) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("electron") ?? "Electron",
            body: summarizeElectron(args.electron) ?? previewArgsForContext(args.electron, context),
        };
    }

    if (isRecord(args.semanticAction)) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("semanticAction") ?? "Browser Action",
            body:
                summarizeSemanticAction(args.semanticAction) ??
                previewArgsForContext(args.semanticAction, context),
        };
    }

    if (isRecord(args.job)) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("job") ?? "Browser Job",
            body: summarizeJob(args.job) ?? previewArgsForContext(args.job, context),
        };
    }

    if (isRecord(args.qa)) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("qa") ?? "Browser QA",
            body: summarizeQa(args.qa) ?? previewArgsForContext(args.qa, context),
        };
    }

    for (const key of ["sourceLookup", "networkSourceLookup"] as const) {
        if (isRecord(args[key])) {
            return {
                label: AGENT_BROWSER_COMMAND_LABELS.get(key) ?? "Browser Source Lookup",
                body: summarizeSourceLookup(args[key]) ?? previewArgsForContext(args[key], context),
            };
        }
    }

    const commandArgs = getArray(args, "args");
    const rawCommand = commandArgs?.[0];
    const command =
        typeof rawCommand === "string" && rawCommand.length > 0 ? rawCommand : undefined;
    if (command !== undefined && commandArgs !== undefined) {
        const commandBody = commandArgs
            .slice(1)
            .map((value) => (typeof value === "string" ? compactText(value, 120) : undefined))
            .filter(isDefined)
            .join(" ");
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get(command) ?? `Browser ${command}`,
            body:
                context.isPartial || !context.argsComplete
                    ? countLabel(Math.max(0, commandArgs.length - 1), "argument")
                    : commandBody || previewArgs(commandArgs.slice(1)),
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
            const hasEvolvingContent =
                isRecord(args) && (typeof args.script === "string" || isRecord(args.job));
            if (!hasEvolvingContent && shouldDeferSimpleToolCall(context)) {
                return emptyComponent();
            }
            const summary = summarizeAgentBrowserArgs(args, context);
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(
                    labelMode,
                    context,
                    browserLifecycleLabels(summary.label),
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
