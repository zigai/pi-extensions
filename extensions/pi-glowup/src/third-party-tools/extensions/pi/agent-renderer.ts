import { renderGlowupOutput } from "../../../rendering/core.ts";
import type { ToolLabelMode, ToolLifecycleLabels } from "../../../rendering/status-labels.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
} from "../../types.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderSimpleResult,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
} from "../../call-rendering.ts";
import {
    compactQuotedText,
    previewArgsForContext,
    textOutput,
    visitNormalizedOutputLines,
} from "../../previews.ts";
import {
    baseToolName,
    compactInteger,
    displayToolName,
    getBoolean,
    getNonEmptyString,
    getNumber,
    getString,
    isDefined,
    isNonEmptyString,
    isRecord,
} from "../../tool-values.ts";

const AGENT_TOOL_LABELS = new Map<string, ToolLifecycleLabels>([
    ["Agent", { static: "Launch Agent", active: "Launching Agent", completed: "Launched Agent" }],
    ["agent", { static: "Launch Agent", active: "Launching Agent", completed: "Launched Agent" }],
    [
        "get_subagent_result",
        { static: "Check Agent", active: "Checking Agent", completed: "Checked Agent" },
    ],
    [
        "steer_subagent",
        { static: "Steer Agent", active: "Steering Agent", completed: "Steered Agent" },
    ],
]);

/** Returns whether a tool name belongs to Pi subagent management. */
export function isAgentTool(toolName: string): boolean {
    return AGENT_TOOL_LABELS.has(baseToolName(toolName));
}

function agentCallLabels(toolName: string): ToolLifecycleLabels {
    const staticLabel = displayToolName(toolName);
    return (
        AGENT_TOOL_LABELS.get(baseToolName(toolName)) ?? {
            static: staticLabel,
            active: `Calling ${staticLabel}`,
            completed: `Called ${staticLabel}`,
        }
    );
}

function displaySubagentType(value: string | undefined): string | undefined {
    if (!isNonEmptyString(value) || value === ".") {
        return undefined;
    }
    return value;
}

function summarizeAgentLaunchArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }

    const description = getNonEmptyString(args, "description");
    const prompt = compactQuotedText(getString(args, "prompt"), 120);
    const subagentType = displaySubagentType(getString(args, "subagent_type"));
    const isolation = getNonEmptyString(args, "isolation");
    const model = getNonEmptyString(args, "model");
    const thinking = getNonEmptyString(args, "thinking");
    const schedule = getNonEmptyString(args, "schedule");
    const maxTurns = getNumber(args, "max_turns");
    const metadata = [
        isNonEmptyString(subagentType) ? `${subagentType} agent` : undefined,
        getBoolean(args, "run_in_background") === true ? "running in background" : undefined,
        getBoolean(args, "inherit_context") === true ? "inherits context" : undefined,
        isolation === "worktree" ? "isolated worktree" : undefined,
        isNonEmptyString(isolation) && isolation !== "worktree"
            ? `isolation: ${isolation}`
            : undefined,
        isNonEmptyString(model) ? `model: ${model}` : undefined,
        isNonEmptyString(thinking) ? `thinking: ${thinking}` : undefined,
        maxTurns === undefined ? undefined : `max ${compactInteger(maxTurns)} turns`,
        isNonEmptyString(schedule) ? `scheduled ${schedule}` : undefined,
    ].filter(isDefined);

    const summary = [description ?? prompt, metadata.join(" · ")]
        .filter(isNonEmptyString)
        .join("\n");
    return summary.length > 0 ? summary : previewArgsForContext(args, context);
}

function summarizeSubagentLookupArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }

    const agentId = getNonEmptyString(args, "agent_id") ?? getNonEmptyString(args, "agentId");
    const metadata = [
        getBoolean(args, "wait") === true ? "wait" : undefined,
        getBoolean(args, "verbose") === true ? "verbose" : undefined,
    ].filter(isDefined);
    const summary = [agentId, metadata.join(" · ")].filter(isNonEmptyString).join(" · ");
    return summary.length > 0 ? summary : previewArgsForContext(args, context);
}

function summarizeSubagentSteerArgs(
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }

    const agentId = getNonEmptyString(args, "agent_id") ?? getNonEmptyString(args, "agentId");
    const message = compactQuotedText(getString(args, "message"), 140);
    const summary = [agentId, message].filter(isNonEmptyString).join("\n");
    return summary.length > 0 ? summary : previewArgsForContext(args, context);
}

function agentCallBody(
    toolName: string,
    args: unknown,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    const normalized = baseToolName(toolName);
    if (normalized === "Agent" || normalized === "agent") {
        return summarizeAgentLaunchArgs(args, context);
    }
    if (normalized === "get_subagent_result") {
        return summarizeSubagentLookupArgs(args, context);
    }
    if (normalized === "steer_subagent") {
        return summarizeSubagentSteerArgs(args, context);
    }
    return previewArgsForContext(args, context);
}

