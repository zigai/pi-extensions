import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { CodePreview, CodeSource } from "../../rendering/streaming/presentation.ts";
import { makeComponent, wrapPrefixedLine, toolExpandHint } from "../../rendering/component.ts";
import type { ScriptBlockFormatter } from "../built-in/bash/formatter.ts";
import { recordScriptAnalysis } from "../built-in/bash/script-analysis.ts";
import { recordRenderError, renderDiagnosticsEnabled } from "../../diagnostics/render-events.ts";
import { observeComponentFormat } from "../../diagnostics/highlight-requests.ts";
import { omitLeadingImportPrologue } from "../built-in/bash/prologue.ts";
import { PreviewStore } from "../built-in/file-previews.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import {
    detectStructuredOutputLanguage,
    renderSyntaxComponent,
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
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolResult,
    ThirdPartyToolRenderContext,
} from "../types.ts";

const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/u;
const VISIBLE_CALLS = 8;
const MAX_CALLS = 256;

type CodemodeSchedule = {
    readonly toolCallId: string;
    readonly code: string;
    readonly formatter: ScriptBlockFormatter | undefined;
    readonly isCurrent: () => boolean;
    readonly invalidate: () => void;
    readonly completed?: boolean;
    readonly signal?: AbortSignal;
};

type CodemodeInvalidation = { callback: () => void; readonly invalidate: () => void };

type CodemodeWork = {
    options: CodemodeSchedule;
    width: number | undefined;
    controller: AbortController;
    completed: boolean;
    ready: boolean;
    running: boolean;
};

export type CodemodePreviewReadOptions = {
    readonly contentWidth: number;
    readonly completed: boolean;
    readonly expanded: boolean;
};

