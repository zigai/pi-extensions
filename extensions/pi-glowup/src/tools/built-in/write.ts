import { type JsonValue } from "../../json-value.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import {
    getPierreDiffPayloadFromDetails,
    renderPierreDiff,
} from "../../rendering/diff/pierre-renderer.ts";
import { type ToolLabelMode } from "../../rendering/status-labels.ts";
import { normalizedWriteArgs, textOutput } from "./arguments.ts";
import {
    diffRenderLimits,
    markMutationResultRendered,
    mutationLabelColumnWidth,
    type BuiltInRenderContext,
    type BuiltInRenderTheme,
    type BuiltInResultOptions,
    type TextResult,
} from "./context.ts";
import { type MutationSettings } from "../../rendering/preview-settings.ts";
import {
    renderSuccessfulWriteResultFallback,
    renderWriteCallPreview,
    type WriteCallContext,
} from "./write-preview.ts";

export function renderWriteCall(
    args: JsonValue | undefined,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    options: {
        readonly labelMode: ToolLabelMode;
        readonly movingViewport: boolean;
        readonly mutationSettings: MutationSettings;
    },
) {
    const labelColumnWidth = mutationLabelColumnWidth(context, options.labelMode);
    const writeContext: WriteCallContext =
        labelColumnWidth === undefined
            ? {
                  ...context,
                  labelMode: options.labelMode,
                  movingViewport: options.movingViewport,
                  mutationSettings: options.mutationSettings,
              }
            : {
                  ...context,
                  labelMode: options.labelMode,
                  movingViewport: options.movingViewport,
                  mutationSettings: options.mutationSettings,
                  mutationLabelColumnWidth: labelColumnWidth,
              };

    return renderWriteCallPreview(normalizedWriteArgs(args), theme, writeContext);
}

export function renderWriteResult(
    result: TextResult,
    options: BuiltInResultOptions,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    mutationSettings: MutationSettings,
) {
    if (!options.isPartial) {
        markMutationResultRendered(context);
    }

    const pierrePayload = !context.isError
        ? getPierreDiffPayloadFromDetails(result.details, diffRenderLimits(mutationSettings))
        : undefined;
    if (pierrePayload) {
        return renderPierreDiff(
            pierrePayload,
            theme,
            { expanded: options.expanded, mutationSettings },
            context,
        );
    }

    if (!context.isError) {
        const fallback = renderSuccessfulWriteResultFallback(normalizedWriteArgs(context.args));
        if (fallback !== undefined) {
            return fallback;
        }
    }

    return renderGlowupOutput(theme, textOutput(result), {
        expanded: options.expanded || (!context.isError && mutationSettings.defaultView === "full"),
        mode: "head",
        maxPreviewLines: 5,
    });
}
