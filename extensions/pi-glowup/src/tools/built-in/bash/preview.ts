import type { ShellLayout, ShellOperatorPosition } from "./command.ts";
import { type JsonValue } from "../../../json-value.ts";
import { emptyComponent } from "../../../rendering/component.ts";
import { parseScriptInvocation } from "./invocation.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../../rendering/output.ts";
import { renderScriptCall, type ScriptPreviewHeaderLayout } from "./script-renderer.ts";
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
    scheduleFormattedScriptPreview,
    type FormatScriptPreviewOptions,
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

function scriptPreviewTargetWidth(targetWidth?: number): number | undefined {
    // SAFETY: process.stdout.columns is number | undefined at runtime in Node.js.
    const stdoutColumns = process.stdout.columns as number | undefined;
    return (
        targetWidth ?? (stdoutColumns !== undefined ? Math.max(20, stdoutColumns - 4) : undefined)
    );
}

export function createNativeBashFeature() {
    const scriptPreviews = createScriptPreviewStore();
    const scheduledCommands = new Map<string, string>();
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
    ) {
        rememberBashRenderInvalidation(context.toolCallId, context.invalidate);

        const state = context.isError ? "error" : context.isPartial ? "running" : "success";
        const command = commandField(args) ?? "";
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
            });
        }

        const displayCommand = context.argsComplete ? command : partialBashCommandPreview(command);
        const parsedScript = parseScriptInvocation(displayCommand);
        const script =
            scriptPreviews.get(context.toolCallId) ??
            (parsedScript === undefined ? undefined : boundedScriptPreview(parsedScript));
        const stableScript = context.argsComplete
            ? streamingScriptIdentities.finalize(context.toolCallId, script)
            : script;
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
        if (stableScript !== undefined) {
            bashOptions = { ...bashOptions, pureScriptOverride: stableScript };
        }

        return renderExpandableSection(context, "call", (expanded) =>
            renderBashCommandCall(theme, displayCommand, { ...bashOptions, expanded }),
        );
    }

    function renderBashResult(
        result: TextResult,
        options: BuiltInResultOptions,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        headerLayout: () => ScriptPreviewHeaderLayout,
    ) {
        const output = textOutput(result);
        const language = detectStructuredOutputLanguage(output);
        const script = parseScriptInvocation(commandField(context.args));
        let outputOptions: GlowupOutputRenderOptions = {
            expanded: options.expanded,
            mode: "headTail",
            maxPreviewLines: 5,
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
        scheduledCommands.clear();
        bashRenderInvalidations.clear();
        streamingScriptIdentities.clear();
    }

    function remember(toolCallId: string, command: string): void {
        rememberRawScriptPreview(scriptPreviews, toolCallId, command);
    }

    function schedule(options: {
        readonly toolCallId: string;
        readonly command: string;
        readonly formatter: ScriptBlockFormatter | undefined;
        readonly signal: AbortSignal | undefined;
        readonly targetWidth?: number;
        readonly isCurrent: () => boolean;
        readonly invalidate: () => void;
    }): boolean {
        if (
            options.formatter !== undefined &&
            scheduledCommands.get(options.toolCallId) === options.command
        ) {
            return true;
        }

        remember(options.toolCallId, options.command);
        scheduledCommands.delete(options.toolCallId);

        if (options.formatter !== undefined) {
            scheduledCommands.set(options.toolCallId, options.command);
            trimOldestMapEntries(scheduledCommands, MAX_BASH_RENDER_INVALIDATIONS);
        }

        const columns = scriptPreviewTargetWidth(options.targetWidth);

        const formatOptions: FormatScriptPreviewOptions = {
            sink: scriptPreviews,
            toolCallId: options.toolCallId,
            command: options.command,
            formatter: options.formatter,
            ...(columns !== undefined && { targetWidth: columns }),
            ...(options.signal !== undefined && { signal: options.signal }),
            isCurrent: () =>
                options.isCurrent() &&
                scheduledCommands.get(options.toolCallId) === options.command,
            invalidate: () => {
                bashRenderInvalidations.get(options.toolCallId)?.();
                options.invalidate();
            },
        };

        scheduleFormattedScriptPreview(formatOptions);

        return options.formatter !== undefined;
    }

    async function restore(options: {
        readonly calls: Iterable<{ readonly toolCallId: string; readonly command: string }>;
        readonly formatter: ScriptBlockFormatter | undefined;
        readonly signal: AbortSignal;
        readonly isCurrent: () => boolean;
        readonly invalidate: () => void;
    }): Promise<void> {
        if (options.formatter === undefined) return;

        const targetWidth = scriptPreviewTargetWidth();
        let restored = 0;
        for (const call of options.calls) {
            if (options.signal.aborted || !options.isCurrent()) return;
            if (parseScriptInvocation(call.command) === undefined) continue;
            if (restored >= MAX_SCRIPT_PREVIEW_ENTRIES) return;

            restored += 1;
            await formatAndStoreScriptPreview({
                sink: scriptPreviews,
                toolCallId: call.toolCallId,
                command: call.command,
                formatter: options.formatter,
                signal: options.signal,
                ...(targetWidth !== undefined && { targetWidth }),
                isCurrent: options.isCurrent,
                invalidate: () => {
                    bashRenderInvalidations.get(call.toolCallId)?.();
                    options.invalidate();
                },
            }).catch(() => {});
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
