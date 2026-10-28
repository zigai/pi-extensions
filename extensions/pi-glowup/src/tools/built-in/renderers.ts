import { jsonValueParser, type JsonValue } from "../../json-value.ts";
import type { CodePreview, CodeSource } from "../../rendering/streaming/presentation.ts";
import { emptyComponent } from "../../rendering/component.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import { type MutationSettings } from "../../rendering/preview-settings.ts";
import { shouldDeferSimpleToolCall, type ToolLabelMode } from "../../rendering/status-labels.ts";
import {
    formatFindAction,
    formatGrepAction,
    formatLsAction,
    formatReadAction,
} from "../../rendering/tool-header.ts";
import {
    findActionArgs,
    commandField,
    normalizedWriteArgs,
    grepActionArgs,
    hasImageContent,
    lsActionArgs,
    pathField,
    readActionArgs,
    textOutput,
} from "./arguments.ts";
import type { ShellLayout, ShellOperatorPosition, ShellOutputStyle } from "./bash/command.ts";
import { createNativeBashFeature } from "./bash/preview.ts";
import { type BuiltInToolRendererOptions, type BuiltInRenderContext } from "./context.ts";
import { createNativeDeleteFeature } from "./delete.ts";
import { createNativeEditFeature } from "./edit.ts";
import {
    createExplorationFeature,
    renderWebSearchCall,
    syntaxPathFromToolArg,
} from "./exploration.ts";
import { type BuiltInToolName } from "./names.ts";
import { renderWriteCall, renderWriteResult } from "./write.ts";

export function createNativeToolRenderers(features: {
    readonly bash: ReturnType<typeof createNativeBashFeature>;
    readonly edit: ReturnType<typeof createNativeEditFeature>;
    readonly deletion: ReturnType<typeof createNativeDeleteFeature>;
    readonly exploration: ReturnType<typeof createExplorationFeature>;
}) {
    const { renderBashCall, renderBashResult } = features.bash;
    const { renderEditCall, renderEditResult } = features.edit;
    const { renderDeleteCall } = features.deletion;
    const { renderExplorationCall, renderExplorationResult } = features.exploration;

    function renderBuiltInToolCall(options: {
        readonly maxCodePreviewLines: () => number;
        readonly showPrologueOmission: () => boolean;
        readonly shellLayout: () => ShellLayout;
        readonly shellOperatorPosition: () => ShellOperatorPosition;
        readonly labelMode: ToolLabelMode;
        readonly movingWriteViewport: boolean;
        readonly streamCode?: CodePreview;
        readonly mutationSettings: MutationSettings;
        readonly recordRender: (kind: "call", toolName: BuiltInToolName) => void;
    }): BuiltInToolRendererOptions["renderCall"] {
        return (toolName, args, theme, context) => {
            options.recordRender("call", toolName);

            switch (toolName) {
                case "read":
                    if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                    return renderExplorationCall(
                        theme,
                        context,
                        formatReadAction(theme, readActionArgs(args)),
                        options.labelMode,
                    );
                case "find":
                    if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                    return renderExplorationCall(
                        theme,
                        context,
                        formatFindAction(theme, findActionArgs(args)),
                        options.labelMode,
                    );
                case "grep":
                    if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                    return renderExplorationCall(
                        theme,
                        context,
                        formatGrepAction(theme, grepActionArgs(args)),
                        options.labelMode,
                    );
                case "ls":
                    if (shouldDeferSimpleToolCall(context)) return emptyComponent();
                    return renderExplorationCall(
                        theme,
                        context,
                        formatLsAction(theme, lsActionArgs(args)),
                        options.labelMode,
                    );
                case "bash":
                    return renderBashCall(
                        jsonValueParser.parse(args),
                        theme,
                        context,
                        options.maxCodePreviewLines,
                        options.showPrologueOmission,
                        options.shellLayout,
                        options.shellOperatorPosition,
                        options.streamCode,
                    );
                case "write":
                    return renderWriteCall(jsonValueParser.parse(args), theme, context, {
                        labelMode: options.labelMode,
                        movingViewport: options.movingWriteViewport,
                        mutationSettings: options.mutationSettings,
                        ...(options.streamCode !== undefined && { streamCode: options.streamCode }),
                    });
                case "edit":
                    return renderEditCall(
                        jsonValueParser.parse(args),
                        theme,
                        context,
                        options.labelMode,
                    );
                case "delete":
                    return renderDeleteCall(
                        jsonValueParser.parse(args),
                        theme,
                        context,
                        options.labelMode,
                        options.mutationSettings,
                    );
                case "webSearch":
                    return renderWebSearchCall(
                        jsonValueParser.parse(args),
                        theme,
                        context,
                        options.labelMode,
                    );
            }
        };
    }

    function renderBuiltInToolResult(settings: {
        readonly shellOutputStyle: () => ShellOutputStyle;
        readonly mutationSettings: MutationSettings;
        readonly recordRender: (kind: "result", toolName: BuiltInToolName) => void;
    }): BuiltInToolRendererOptions["renderResult"] {
        return (toolName, result, options, theme, context) => {
            settings.recordRender("result", toolName);

            switch (toolName) {
                case "read":
                    return hasImageContent(result)
                        ? undefined
                        : renderExplorationResult(result, options.expanded, theme, {
                              syntaxPath: syntaxPathFromToolArg(pathField(context.args)),
                              invalidate: context.invalidate,
                          });
                case "find":
                case "grep":
                case "ls":
                    return renderExplorationResult(result, options.expanded, theme);
                case "bash":
                    return renderBashResult(
                        result,
                        options,
                        theme,
                        context,
                        settings.shellOutputStyle,
                    );
                case "write":
                    return renderWriteResult(
                        result,
                        options,
                        theme,
                        context,
                        settings.mutationSettings,
                    );
                case "edit":
                    return renderEditResult(
                        result,
                        options,
                        theme,
                        context,
                        settings.mutationSettings,
                    );
                case "delete":
                    return context.isError
                        ? renderGlowupOutput(theme, textOutput(result), {
                              expanded: options.expanded,
                              mode: "head",
                              maxPreviewLines: 5,
                          })
                        : emptyComponent();
                case "webSearch":
                    return renderGlowupOutput(theme, textOutput(result), {
                        expanded: options.expanded,
                        mode: "head",
                        maxPreviewLines: 5,
                    });
            }
        };
    }

    function codeSource(
        toolName: BuiltInToolName,
        args: JsonValue | undefined,
        context: Pick<BuiltInRenderContext, "toolCallId">,
    ): CodeSource | undefined {
        if (toolName === "write") {
            const write = normalizedWriteArgs(args);
            if (write.content === undefined) return undefined;

            const path = write.path ?? "";
            return { key: `tool:${context.toolCallId}:write:${path}`, source: write.content, path };
        }

        if (toolName === "bash") {
            const command = commandField(args);
            if (command === undefined) return undefined;

            const script = features.bash.scriptForSource(command);
            if (script === undefined) return undefined;

            return {
                key: `tool:${context.toolCallId}:script:${script.language}`,
                source: script.code,
                language: script.language,
            };
        }

        return undefined;
    }

    return { renderBuiltInToolCall, renderBuiltInToolResult, codeSource };
}
