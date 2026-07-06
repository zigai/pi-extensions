import { renderCodexOutput } from "../rendering/core.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolResult } from "./types.ts";
import { callState, renderSimpleResult, renderThirdPartyCall } from "./call-rendering.ts";
import { textOutput } from "./previews.ts";
import {
    baseToolName,
    compactInteger,
    getNonEmptyString,
    getNumber,
    getString,
    isRecord,
} from "./tool-values.ts";

type GoalRecord = {
    readonly objective: string;
    readonly status: string;
    readonly tokensUsed: number | undefined;
    readonly timeUsedSeconds: number | undefined;
};

function normalizeGoalToolName(toolName: string): string {
    return baseToolName(toolName);
}

function parseGoalRecord(value: unknown): GoalRecord | null | undefined {
    if (value === null) {
        return null;
    }
    if (!isRecord(value)) {
        return undefined;
    }

    const objective = getNonEmptyString(value, "objective");
    const status = getNonEmptyString(value, "status");
    if (objective === undefined || status === undefined) {
        return undefined;
    }

    return {
        objective,
        status,
        tokensUsed: getNumber(value, "tokensUsed"),
        timeUsedSeconds: getNumber(value, "timeUsedSeconds"),
    };
}

function parseGoalFromResult(result: ThirdPartyToolResult): GoalRecord | null | undefined {
    if (isRecord(result.details)) {
        const goal = parseGoalRecord(result.details.goal);
        if (goal !== undefined) {
            return goal;
        }
    }

    const output = textOutput(result);
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(output);
        if (isRecord(parsed)) {
            return parseGoalRecord(parsed.goal);
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function compactDuration(seconds: number): string {
    const normalized = Math.max(0, Math.trunc(seconds));
    const hours = Math.floor(normalized / 3_600);
    const minutes = Math.floor((normalized % 3_600) / 60);
    if (hours > 0) {
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    if (minutes > 0) {
        return `${minutes}m`;
    }
    return `${normalized}s`;
}

function formatGoalResult(goal: GoalRecord | null | undefined): string | undefined {
    if (goal === null) {
        return "No active goal";
    }
    if (goal === undefined) {
        return undefined;
    }

    const metadata = [
        goal.tokensUsed === undefined ? undefined : `${compactInteger(goal.tokensUsed)} tok`,
        goal.timeUsedSeconds === undefined ? undefined : compactDuration(goal.timeUsedSeconds),
    ].filter(Boolean);
    const suffix = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";
    return `${goal.status}: ${goal.objective}${suffix}`;
}

function goalCallLabel(toolName: string, args: unknown): string {
    const normalized = normalizeGoalToolName(toolName);
    if (normalized === "get_goal") {
        return "Goal Check";
    }
    if (normalized === "create_goal") {
        return "Goal Create";
    }
    if (normalized === "update_goal") {
        if (isRecord(args) && getString(args, "status") === "complete") {
            return "Goal Complete";
        }
        return "Goal Update";
    }
    return "Goal";
}

export function createGoalRenderer(toolName: string): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const body = isRecord(args) ? getString(args, "objective") : undefined;
            return renderThirdPartyCall(theme, {
                state: callState(context),
                statusText: goalCallLabel(toolName, args),
                body,
                maxRenderedLines: 3,
                expanded: context.expanded,
            });
        },
        renderResult(result, options, theme) {
            const formatted = formatGoalResult(parseGoalFromResult(result));
            if (formatted !== undefined && formatted.length > 0) {
                return renderCodexOutput(theme, formatted, {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 2,
                    noOutputLabel: null,
                });
            }
            return renderSimpleResult(theme, result, options);
        },
    };
}

/** Returns whether a tool name belongs to Pi goal tracking. */
export function isGoalTool(toolName: string): boolean {
    const normalized = normalizeGoalToolName(toolName);
    return (
        normalized === "get_goal" || normalized === "create_goal" || normalized === "update_goal"
    );
}
