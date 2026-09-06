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
    rememberRawScriptPreview,
    scheduleFormattedScriptPreview,
    type FormatScriptPreviewOptions,
} from "./format-preview.ts";
import type { ScriptBlockFormatter } from "./formatter.ts";
import { boundedScriptPreview, createScriptPreviewStore } from "./preview-store.ts";
import { renderBashCommandCall, type BashCommandRenderOptions } from "./renderer.ts";
import { StreamingScriptIdentityStore } from "./streaming-identity.ts";

export function createNativeBashFeature() {
    const scriptPreviews = createScriptPreviewStore();

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
        return renderBashCommandCall(theme, displayCommand, bashOptions);
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
        return renderGlowupOutput(theme, output, outputOptions);
    }
    function clear(): void {
        scriptPreviews.clear();
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
        readonly isCurrent: () => boolean;
        readonly invalidate: () => void;
    }): boolean {
        remember(options.toolCallId, options.command);
        let formatOptions: FormatScriptPreviewOptions = {
            sink: scriptPreviews,
            toolCallId: options.toolCallId,
            command: options.command,
            formatter: options.formatter,
        };
        if (options.signal !== undefined)
            formatOptions = { ...formatOptions, signal: options.signal };
        formatOptions = {
            ...formatOptions,
            isCurrent: options.isCurrent,
            invalidate: () => {
                bashRenderInvalidations.get(options.toolCallId)?.();
                options.invalidate();
            },
        };
        scheduleFormattedScriptPreview(formatOptions);
        return options.formatter !== undefined;
    }
    return {
        stats: () => scriptPreviews.stats(),
        remember,
        schedule,
        renderBashCall,
        renderBashResult,
        clear,
    };
}
