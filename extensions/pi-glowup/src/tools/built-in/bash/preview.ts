import type { ShellLayout, ShellOperatorPosition } from "./command.ts";
import { type JsonValue } from "../../../json-value.ts";
import { emptyComponent, makeComponent } from "../../../rendering/component.ts";
import type { CodePreview } from "../../../rendering/streaming/presentation.ts";
import { parseScriptInvocation, type ScriptInvocation } from "./invocation.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../../rendering/output.ts";
import {
    renderScriptCall,
    type ScriptPreviewHeaderLayout,
    type ScriptCallRenderOptions,
} from "./script-renderer.ts";
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
    rememberRawScriptPreview,
    scriptForPreview,
} from "./format-preview.ts";
import type { ScriptBlockFormatter } from "./formatter.ts";
import {
    boundedScriptPreview,
    createScriptPreviewStore,
    MAX_SCRIPT_PREVIEW_ENTRIES,
} from "./preview-store.ts";
import { renderBashCommandCall, type BashCommandRenderOptions } from "./renderer.ts";
import { StreamingScriptIdentityStore } from "./streaming-identity.ts";
import { renderExpandableSection } from "../../section-expansion.ts";

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
};

function renderStreamingScriptCall(
    invocation: ScriptInvocation,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    streamCode: CodePreview,
    options: Omit<ScriptCallRenderOptions, "expanded">,
) {
    const { toolCallId, argsComplete, isError } = context;

    return renderExpandableSection(context, "call", (expanded) =>
        makeComponent((width) => {
            const code = streamCode({
                key: `tool:${toolCallId}:script:${invocation.language}`,
                source: invocation.code,
                language: invocation.language,
                complete: argsComplete || isError,
                targetWidth: Math.max(1, width - 6),
                ...(options.invalidate !== undefined && { invalidate: options.invalidate }),
            });

            return renderScriptCall(
                theme,
                { ...invocation, code },
                { ...options, expanded },
            ).render(width);
        }),
    );
}

export function createNativeBashFeature() {
    const scriptPreviews = createScriptPreviewStore();
    const scheduledCommands = new Map<string, ScheduledPreview>();
    const renderWidths = new Map<string, { contentWidth: number; renderWidth: number }>();
    const PARTIAL_BASH_COMMAND_PREVIEW_CHARS = 4_000;
    const streamingScriptIdentities = new StreamingScriptIdentityStore();
    const bashRenderInvalidations = new Map<string, () => void>();
    const MAX_BASH_RENDER_INVALIDATIONS = 300;

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
        headerLayout: () => ScriptPreviewHeaderLayout,
        maxCodePreviewLines: () => number,
        showPrologueOmission: () => boolean,
        shellLayout: () => ShellLayout,
        shellOperatorPosition: () => ShellOperatorPosition,
        streamCode?: CodePreview,
    ) {
        rememberBashRenderInvalidation(context.toolCallId, context.invalidate);

        const state = context.isError ? "error" : context.isPartial ? "running" : "success";
        const command = commandField(args) ?? "";
        if (streamCode !== undefined) {
            let script = streamingScriptIdentities.resolve(context.toolCallId, command);
            if (context.argsComplete) {
                script = streamingScriptIdentities.finalize(
                    context.toolCallId,
                    parseScriptInvocation(command),
                );
            }

            const invocation = script ?? { label: "Bash", language: "bash", code: command };
            return renderStreamingScriptCall(invocation, theme, context, streamCode, {
                state,
                maxCodePreviewLines: maxCodePreviewLines(),
                showPrologueOmission: showPrologueOmission(),
                headerLayout: headerLayout(),
                invalidate: context.invalidate,
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
                headerLayout: headerLayout(),
                invalidate: context.invalidate,
                lastComponent: context.lastComponent,
            });
        }

        const displayCommand = context.argsComplete ? command : partialBashCommandPreview(command);
        const scheduled = scheduledCommands.get(context.toolCallId);

        if (context.result !== undefined && !context.isPartial) completePreview(context.toolCallId);

        const parsedScript = scriptForPreview(displayCommand, scheduled?.options.formatter);
        const profile = scheduled?.options.formatter?.profileFor?.(parsedScript?.language ?? "");
        const profiled = profile !== undefined;
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
            headerLayout: headerLayout(),
            shellLayout: shellLayout(),
            shellOperatorPosition: shellOperatorPosition(),
            invalidate: context.invalidate,
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
                options = { ...options, pureScriptOverride: parsedScript, shellLayout: "preserve" };
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
        headerLayout: () => ScriptPreviewHeaderLayout,
    ) {
        if (!options.isPartial) completePreview(context.toolCallId);

        const output = textOutput(result);
        const language = detectStructuredOutputLanguage(output);
        const script = parseScriptInvocation(commandField(context.args));
        let outputOptions: GlowupOutputRenderOptions = {
            expanded: options.expanded,
            mode: "headTail",
            maxPreviewLines: 5,
            invalidate: context.invalidate,
        };
        if (script !== undefined && headerLayout() === "block") {
            outputOptions = {
                ...outputOptions,
                prefixFirst: theme.fg("dim", "  → "),
                prefixRest: "    ",
            };
        }

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
        scriptPreviews.clear();

        for (const scheduled of scheduledCommands.values()) scheduled.controller.abort();
        scheduledCommands.clear();
        renderWidths.clear();
        bashRenderInvalidations.clear();
        streamingScriptIdentities.clear();
    }

    function remember(toolCallId: string, command: string, formatter?: ScriptBlockFormatter): void {
        rememberRawScriptPreview(scriptPreviews, toolCallId, command, formatter);
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
        scheduled.controller.abort();

        const controller = new AbortController();
        scheduled.controller = controller;

        const { options, targetWidth } = scheduled;
        let signal = controller.signal;
        if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);

        const formatted = await formatAndStoreScriptPreview({
            sink: scriptPreviews,
            toolCallId: options.toolCallId,
            command: options.command,
            formatter: options.formatter,
            signal,
            ...(targetWidth !== undefined && { targetWidth }),
            isCurrent: () =>
                !signal.aborted &&
                options.isCurrent() &&
                scheduledCommands.get(options.toolCallId) === scheduled &&
                scheduled.controller === controller,
        }).catch(() => false);

        if (
            signal.aborted ||
            !options.isCurrent() ||
            scheduledCommands.get(options.toolCallId) !== scheduled ||
            scheduled.controller !== controller
        )
            return;

        if (!formatted) return;

        scheduled.ready = true;

        const script = scriptPreviews.get(options.toolCallId);
        const profile = options.formatter?.profileFor?.(script?.language ?? "");
        if (profile !== undefined && !scheduled.completed) return;

        invalidatePreview(scheduled);
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

            scheduled.completion = formatPreview(scheduled);
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
        };

        scheduledCommands.set(options.toolCallId, scheduled);

        while (scheduledCommands.size > MAX_BASH_RENDER_INVALIDATIONS) {
            const oldest = scheduledCommands.keys().next().value;
            if (oldest === undefined) break;

            scheduledCommands.get(oldest)?.controller.abort();
            scheduledCommands.delete(oldest);
        }

        scheduled.completion = formatPreview(scheduled);
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
            if (scriptForPreview(call.command, options.formatter) === undefined) continue;
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
