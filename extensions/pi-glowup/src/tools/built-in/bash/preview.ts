import type { Component } from "@earendil-works/pi-tui";
import { createSyntaxComponent } from "../../../rendering/syntax/component-owner.ts";
import type { ShellLayout, ShellOperatorPosition, ShellOutputStyle } from "./command.ts";
import { type JsonValue } from "../../../json-value.ts";
import { emptyComponent, makeComponent } from "../../../rendering/component.ts";
import type { CodePreview } from "../../../rendering/streaming/presentation.ts";
import { parseScriptInvocation, type ScriptInvocation } from "./invocation.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../../rendering/output.ts";
import { renderScriptCall } from "./script-renderer.ts";
import { shouldDeferSimpleToolCall } from "../../../rendering/status-labels.ts";
import { detectStructuredOutputLanguage } from "../../../rendering/syntax/code-component.ts";
import { commandField, textOutput } from "../arguments.ts";
import {
    trimOldestMapEntries,
    type BuiltInRenderContext,
    type BuiltInRenderTheme,
    type BuiltInResultOptions,
    type TextResult,
} from "../context.ts";
import {
    formatAndStoreScriptPreview,
    hasEmbeddedSource,
    rememberRawScriptPreview,
    scriptForPreview,
} from "./format-preview.ts";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "./formatter.ts";
import {
    boundedScriptPreview,
    createScriptPreviewStore,
    MAX_SCRIPT_PREVIEW_ENTRIES,
} from "./preview-store.ts";
import { renderBashCommandCall, type BashCommandRenderOptions } from "./renderer.ts";
import { StreamingScriptIdentityStore } from "./streaming-identity.ts";
import { renderExpandableSection } from "../../section-expansion.ts";
import {
    recordRenderError,
    renderDiagnosticsEnabled,
    type ScriptSegmentDiagnostic,
} from "../../../diagnostics/render-events.ts";
import { recordScriptAnalysis } from "./script-analysis.ts";

type ScriptPreviewSchedule = {
    readonly toolCallId: string;
    readonly command: string;
    readonly formatter: ScriptBlockFormatter | undefined;
    readonly signal: AbortSignal | undefined;
    readonly targetWidth?: number;
    readonly completed?: boolean;
    readonly isCurrent: () => boolean;
    readonly invalidate: () => void;
};

type ScheduledPreview = {
    readonly options: ScriptPreviewSchedule;
    targetWidth: number | undefined;
    controller: AbortController;
    completion: Promise<void>;
    completed: boolean;
    ready: boolean;
    running: boolean;
    expandedScript: ScriptInvocation | undefined;
};

type StreamingScriptRenderState = {
    readonly toolCallId: string;
    readonly signal: AbortSignal | undefined;
    readonly invalidate: () => void;
    preview: Component | undefined;
};

const streamingScriptRenderStates = new WeakMap<Component, StreamingScriptRenderState>();

