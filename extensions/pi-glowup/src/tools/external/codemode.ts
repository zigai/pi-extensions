import { makeComponent, wrapPrefixedLine, toolExpandHint } from "../../rendering/component.ts";
import { formatScriptInvocation, type ScriptBlockFormatter } from "../built-in/bash/formatter.ts";
import { PreviewStore } from "../built-in/file-previews.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import {
    detectStructuredOutputLanguage,
    scheduleCodeOutputSyntaxLoad,
} from "../../rendering/syntax/code-component.ts";
import { toolStatusLabel, type ToolLabelMode } from "../../rendering/status-labels.ts";
import { dim, muted, type GlowupRenderTheme } from "../../rendering/theme.ts";
import { renderGlowupCall } from "../../rendering/tool-header.ts";
import { booleanParser, numberParser, stringParser } from "../../json-scalar.ts";
import {
    isJsonArray,
    jsonObjectParser,
    jsonValueParser,
    type JsonValue,
} from "../../json-value.ts";
import { takeGraphemePrefix } from "../../text-boundaries.ts";
import { boundedExpandedResult, callState } from "../call-rendering.ts";
import { previewCompactArgs, textOutput } from "../previews.ts";
import { getArray, getNonEmptyString, getNumber, getString } from "../tool-values.ts";
import { renderExpandableSection } from "../section-expansion.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolResult } from "../types.ts";

const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/u;
const VISIBLE_CALLS = 8;
const MAX_CALLS = 256;

type FormattedCode = { readonly source: string; readonly code: string };

export function createCodemodePreview() {
    const previews = new PreviewStore<FormattedCode>({
        maxEntries: 300,
        maxBytes: 4 * 1024 * 1024,
        measureBytes: ({ source, code }) =>
            Buffer.byteLength(source, "utf8") + Buffer.byteLength(code, "utf8"),
    });
    const invalidations = new Map<string, () => void>();
    const scheduled = new Map<
        string,
        {
            code: string;
            isCurrent: () => boolean;
            invalidate: () => void;
        }
    >();
    let generation = 0;
    let controller = new AbortController();

    return {
        observe(toolCallId: string, invalidate: (() => void) | undefined): void {
            if (invalidate === undefined) return;

            invalidations.delete(toolCallId);
            invalidations.set(toolCallId, invalidate);

            if (invalidations.size > 300) {
                const oldest = invalidations.keys().next().value;
                if (oldest !== undefined) invalidations.delete(oldest);
            }
        },
        get(toolCallId: string, source: string): string | undefined {
            const preview = previews.get(toolCallId);
            return preview?.source === source ? preview.code : undefined;
        },
        schedule(options: {
            readonly toolCallId: string;
            readonly code: string;
            readonly formatter: ScriptBlockFormatter | undefined;
            readonly isCurrent: () => boolean;
            readonly invalidate: () => void;
        }): void {
            if (options.formatter === undefined) return;

            const previous = scheduled.get(options.toolCallId);
            scheduled.set(options.toolCallId, {
                code: options.code,
                isCurrent: options.isCurrent,
                invalidate: options.invalidate,
            });

            if (previous?.code === options.code) return;

            if (scheduled.size > 300) {
                const oldest = scheduled.keys().next().value;
                if (oldest !== undefined) scheduled.delete(oldest);
            }

            const currentGeneration = generation;
            const columns = process.stdout.columns;
            const targetWidth = Number.isFinite(columns) ? Math.max(20, columns - 4) : undefined;

            void formatScriptInvocation(
                { label: "Codemode", language: "javascript", code: options.code },
                options.formatter,
                { signal: controller.signal, ...(targetWidth !== undefined && { targetWidth }) },
            )
                .then((formatted) => {
                    const current = scheduled.get(options.toolCallId);
                    if (
                        formatted.code === options.code ||
                        generation !== currentGeneration ||
                        current?.code !== options.code ||
                        !current.isCurrent()
                    )
                        return;

                    previews.set(options.toolCallId, {
                        source: options.code,
                        code: formatted.code,
                    });

                    invalidations.get(options.toolCallId)?.();
                    current.invalidate();
                })
                .catch(() => {});
        },
        clear(): void {
            generation += 1;
            controller.abort();
            controller = new AbortController();
            previews.clear();
            invalidations.clear();
            scheduled.clear();
        },
    };
}

