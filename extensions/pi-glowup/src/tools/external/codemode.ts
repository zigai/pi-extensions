import { makeComponent, wrapPrefixedLine, toolExpandHint } from "../../rendering/component.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import { scheduleCodeOutputSyntaxLoad } from "../../rendering/syntax/code-component.ts";
import { toolStatusLabel, type ToolLabelMode } from "../../rendering/status-labels.ts";
import { dim, muted, type GlowupRenderTheme } from "../../rendering/theme.ts";
import { renderGlowupCall } from "../../rendering/tool-header.ts";
import { jsonObjectParser, jsonValueParser } from "../../json-value.ts";
import { takeGraphemePrefix } from "../../text-boundaries.ts";
import { boundedExpandedResult, callState } from "../call-rendering.ts";
import { previewCompactArgs, textOutput } from "../previews.ts";
import { getArray, getNonEmptyString, getNumber, getString } from "../tool-values.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolResult } from "../types.ts";

const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/u;
const VISIBLE_CALLS = 8;
const MAX_CALLS = 256;

function formatCost(cost: number): string {
    return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function scriptOutput(result: ThirdPartyToolResult): string | undefined {
    if (!Array.isArray(result.content)) return undefined;

    const first = jsonObjectParser.parse(result.content[0]);
    const content =
        getString(first ?? {}, "type") === "text" &&
        SCRIPT_HEADER.test(getString(first ?? {}, "text") ?? "")
            ? result.content.slice(1)
            : result.content;

    return textOutput({ content });
}

function callRows(
    result: ThirdPartyToolResult,
    theme: GlowupRenderTheme,
    expanded: boolean,
): string[] {
    const details = jsonObjectParser.parse(result.details);
    const calls = details === undefined ? undefined : getArray(details, "calls");
    if (calls === undefined || calls.length === 0) return [];

    const displayed = calls.slice(expanded ? -MAX_CALLS : -VISIBLE_CALLS);
    const rows: string[] = [];
    if (calls.length > displayed.length) {
        rows.push(
            muted(
                theme,
                `… ${calls.length - displayed.length} earlier calls (${toolExpandHint()})`,
            ),
        );
    }

    for (const value of displayed) {
        const call = jsonObjectParser.parse(value);
        if (call === undefined) continue;

        const name = getNonEmptyString(call, "name");
        if (name === undefined) continue;

        const status = getString(call, "status");
        const icon =
            status === "ok"
                ? theme.fg("success", "✓")
                : status === "error"
                  ? theme.fg("error", "✗")
                  : status === "cancelled"
                    ? muted(theme, "⊘")
                    : theme.fg("warning", "…");
        const args = getString(call, "args");
        let preview: string | undefined;
        if (args !== undefined) {
            try {
                preview = previewCompactArgs(jsonValueParser.parse(JSON.parse(args)));
            } catch {
                preview = undefined;
            }
        }

        const compact = preview?.replace(/\s+/gu, " ");
        const duration = getNumber(call, "durationMs");
        const timing =
            duration === undefined || duration < 0
                ? ""
                : ` ${duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}`;
        const cost = getNumber(call, "cost");
        const price = cost === undefined || cost <= 0 ? "" : ` ${formatCost(cost)}`;

        rows.push(
            `${icon} ${theme.fg("toolTitle", name)}${compact !== undefined && compact.length > 0 ? ` ${muted(theme, takeGraphemePrefix(compact, 100))}` : ""}${dim(theme, `${timing}${price}`)}`,
        );
    }

    const priced = calls
        .map((value) => jsonObjectParser.parse(value))
        .map((call) => (call === undefined ? undefined : getNumber(call, "cost")))
        .filter((cost): cost is number => cost !== undefined && cost > 0);
    if (priced.length > 1) {
        rows.push(
            muted(theme, `Model calls: ${formatCost(priced.reduce((sum, cost) => sum + cost, 0))}`),
        );
    }

    return rows;
}

export function createCodemodeRenderer(
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const record = jsonObjectParser.parse(args);
            const code = record === undefined ? undefined : getString(record, "code");
            if (code !== undefined) {
                scheduleCodeOutputSyntaxLoad({ language: "javascript" }, context.invalidate, code);
            }

            const header = renderGlowupCall(theme, {
                state: callState(context),
                statusText: toolStatusLabel(labelMode, context, {
                    static: "Codemode",
                    active: "Running code",
                    completed: "Ran code",
                }),
            });
            const source = renderGlowupOutput(theme, code, {
                expanded: context.expanded,
                mode: "head",
                maxPreviewLines: 8,
                prefixFirst: dim(theme, "  │ "),
                prefixRest: dim(theme, "  │ "),
                dimContent: false,
                noOutputLabel: null,
                syntax: { language: "javascript" },
            });

            return makeComponent((width) => [...header.render(width), ...source.render(width)]);
        },
        renderResult(result, options, theme) {
            const rows = callRows(result, theme, options.expanded);
            const text = options.isPartial ? undefined : scriptOutput(result);
            const output = renderGlowupOutput(
                theme,
                options.expanded ? boundedExpandedResult(text) : text,
                {
                    expanded: options.expanded,
                    mode: "head",
                    maxPreviewLines: 5,
                    noOutputLabel: null,
                },
            );

            return makeComponent((width) => [
                ...rows.flatMap((row) => wrapPrefixedLine(row, width, "  │ ", "  │ ")),
                ...output.render(width),
            ]);
        },
    };
}