function renderStreamingScriptCall(
    invocation: ScriptInvocation,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    streamCode: CodePreview,
    signal: AbortSignal | undefined,
    options: Omit<BashCommandRenderOptions, "expanded">,
) {
    const { toolCallId, argsComplete, isError } = context;
    let current = context.lastComponent;

    return renderExpandableSection(context, "call", (expanded) => {
        const rendered = createSyntaxComponent(
            current,
            options.invalidate,
            (invalidate, previous) => {
                let renderState: StreamingScriptRenderState = {
                    toolCallId,
                    signal,
                    preview: undefined,
                    invalidate: () => {
                        if (signal?.aborted !== true) invalidate();
                    },
                };
                if (previous !== undefined) {
                    const retained = streamingScriptRenderStates.get(previous);
                    if (retained?.toolCallId === toolCallId && retained.signal === signal)
                        renderState = retained;
                }

                const component = makeComponent((width) => {
                    if (signal?.aborted === true) return [];

                    const code = streamCode({
                        key: `tool:${toolCallId}:script:${invocation.language}`,
                        source: invocation.code,
                        language: invocation.language,
                        complete: argsComplete || isError,
                        targetWidth: Math.max(1, width - 6),
                        invalidate: renderState.invalidate,
                        ...(signal !== undefined && { signal }),
                        toolCallId,
                    });

                    // Statement publication and shell layout are independent: lay out only
                    // the published snapshot, never expose the unfinished source tail.
                    const preview = renderBashCommandCall(theme, code, {
                        ...options,
                        expanded,
                        invalidate: renderState.invalidate,
                        pureScriptOverride: { ...invocation, code },
                        lastComponent: renderState.preview,
                    });

                    renderState.preview = preview;
                    return preview.render(width);
                });

                // Host invalidations rebuild this wrapper. Retain the child syntax owner
                // instead of flashing plain text and tokenizing the same script again.
                streamingScriptRenderStates.set(component, renderState);

                return component;
            },
        );

        // Expansion callbacks outlive this render. Replace their previous component
        // reference instead of retaining every historical host row through a closure.
        current = rendered;
        return rendered;
    });
}