function formatCost(cost: number): string {
    return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function structuredLines(value: JsonValue, label = "", depth = 0): string[] {
    const prefix = `${"  ".repeat(depth)}${label}`;
    const stringValue = stringParser.parse(value);
    if (stringValue !== undefined) {
        const lines = stringValue.replace(/\r\n?/gu, "\n").split("\n");
        if (lines.at(-1) === "") lines.pop();
        if (lines.length <= 1) return [`${prefix}${lines[0] ?? ""}`];

        return [prefix.trimEnd(), ...lines.map((line) => `${"  ".repeat(depth + 1)}${line}`)];
    }

    const primitive = numberParser.parse(value) ?? booleanParser.parse(value);
    if (primitive !== undefined) return [`${prefix}${primitive}`];
    if (value === null) return [`${prefix}null`];

    let entries: ReadonlyArray<readonly [string, JsonValue]>;
    let empty: string;
    const isArray = isJsonArray(value);
    if (isArray) {
        entries = value.map((item) => ["- ", item]);
        empty = "[]";
    } else {
        const object = jsonObjectParser.parse(value);
        if (object === undefined) throw new Error("Invalid structured output");

        entries = Object.entries(object).map(([key, item]) => [`${key}: `, item]);
        empty = "{}";
    }

    if (entries.length === 0) return [`${prefix}${empty}`];

    const lines = entries.flatMap(([key, item]) =>
        structuredLines(item, key, depth + (label.length > 0 ? 1 : 0)),
    );
    if (label === "- " && !isArray) {
        const childIndent = "  ".repeat(depth + 1);

        return lines.map((line, index) =>
            index === 0 ? `${prefix}${line.slice(childIndent.length)}` : line,
        );
    }

    return [...(label.length > 0 ? [prefix.trimEnd()] : []), ...lines];
}

function displayOutput(text: string): string {
    if (detectStructuredOutputLanguage(text) !== "json") return text;

    try {
        const parsed: unknown = JSON.parse(text);
        const value = jsonValueParser.parse(parsed);
        return value === undefined ? text : structuredLines(value).join("\n");
    } catch {
        return text;
    }
}

function scriptOutput(result: ThirdPartyToolResult): string | undefined {
    if (!Array.isArray(result.content)) return undefined;

    const first = jsonObjectParser.parse(result.content[0]);
    const content =
        getString(first ?? {}, "type") === "text" &&
        SCRIPT_HEADER.test(getString(first ?? {}, "text") ?? "")
            ? result.content.slice(1)
            : result.content;
    const blocks = content
        .map((item) => textOutput({ content: [item] }))
        .filter((text): text is string => text !== undefined)
        .map(displayOutput);

    return blocks.length === 0 ? undefined : blocks.join("\n");
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
    preview?: Pick<ReturnType<typeof createCodemodePreview>, "get" | "observe">,
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const record = jsonObjectParser.parse(args);
            const sourceCode = record === undefined ? undefined : getString(record, "code");

            preview?.observe(context.toolCallId, context.invalidate);

            const code =
                sourceCode === undefined
                    ? undefined
                    : (preview?.get(context.toolCallId, sourceCode) ?? sourceCode);
            if (code !== undefined) {
                scheduleCodeOutputSyntaxLoad({ language: "javascript" }, context.invalidate, code);
            }

            return renderExpandableSection(context, "call", (expanded) => {
                const header = renderGlowupCall(theme, {
                    state: callState(context),
                    statusText: toolStatusLabel(labelMode, context, {
                        static: "Codemode",
                        active: "Running code",
                        completed: "Ran code",
                    }),
                });
                const source = renderGlowupOutput(theme, code, {
                    expanded,
                    mode: "head",
                    maxPreviewLines: 8,
                    prefixFirst: dim(theme, "  │ "),
                    prefixRest: dim(theme, "  │ "),
                    dimContent: false,
                    noOutputLabel: null,
                    syntax: { language: "javascript" },
                });

                return makeComponent((width) => [...header.render(width), ...source.render(width)]);
            });
        },
        renderResult(result, options, theme, context) {
            const text = options.isPartial ? undefined : scriptOutput(result);

            return renderExpandableSection(
                { ...context, expanded: options.expanded },
                "result",
                (expanded) => {
                    const rows = callRows(result, theme, expanded);
                    const output = renderGlowupOutput(
                        theme,
                        expanded ? boundedExpandedResult(text) : text,
                        {
                            expanded,
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
            );
        },
    };
}
