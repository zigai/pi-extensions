import { emptyComponent } from "../../rendering/component.ts";
import {
    shouldDeferSimpleToolCall,
    toolStatusLabel,
    type ToolLabelMode,
} from "../../rendering/status-labels.ts";
import { browserLifecycleLabels } from "./browser-labels.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
    type CallSummary,
} from "../call-rendering.ts";
import { compactWhitespaceText, previewArgs, previewArgsForContext } from "../previews.ts";
import { countLabel, getArray, getNonEmptyString, isDefined } from "../tool-values.ts";
import {
    jsonObjectParser,
    type JsonObject,
    jsonValueParser,
    type JsonValue,
} from "../../json-value.ts";
import { stringParser } from "../../json-scalar.ts";

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

function summarizeElectron(value: JsonObject): string | undefined {
    const action = getNonEmptyString(value, "action");
    const app =
        getNonEmptyString(value, "appName") ??
        getNonEmptyString(value, "bundleId") ??
        getNonEmptyString(value, "executablePath");
    return [action, app].filter(isDefined).join(" · ") || undefined;
}

function summarizeSemanticAction(value: JsonObject): string | undefined {
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

function summarizeJob(value: JsonObject): string | undefined {
    const steps = getArray(value, "steps");
    if (steps === undefined) return undefined;

    const actions = steps
        .slice(0, 4)
        .map((step) => {
            const record = jsonObjectParser.parse(step);
            return record === undefined ? undefined : getNonEmptyString(record, "action");
        })
        .filter(isDefined);
    const omitted = steps.length - actions.length;

    return `${countLabel(steps.length, "step")}${
        actions.length === 0
            ? ""
            : ` · ${actions.join(" → ")}${omitted > 0 ? ` → … (+${omitted})` : ""}`
    }`;
}

function summarizeQa(value: JsonObject): string | undefined {
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

function summarizeSourceLookup(value: JsonObject): string | undefined {
    return (
        getNonEmptyString(value, "componentName") ??
        getNonEmptyString(value, "selector") ??
        getNonEmptyString(value, "url") ??
        getNonEmptyString(value, "filter") ??
        getNonEmptyString(value, "requestId")
    );
}

function summarizeAgentBrowserArgs(
    args: JsonValue | undefined,
    context: ThirdPartyToolRenderContext,
): CallSummary {
    const record = jsonObjectParser.parse(args);
    if (record === undefined) {
        return { label: "Browser", body: previewArgsForContext(args, context) };
    }

    const script = getNonEmptyString(record, "script");
    if (script !== undefined) {
        const scriptLines = script.replace(/\r\n?/gu, "\n").split("\n");
        const firstLine = scriptLines
            .map((line) => compactWhitespaceText(line, 120))
            .find(isDefined);
        const preview =
            firstLine === undefined
                ? undefined
                : `${firstLine}${scriptLines.length > 1 ? " …" : ""}`;
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("script") ?? "Browser Script",
            body: [countLabel(scriptLines.length, "line"), preview].filter(isDefined).join(" · "),
        };
    }

    const electron = jsonObjectParser.parse(record.electron);
    if (electron !== undefined) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("electron") ?? "Electron",
            body: summarizeElectron(electron) ?? previewArgsForContext(electron, context),
        };
    }

    const semanticAction = jsonObjectParser.parse(record.semanticAction);
    if (semanticAction !== undefined) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("semanticAction") ?? "Browser Action",
            body:
                summarizeSemanticAction(semanticAction) ??
                previewArgsForContext(semanticAction, context),
        };
    }

    const job = jsonObjectParser.parse(record.job);
    if (job !== undefined) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("job") ?? "Browser Job",
            body: summarizeJob(job) ?? previewArgsForContext(job, context),
        };
    }

    const qa = jsonObjectParser.parse(record.qa);
    if (qa !== undefined) {
        return {
            label: AGENT_BROWSER_COMMAND_LABELS.get("qa") ?? "Browser QA",
            body: summarizeQa(qa) ?? previewArgsForContext(qa, context),
        };
    }

    for (const key of ["sourceLookup", "networkSourceLookup"] as const) {
        const sourceLookup = jsonObjectParser.parse(record[key]);
        if (sourceLookup !== undefined) {
            return {
                label: AGENT_BROWSER_COMMAND_LABELS.get(key) ?? "Browser Source Lookup",
                body:
                    summarizeSourceLookup(sourceLookup) ??
                    previewArgsForContext(sourceLookup, context),
            };
        }
    }

    const commandArgs = getArray(record, "args");
    const rawCommand = commandArgs?.[0];
    const command = stringParser.parse(rawCommand);
    const nonEmptyCommand = command === undefined || command.length === 0 ? undefined : command;
    if (nonEmptyCommand !== undefined && commandArgs !== undefined) {
        const commandBody = commandArgs
            .slice(1)
            .map((value) => {
                const text = stringParser.parse(value);
                return text === undefined ? undefined : compactWhitespaceText(text, 120);
            })
            .filter(isDefined)
            .join(" ");

        return {
            label:
                AGENT_BROWSER_COMMAND_LABELS.get(nonEmptyCommand) ?? `Browser ${nonEmptyCommand}`,
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
            const record = jsonObjectParser.parse(args);
            const hasEvolvingContent =
                record !== undefined &&
                (getNonEmptyString(record, "script") !== undefined ||
                    jsonObjectParser.parse(record.job) !== undefined);
            if (!hasEvolvingContent && shouldDeferSimpleToolCall(context)) {
                return emptyComponent();
            }

            const summary = summarizeAgentBrowserArgs(jsonValueParser.parse(args), context);

            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: toolStatusLabel(
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