export function createCodemodePreview(formatterAccessor?: () => ScriptBlockFormatter | undefined) {
    const previews = new PreviewStore<{ readonly work: CodemodeWork; readonly code: string }>({
        maxEntries: 300,
        maxBytes: 4 * 1024 * 1024,
        measureBytes: ({ code }) => Buffer.byteLength(code, "utf8"),
    });
    const invalidations = new Map<string, CodemodeInvalidation>();
    const scheduled = new Map<string, CodemodeWork>();
    let generation = 0;

    function invalidate(work: CodemodeWork): void {
        invalidations.get(work.options.toolCallId)?.invalidate();
        work.options.invalidate();
    }

    function complete(work: CodemodeWork): void {
        if (work.completed) return;

        work.completed = true;
        if (work.ready)
            queueMicrotask(() => {
                if (scheduled.get(work.options.toolCallId) === work && work.options.isCurrent())
                    invalidate(work);
            });
    }

    async function format(work: CodemodeWork): Promise<void> {
        if (work.width === undefined) return;

        const controller = new AbortController();
        work.controller = controller;

        const { options, width } = work;
        let signal = controller.signal;
        if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);

        const code = await options
            .formatter?.(
                { label: "Codemode", language: "javascript", code: options.code },
                {
                    signal,
                    targetWidth: width,
                    diagnostics: {
                        toolCallId: options.toolCallId,
                        stage: "block",
                        segmentCode: options.code,
                    },
                },
            )
            .catch((cause: unknown) => {
                if (!signal.aborted)
                    recordRenderError("codemode.format", cause, options.toolCallId);

                return undefined;
            });
        if (
            code === undefined ||
            signal.aborted ||
            scheduled.get(options.toolCallId) !== work ||
            work.controller !== controller ||
            work.width !== width ||
            !work.options.isCurrent()
        )
            return;

        previews.set(options.toolCallId, { work, code });
        work.ready = true;
        if (work.completed) invalidate(work);
    }

    function requestFormatting(work: CodemodeWork): void {
        if (work.running) return;

        work.running = true;
        void (async () => {
            while (
                scheduled.get(work.options.toolCallId) === work &&
                work.options.isCurrent() &&
                work.options.signal?.aborted !== true
            ) {
                const width = work.width;
                await format(work);

                if (work.width === width) return;
            }
        })().finally(() => {
            work.running = false;
        });
    }

    const feature = {
        analyze(toolCallId: string, code: string): void {
            recordScriptAnalysis({
                toolName: "codemode",
                toolCallId,
                command: code,
                formatter: formatterAccessor?.() ?? scheduled.get(toolCallId)?.options.formatter,
            });
        },
        observe(
            toolCallId: string,
            callback: (() => void) | undefined,
            completed = false,
        ): (() => void) | undefined {
            const work = scheduled.get(toolCallId);
            if (completed && work !== undefined) complete(work);
            if (callback === undefined) return invalidations.get(toolCallId)?.invalidate;

            let observation = invalidations.get(toolCallId);
            if (observation === undefined) {
                const owner: CodemodeInvalidation = {
                    callback,
                    invalidate: () => owner.callback(),
                };

                observation = owner;
            } else observation.callback = callback;

            invalidations.delete(toolCallId);
            invalidations.set(toolCallId, observation);

            if (invalidations.size > 300) {
                const oldest = invalidations.keys().next().value;
                if (oldest !== undefined) invalidations.delete(oldest);
            }

            return observation.invalidate;
        },
        get(
            toolCallId: string,
            source: string,
            read?: CodemodePreviewReadOptions,
        ): string | undefined {
            let work = scheduled.get(toolCallId);
            if ((work === undefined || work.options.code !== source) && read?.completed === true) {
                const formatter = formatterAccessor?.();
                const callback = invalidations.get(toolCallId)?.invalidate;
                if (formatter !== undefined && callback !== undefined) {
                    const currentGeneration = generation;

                    feature.schedule({
                        toolCallId,
                        code: source,
                        formatter,
                        completed: true,
                        isCurrent: () => generation === currentGeneration,
                        invalidate: callback,
                    });
                    work = scheduled.get(toolCallId);
                }
            }

            if (work === undefined || work.options.code !== source || !work.options.isCurrent())
                return undefined;

            if (read !== undefined) {
                if (read.completed) complete(work);

                if (work.width !== read.contentWidth) {
                    work.width = read.contentWidth;
                    queueMicrotask(() => {
                        if (
                            scheduled.get(toolCallId) === work &&
                            work.options.isCurrent() &&
                            work.width === read.contentWidth
                        )
                            requestFormatting(work);
                    });
                }

                if (read.expanded) return undefined;
            }

            if (!work.completed || !work.ready) return undefined;

            const preview = previews.get(toolCallId);
            if (preview?.work !== work) return undefined;

            const profile = work.options.formatter?.profileFor?.("javascript");
            if (
                profile === undefined ||
                profile.kind === "command" ||
                profile.kind === "bash" ||
                profile.kind === "awk" ||
                profile.kind === "jq" ||
                profile.imports === "show"
            )
                return preview.code;

            const omission = omitLeadingImportPrologue(preview.code, "javascript", 0);
            return omission !== undefined
                ? `… ${omission.omittedLines} import/setup lines omitted\n${omission.code}`
                : preview.code;
        },
        schedule(options: CodemodeSchedule): void {
            recordScriptAnalysis({
                toolName: "codemode",
                toolCallId: options.toolCallId,
                command: options.code,
                formatter: options.formatter,
            });

            const previous = scheduled.get(options.toolCallId);
            if (
                previous?.options.code === options.code &&
                previous.options.formatter === options.formatter
            ) {
                previous.options = options;

                if (options.completed === true) complete(previous);
                return;
            }

            previous?.controller.abort();
            scheduled.delete(options.toolCallId);

            if (options.formatter === undefined) return;

            const work: CodemodeWork = {
                options,
                width: previous?.width,
                controller: new AbortController(),
                completed: options.completed ?? false,
                ready: false,
                running: false,
            };

            scheduled.set(options.toolCallId, work);

            if (scheduled.size > 300) {
                const oldest = scheduled.keys().next().value;
                if (oldest !== undefined) {
                    scheduled.get(oldest)?.controller.abort();
                    scheduled.delete(oldest);
                }
            }

            requestFormatting(work);
        },
        clear(): void {
            generation += 1;

            for (const work of scheduled.values()) work.controller.abort();
            previews.clear();
            invalidations.clear();
            scheduled.clear();
        },
    };

    return feature;
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

        // Codemode cuts long argument previews mid-JSON, so they are parsed as partial JSON.
        const preview =
            args === undefined
                ? undefined
                : previewCompactArgs(jsonValueParser.parse(parseStreamingJson(args)));

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