export function createNativeBashFeature(
    formatterAccessor?: () => ScriptBlockFormatter | undefined,
    formatEmbedded?: (
        input: ScriptBlockFormatterInput,
        formatter: ScriptBlockFormatter,
        options: ScriptBlockFormatterOptions,
    ) => Promise<string>,
) {
    const scriptPreviews = createScriptPreviewStore();
    const scheduledCommands = new Map<string, ScheduledPreview>();
    const renderWidths = new Map<string, { contentWidth: number; renderWidth: number }>();
    const PARTIAL_BASH_COMMAND_PREVIEW_CHARS = 4_000;
    const streamingScriptIdentities = new StreamingScriptIdentityStore();
    const bashRenderInvalidations = new Map<string, () => void>();
    const MAX_BASH_RENDER_INVALIDATIONS = 300;
    const livePreviews = new Map<
        string,
        { readonly language: string; readonly controller: AbortController }
    >();

    function retireLivePreview(toolCallId: string): void {
        const live = livePreviews.get(toolCallId);
        livePreviews.delete(toolCallId);
        live?.controller.abort();
    }

    function livePreviewSignal(toolCallId: string, language: string): AbortSignal {
        let live = livePreviews.get(toolCallId);
        if (live?.language === language) return live.controller.signal;

        retireLivePreview(toolCallId);
        live = { language, controller: new AbortController() };
        livePreviews.set(toolCallId, live);

        while (livePreviews.size > MAX_BASH_RENDER_INVALIDATIONS) {
            const oldest = livePreviews.keys().next().value;
            if (oldest === undefined) break;

            retireLivePreview(oldest);
        }

        return live.controller.signal;
    }

    function rememberBashRenderInvalidation(
        toolCallId: string,
        invalidate: (() => void) | undefined,
    ): void {
        if (invalidate === undefined) return;

        bashRenderInvalidations.delete(toolCallId);
        bashRenderInvalidations.set(toolCallId, invalidate);
        trimOldestMapEntries(bashRenderInvalidations, MAX_BASH_RENDER_INVALIDATIONS);
    }

    function partialBashCommandPreview(command: string): string {
        if (command.length <= PARTIAL_BASH_COMMAND_PREVIEW_CHARS) {
            return command;
        }

        return `${command.slice(0, PARTIAL_BASH_COMMAND_PREVIEW_CHARS)}\n… command preview truncated while streaming`;
    }

    function renderBashCall(
        args: JsonValue | undefined,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        maxCodePreviewLines: () => number,
        showPrologueOmission: () => boolean,
        shellLayout: () => ShellLayout,
        shellOperatorPosition: () => ShellOperatorPosition,
        streamCode?: CodePreview,
    ) {
        rememberBashRenderInvalidation(context.toolCallId, context.invalidate);

        const state = context.isError ? "error" : context.isPartial ? "running" : "success";
        const command = commandField(args) ?? "";

        if (context.argsComplete || context.isError || streamCode === undefined)
            retireLivePreview(context.toolCallId);

        if (context.argsComplete && renderDiagnosticsEnabled()) {
            // The completed preview records analysis after embedded decisions are known.
            const formatter =
                formatterAccessor?.() ??
                scheduledCommands.get(context.toolCallId)?.options.formatter;
            if (
                formatter === undefined ||
                scriptForPreview(command, formatter, formatEmbedded !== undefined) === undefined
            ) {
                recordScriptAnalysis({
                    toolName: "bash",
                    toolCallId: context.toolCallId,
                    command,
                    formatter,
                });
            }
        }

        if (
            streamCode !== undefined &&
            ((!context.argsComplete && !context.isError) || formatterAccessor?.() === undefined)
        ) {
            let script = streamingScriptIdentities.resolve(context.toolCallId, command);
            if (context.argsComplete)
                script = streamingScriptIdentities.finalize(
                    context.toolCallId,
                    parseScriptInvocation(command),
                );

            const invocation = script ?? { label: "Bash", language: "bash", code: command };
            const profile = formatterAccessor?.()?.profileFor?.(invocation.language);
            let signal: AbortSignal | undefined;
            if (!context.argsComplete && !context.isError)
                signal = livePreviewSignal(context.toolCallId, invocation.language);

            return renderStreamingScriptCall(invocation, theme, context, streamCode, signal, {
                state,
                maxCodePreviewLines: maxCodePreviewLines(),
                showPrologueOmission: showPrologueOmission(),
                shellLayout: shellLayout(),
                shellOperatorPosition: shellOperatorPosition(),
                invalidate: context.invalidate,
                durationMs: context.durationMs,
                ...(profile !== undefined && { profile }),
            });
        }

        if (
            shouldDeferSimpleToolCall(context) &&
            scriptPreviews.get(context.toolCallId) === undefined
        ) {
            const partialScript = streamingScriptIdentities.resolve(
                context.toolCallId,
                partialBashCommandPreview(command),
            );
            if (partialScript === undefined) {
                return emptyComponent();
            }

            return renderScriptCall(theme, partialScript, {
                state,
                expanded: false,
                maxCodePreviewLines: maxCodePreviewLines(),
                showPrologueOmission: showPrologueOmission(),
                invalidate: context.invalidate,
                durationMs: context.durationMs,
                lastComponent: context.lastComponent,
            });
        }

        if (streamCode !== undefined && (context.argsComplete || context.isError)) {
            const formatter = formatterAccessor?.();
            if (formatter !== undefined)
                schedule({
                    toolCallId: context.toolCallId,
                    command,
                    formatter,
                    signal: undefined,
                    completed: true,
                    isCurrent: () => true,
                    invalidate: context.invalidate,
                });
        }

        const displayCommand = context.argsComplete ? command : partialBashCommandPreview(command);
        const scheduled = scheduledCommands.get(context.toolCallId);

        if (context.result !== undefined && !context.isPartial) completePreview(context.toolCallId);

        const parsedScript = scriptForPreview(
            displayCommand,
            scheduled?.options.formatter,
            formatEmbedded !== undefined,
        );
        const profile = scheduled?.options.formatter?.profileFor?.(parsedScript?.language ?? "");
        const profiled =
            profile !== undefined ||
            (formatEmbedded !== undefined &&
                parsedScript?.language === "bash" &&
                (displayCommand.includes("<<") ||
                    hasEmbeddedSource(displayCommand, scheduled?.options.formatter)));
        let script = scriptPreviews.get(context.toolCallId);
        if (profiled && scheduled?.completed !== true) script = undefined;

        if (script === undefined && parsedScript !== undefined)
            script = boundedScriptPreview(parsedScript);

        let stableScript = script;
        if (context.argsComplete) {
            stableScript = streamingScriptIdentities.finalize(context.toolCallId, script) ?? script;
        }

        let bashOptions: BashCommandRenderOptions = {
            state,
            expanded: context.expanded,
            maxCodePreviewLines: maxCodePreviewLines(),
            showPrologueOmission: showPrologueOmission(),
            shellLayout: shellLayout(),
            shellOperatorPosition: shellOperatorPosition(),
            invalidate: context.invalidate,
            durationMs: context.durationMs,
        };
        if (stableScript !== undefined && context.argsComplete) {
            const { toolCallId } = context;

            bashOptions = {
                ...bashOptions,
                onContentWidth: (contentWidth, renderWidth) =>
                    rememberRenderWidth(toolCallId, contentWidth, renderWidth),
            };
        }

        if (stableScript !== undefined) {
            bashOptions = { ...bashOptions, pureScriptOverride: stableScript };
        }

        if (profile !== undefined && scheduled?.completed === true && scheduled.ready) {
            bashOptions = { ...bashOptions, profile };
        }

        // The expansion handler outlives this render. Reuse syntax ownership without
        // retaining a chain of previous transcript components through its closure.
        let previous = context.lastComponent;

        return renderExpandableSection(context, "call", (expanded) => {
            let options = { ...bashOptions, expanded, lastComponent: previous };
            if (expanded && profiled && parsedScript !== undefined) {
                let expandedScript = parsedScript;
                if (
                    scheduled?.completed === true &&
                    scheduled.ready &&
                    scheduled.expandedScript !== undefined
                )
                    expandedScript = scheduled.expandedScript;

                options = {
                    ...options,
                    pureScriptOverride: expandedScript,
                    shellLayout: "preserve",
                };
            }

            const component = renderBashCommandCall(theme, displayCommand, options);
            previous = component;
            return component;
        });
    }

    function renderBashResult(
        result: TextResult,
        options: BuiltInResultOptions,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        shellOutputStyle: () => ShellOutputStyle,
    ) {
        if (!options.isPartial) completePreview(context.toolCallId);

        const output = textOutput(result);
        const language = detectStructuredOutputLanguage(output);
        let prefix = "";
        if (shellOutputStyle() === "gutter") prefix = theme.fg("dim", "│ ");

        let outputOptions: GlowupOutputRenderOptions = {
            expanded: options.expanded,
            mode: "headTail",
            maxPreviewLines: 5,
            invalidate: context.invalidate,
            prefixFirst: prefix,
            prefixRest: prefix,
        };
        if (language !== undefined) {
            outputOptions = { ...outputOptions, syntax: { language } };
        }

        return renderExpandableSection(
            { ...context, expanded: options.expanded },
            "result",
            (expanded) => renderGlowupOutput(theme, output, { ...outputOptions, expanded }),
        );
    }

    function clear(): void {
        for (const toolCallId of livePreviews.keys()) retireLivePreview(toolCallId);
        scriptPreviews.clear();

        for (const scheduled of scheduledCommands.values()) scheduled.controller.abort();
        scheduledCommands.clear();
        renderWidths.clear();
        bashRenderInvalidations.clear();
        streamingScriptIdentities.clear();
    }

    function remember(toolCallId: string, command: string, formatter?: ScriptBlockFormatter): void {
        rememberRawScriptPreview(
            scriptPreviews,
            toolCallId,
            command,
            formatter,
            formatEmbedded !== undefined,
        );
    }

    function invalidatePreview(scheduled: ScheduledPreview): void {
        bashRenderInvalidations.get(scheduled.options.toolCallId)?.();
        scheduled.options.invalidate();
    }

    function completePreview(toolCallId: string): void {
        const scheduled = scheduledCommands.get(toolCallId);
        if (scheduled === undefined || scheduled.completed) return;

        scheduled.completed = true;
        if (!scheduled.ready) return;

        queueMicrotask(() => {
            if (scheduledCommands.get(toolCallId) === scheduled && scheduled.options.isCurrent()) {
                invalidatePreview(scheduled);
            }
        });
    }

    async function formatPreview(scheduled: ScheduledPreview): Promise<void> {
        const controller = new AbortController();
        scheduled.controller = controller;

        const { options, targetWidth } = scheduled;
        let signal = controller.signal;
        if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);

        let previewFormatter = options.formatter;
        let expandedScript: ScriptInvocation | undefined;
        const backend = options.formatter;
        if (backend !== undefined && formatEmbedded !== undefined) {
            previewFormatter = Object.assign(
                async (
                    input: ScriptBlockFormatterInput,
                    formatterOptions: ScriptBlockFormatterOptions = {},
                ) => {
                    let code = input.code;
                    if (input.language === "bash") {
                        code = await formatEmbedded(input, backend, formatterOptions);
                        if (code !== input.code) {
                            const candidate = { label: "Bash", language: "bash", code };

                            // Large expanded calls can still use their original
                            // input; do not retain another unbounded source copy.
                            if (boundedScriptPreview(candidate) === candidate)
                                expandedScript = candidate;
                        }
                    }

                    const formatted = await backend({ ...input, code }, formatterOptions);
                    if (formatted !== undefined) return formatted;
                    if (code !== input.code) return code;
                    return undefined;
                },
                { ...(backend.profileFor !== undefined && { profileFor: backend.profileFor }) },
            );
        }

        let heredocs: ScriptSegmentDiagnostic[] | undefined;
        let recordSegment: ((segment: ScriptSegmentDiagnostic) => void) | undefined;
        if (renderDiagnosticsEnabled()) {
            const recorded: ScriptSegmentDiagnostic[] = [];

            recordSegment = (segment) => {
                heredocs = recorded;
                recorded.push(segment);
            };
        }

        const formatted = await formatAndStoreScriptPreview({
            sink: scriptPreviews,
            toolCallId: options.toolCallId,
            command: options.command,
            formatter: previewFormatter,
            embeddedHeredocs: formatEmbedded !== undefined,
            signal,
            ...(targetWidth !== undefined && { targetWidth }),
            ...(recordSegment !== undefined && { recordSegment }),
            isCurrent: () =>
                !signal.aborted &&
                options.isCurrent() &&
                scheduledCommands.get(options.toolCallId) === scheduled &&
                scheduled.controller === controller &&
                scheduled.targetWidth === targetWidth,
        }).catch((cause: unknown) => {
            if (!signal.aborted)
                recordRenderError("bash.format-preview", cause, options.toolCallId);

            return false;
        });

        if (
            signal.aborted ||
            !options.isCurrent() ||
            scheduledCommands.get(options.toolCallId) !== scheduled ||
            scheduled.controller !== controller ||
            scheduled.targetWidth !== targetWidth
        )
            return;

        if (recordSegment !== undefined) {
            let heredocSkipReason: string | undefined;
            if (formatEmbedded === undefined) heredocSkipReason = "embedded-formatting-disabled";

            recordScriptAnalysis({
                toolName: "bash",
                toolCallId: options.toolCallId,
                command: options.command,
                formatter: options.formatter,
                formatted,
                ...(heredocs !== undefined && { heredocs }),
                ...(heredocSkipReason !== undefined && { heredocSkipReason }),
                displayCode: scriptPreviews.get(options.toolCallId)?.code ?? options.command,
            });
        }

        if (!formatted) return;

        scheduled.ready = true;
        scheduled.expandedScript = expandedScript;

        const script = scriptPreviews.get(options.toolCallId);
        const profile = options.formatter?.profileFor?.(script?.language ?? "");
        if ((profile !== undefined || expandedScript !== undefined) && !scheduled.completed) return;

        invalidatePreview(scheduled);
    }

    function requestFormatting(scheduled: ScheduledPreview): void {
        if (scheduled.running) return;

        scheduled.running = true;
        scheduled.completion = (async () => {
            while (
                scheduledCommands.get(scheduled.options.toolCallId) === scheduled &&
                scheduled.options.isCurrent() &&
                scheduled.options.signal?.aborted !== true
            ) {
                const width = scheduled.targetWidth;
                await formatPreview(scheduled);

                if (scheduled.targetWidth === width) return;
            }
        })().finally(() => {
            scheduled.running = false;
        });
    }

    function rememberRenderWidth(
        toolCallId: string,
        contentWidth: number,
        renderWidth: number,
    ): void {
        const previous = renderWidths.get(toolCallId);
        if (previous?.renderWidth === renderWidth) {
            contentWidth = Math.min(previous.contentWidth, contentWidth);
        }

        renderWidths.delete(toolCallId);
        renderWidths.set(toolCallId, { contentWidth, renderWidth });
        trimOldestMapEntries(renderWidths, MAX_BASH_RENDER_INVALIDATIONS);

        const scheduled = scheduledCommands.get(toolCallId);
        if (scheduled === undefined || scheduled.targetWidth === contentWidth) return;

        scheduled.targetWidth = contentWidth;
        queueMicrotask(() => {
            if (
                scheduledCommands.get(toolCallId) !== scheduled ||
                scheduled.targetWidth !== contentWidth ||
                !scheduled.options.isCurrent() ||
                scheduled.options.signal?.aborted === true
            )
                return;

            requestFormatting(scheduled);
        });
    }

    function schedule(options: ScriptPreviewSchedule): boolean {
        const previous = scheduledCommands.get(options.toolCallId);
        if (options.formatter !== undefined && previous?.options.command === options.command)
            return true;

        previous?.controller.abort();
        remember(options.toolCallId, options.command, options.formatter);
        scheduledCommands.delete(options.toolCallId);

        if (options.formatter === undefined) return false;

        const scheduled: ScheduledPreview = {
            options,
            targetWidth: renderWidths.get(options.toolCallId)?.contentWidth ?? options.targetWidth,
            controller: new AbortController(),
            completion: Promise.resolve(),
            completed: options.completed ?? false,
            ready: false,
            running: false,
            expandedScript: undefined,
        };

        scheduledCommands.set(options.toolCallId, scheduled);

        while (scheduledCommands.size > MAX_BASH_RENDER_INVALIDATIONS) {
            const oldest = scheduledCommands.keys().next().value;
            if (oldest === undefined) break;

            scheduledCommands.get(oldest)?.controller.abort();
            scheduledCommands.delete(oldest);
        }

        requestFormatting(scheduled);

        return true;
    }

    async function restore(options: {
        readonly calls: Iterable<{ readonly toolCallId: string; readonly command: string }>;
        readonly formatter: ScriptBlockFormatter | undefined;
        readonly signal: AbortSignal;
        readonly isCurrent: () => boolean;
        readonly invalidate: (toolCallId: string) => void;
    }): Promise<void> {
        if (options.formatter === undefined) return;

        let restored = 0;
        for (const call of options.calls) {
            if (options.signal.aborted || !options.isCurrent()) return;

            if (
                scriptForPreview(call.command, options.formatter, formatEmbedded !== undefined) ===
                undefined
            )
                continue;

            if (restored >= MAX_SCRIPT_PREVIEW_ENTRIES) return;

            restored += 1;
            schedule({
                toolCallId: call.toolCallId,
                command: call.command,
                completed: true,
                formatter: options.formatter,
                signal: options.signal,
                isCurrent: options.isCurrent,
                invalidate: () => options.invalidate(call.toolCallId),
            });
            await scheduledCommands.get(call.toolCallId)?.completion;
        }
    }

    return {
        stats: () => scriptPreviews.stats(),
        remember,
        schedule,
        restore,
        renderBashCall,
        renderBashResult,
        clear,
    };
}