function isWhitespaceChar(text: string, index: number): boolean {
    return text.charAt(index).trim().length === 0;
}

function normalizeAgentResultLine(line: string): string {
    let start = 0;
    let end = line.length;
    while (start < end && isWhitespaceChar(line, start)) {
        start += 1;
    }
    if (line[start] === "└" || line[start] === "│") {
        start += 1;
        while (start < end && isWhitespaceChar(line, start)) {
            start += 1;
        }
    }
    while (end > start && isWhitespaceChar(line, end - 1)) {
        end -= 1;
    }
    return start === 0 && end === line.length ? line : line.slice(start, end);
}

function formatAgentStatusMetric(metric: string): string | undefined {
    const [rawLabel, ...rawValueParts] = metric.split(":");
    const label = rawLabel?.trim();
    const value = rawValueParts.join(":").trim();
    if (label === undefined || label.length === 0 || value.length === 0) {
        const trimmed = metric.trim();
        return trimmed.length > 0 ? trimmed.replace(/\s+tokens?$/iu, " tok") : undefined;
    }

    const normalizedLabel = label.toLowerCase();
    if (normalizedLabel === "tool uses") {
        return `${value} tools`;
    }
    if (normalizedLabel === "duration") {
        return value;
    }
    if (normalizedLabel === "context") {
        return `context ${value}`;
    }
    if (normalizedLabel === "tokens" || normalizedLabel === "token") {
        return `${value} tok`;
    }
    return `${normalizedLabel} ${value}`;
}

function subagentCompletionSummary(output: string): string | undefined {
    let agentLine: string | undefined;
    let statusLine: string | undefined;
    const bullets: string[] = [];

    visitNormalizedOutputLines(output, (line) => {
        const normalized = normalizeAgentResultLine(line);
        if (agentLine === undefined && normalized.startsWith("Agent:")) {
            agentLine = normalized;
        }
        if (statusLine === undefined && normalized.startsWith("Type:")) {
            statusLine = normalized;
        }
        if (bullets.length < 4 && /^[-•]\s+/u.test(normalized)) {
            bullets.push(normalized);
        }
    });

    if (!isNonEmptyString(agentLine) && !isNonEmptyString(statusLine)) {
        return undefined;
    }

    const agentId = agentLine?.replace(/^Agent:\s*/u, "").trim();
    const statusParts =
        statusLine
            ?.split("|")
            .map((part) => part.trim())
            .filter((part) => part.length > 0) ?? [];
    const type = statusParts[0]?.replace(/^Type:\s*/u, "").trim();
    const status = statusParts[1]?.replace(/^Status:\s*/u, "").trim();
    const metrics = statusParts.slice(2).map(formatAgentStatusMetric).filter(isDefined);
    const headline = [status, type, agentId].filter(isNonEmptyString).join(" · ");
    const metadata = metrics.length > 0 ? metrics.join(" · ") : undefined;

    return [headline, metadata, ...bullets].filter(isNonEmptyString).join("\n");
}

function subagentLaunchSummary(output: string): string | undefined {
    let sawAgentStart = false;
    let mode: string | undefined;
    let agentId: string | undefined;
    const notes: string[] = [];

    visitNormalizedOutputLines(output, (line) => {
        const normalized = normalizeAgentResultLine(line);
        const startMatch = /Agent started(?<mode>[^.\n]*)\./iu.exec(normalized);
        if (startMatch !== null) {
            sawAgentStart = true;
            mode ??= startMatch.groups?.mode?.trim();
        }
        agentId ??= /Agent ID:\s*(?<nextAgentId>\S+)/iu.exec(normalized)?.groups?.nextAgentId;
        if (
            notes.length < 3 &&
            (normalized.startsWith("Do not duplicate") ||
                normalized.startsWith("Worktree:") ||
                normalized.startsWith("Branch:"))
        ) {
            notes.push(normalized);
        }
    });

    if (!sawAgentStart && !isNonEmptyString(agentId)) {
        return undefined;
    }

    const headline = [`started${isNonEmptyString(mode) ? ` ${mode}` : ""}`, agentId]
        .filter(isNonEmptyString)
        .join(" · ");
    return [headline, ...notes].filter(isNonEmptyString).join("\n");
}

function agentResultSummary(result: ThirdPartyToolResult): string | undefined {
    const output = textOutput(result);
    if (output === undefined || output.length === 0) {
        return undefined;
    }
    return subagentCompletionSummary(output) ?? subagentLaunchSummary(output);
}

export function createAgentRenderer(
    toolName: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: thirdPartyStatusLabel(labelMode, context, agentCallLabels(toolName)),
                body: agentCallBody(toolName, args, context),
                maxRenderedLines: DEFAULT_TOOL_CALL_PREVIEW_LINES,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            const summary = agentResultSummary(result);
            if (summary !== undefined && summary.length > 0) {
                return renderGlowupOutput(theme, summary, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 6,
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}