function callSource(
    args: JsonValue | undefined,
    context: Pick<ThirdPartyToolRenderContext, "toolCallId">,
): CodeSource | undefined {
    const record = jsonObjectParser.parse(args);
    if (record === undefined) return undefined;

    const source = getString(record, "code");
    if (source === undefined) return undefined;

    return { key: `tool:${context.toolCallId}:codemode`, source, language: "javascript" };
}

export function createCodemodeRenderer(
    labelMode: ToolLabelMode = "static",
    preview: Pick<ReturnType<typeof createCodemodePreview>, "get" | "observe"> &
        Partial<
            Pick<ReturnType<typeof createCodemodePreview>, "analyze">
        > = createCodemodePreview(),
    streamCode?: CodePreview,
): ThirdPartyToolRenderer {
    return {
        codeSource: callSource,
        // A component may outlive many streaming updates. Never close over its predecessor.
        renderCall(args, theme, { lastComponent: _lastComponent, ...context }) {
            const sourceCode = callSource(args, context)?.source;
            if (context.argsComplete && sourceCode !== undefined)
                preview.analyze?.(context.toolCallId, sourceCode);

            const completed =
                context.phase === "complete" ||
                (context.result !== undefined && !context.isPartial);
            const invalidate = preview.observe(context.toolCallId, context.invalidate, completed);

            return renderExpandableSection(context, "call", (expanded) => {
                const header = renderGlowupCall(theme, {
                    state: callState(context),
                    statusText: toolStatusLabel(labelMode, context, {
                        static: "Codemode",
                        active: "Running code",
                        completed: "Ran code",
                    }),
                });

                const body = makeComponent((width) => {
                    let code: string | undefined;
                    let formatted: string | undefined;
                    if (sourceCode !== undefined) {
                        if (streamCode !== undefined) {
                            code = streamCode({
                                key: `tool:${context.toolCallId}:codemode`,
                                source: sourceCode,
                                language: "javascript",
                                complete: context.argsComplete || context.isError,
                                targetWidth: Math.max(1, width - 4),
                                ...(invalidate !== undefined && { invalidate }),
                                toolCallId: context.toolCallId,
                            });
                        } else {
                            formatted = preview.get(context.toolCallId, sourceCode, {
                                contentWidth: Math.max(1, width - 4),
                                completed,
                                expanded,
                            });
                            code = formatted ?? sourceCode;
                        }
                    }

                    const source = renderGlowupOutput(theme, code, {
                        expanded,
                        mode: "head",
                        maxPreviewLines: 8,
                        prefixFirst: dim(theme, "  │ "),
                        prefixRest: dim(theme, "  │ "),
                        dimContent: false,
                        noOutputLabel: null,
                        syntax: { language: "javascript", invalidate },
                        ...(sourceCode !== undefined && { syntaxSource: sourceCode }),
                    });

                    const lines = [...header.render(width), ...source.render(width)];

                    if (
                        renderDiagnosticsEnabled() &&
                        invalidate !== undefined &&
                        sourceCode !== undefined &&
                        formatted !== undefined
                    )
                        observeComponentFormat(invalidate, {
                            state: "ready",
                            source: sourceCode,
                            output: formatted,
                        });

                    return lines;
                });
                if (invalidate === undefined) return body;

                return {
                    render: (width) => renderSyntaxComponent(body, invalidate, width),
                    invalidate: () => body.invalidate(),
                };
            });
        },
        renderResult(result, options, theme, context) {
            preview.observe(context.toolCallId, context.invalidate, !options.isPartial);

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
