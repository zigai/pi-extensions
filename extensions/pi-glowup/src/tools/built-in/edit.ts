import { type JsonValue } from "../../json-value.ts";
import { formatPathTarget } from "../../rendering/path.ts";
import { parseDiffSections } from "../../rendering/diff/text-diff.ts";
import { renderGlowupCall, renderMutationCall } from "../../rendering/tool-header.ts";
import {
    renderGlowupDiff,
    type GlowupDiffRenderOptions,
} from "../../rendering/diff/text-renderer.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import {
    buildLargeDiffSummaryPayload,
    buildPierreDiffPayload,
} from "../../rendering/diff/payload.ts";
import { createEditSnapshot, type EditSnapshotState } from "./file-snapshots.ts";
import {
    getPierreDiffPayloadFromDetails,
    renderPierreDiff,
} from "../../rendering/diff/pierre-renderer.ts";
import { type PierreDiffPayload } from "../../rendering/diff/types.ts";
import {
    isActiveToolCall,
    toolStatusLabel,
    type ToolLabelMode,
} from "../../rendering/status-labels.ts";
import { hasNonWhitespaceText } from "../../text-boundaries.ts";
import { diffDetailsParser } from "../../unknown-values.ts";
import { normalizedEditArgs, pathField, textOutput } from "./arguments.ts";
import {
    diffRenderLimits,
    markMutationResultRendered,
    mutationLabelColumnWidth,
    trimOldestMapEntries,
    type BuiltInRenderContext,
    type BuiltInRenderTheme,
    type BuiltInResultOptions,
    type TextResult,
} from "./context.ts";
import { summarizeEditCall } from "./edit-summary.ts";
import { buildEditPreview, EditPreviewStore } from "./file-previews.ts";
import { type MutationSettings } from "../../rendering/preview-settings.ts";

export function createNativeEditFeature() {
    let generation = 0;
    const editPreviews = new EditPreviewStore(300);
    const nativeEditSnapshots = new Map<string, EditSnapshotState>();
    const nativeEditPierrePayloads = new Map<string, PierreDiffPayload>();
    async function captureNativeEditSnapshot(
        toolCallId: string,
        cwd: string,
        filePath: string | undefined,
        mutationSettings: MutationSettings,
    ): Promise<void> {
        if (
            nativeEditSnapshots.has(toolCallId) ||
            filePath === undefined ||
            filePath.length === 0
        ) {
            return;
        }

        const captureGeneration = generation;
        const snapshot = await createEditSnapshot(
            cwd,
            filePath,
            diffRenderLimits(mutationSettings),
        );
        if (captureGeneration !== generation) {
            return;
        }

        nativeEditSnapshots.set(toolCallId, snapshot);
        trimOldestMapEntries(nativeEditSnapshots, 300);
    }

    async function finishNativeEditSnapshot(
        toolCallId: string,
        isError: boolean,
        mutationSettings: MutationSettings,
    ): Promise<PierreDiffPayload | undefined> {
        const snapshot = nativeEditSnapshots.get(toolCallId);
        nativeEditSnapshots.delete(toolCallId);

        if (snapshot === undefined || isError) {
            return undefined;
        }

        const finishGeneration = generation;
        const payload = buildPierreDiffPayload(
            await snapshot.finish(),
            diffRenderLimits(mutationSettings),
        );
        if (finishGeneration !== generation) {
            return undefined;
        }

        if (payload !== undefined) {
            nativeEditPierrePayloads.set(toolCallId, payload);
            trimOldestMapEntries(nativeEditPierrePayloads, 300);
        }
        return payload;
    }

    function renderEditCall(
        args: JsonValue | undefined,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        labelMode: ToolLabelMode,
    ) {
        const labelColumnWidth = mutationLabelColumnWidth(context, labelMode);
        const cachedPreview = editPreviews.get(context.toolCallId);
        const rawResultDetails = context.result?.details;
        const resultDetails =
            cachedPreview === undefined ? diffDetailsParser.parse(rawResultDetails) : undefined;
        const preview =
            cachedPreview ??
            (resultDetails !== undefined && hasNonWhitespaceText(resultDetails.diff)
                ? buildEditPreview({
                      path: pathField(args) ?? "",
                      diff: resultDetails.diff,
                  })
                : undefined);
        if (!isActiveToolCall(context) && preview) {
            return renderMutationCall(
                theme,
                {
                    label: labelMode === "lifecycle" ? "Edited" : "Edit",
                    path: preview.path,
                    added: preview.added,
                    removed: preview.removed,
                },
                labelColumnWidth === undefined
                    ? { state: "success" }
                    : { labelColumnWidth, state: "success" },
            );
        }

        const normalizedArgs = normalizedEditArgs(args);
        const summary = summarizeEditCall(normalizedArgs, {
            ...context,
            labelMode,
        });
        if (isActiveToolCall(context)) {
            return renderGlowupCall(theme, {
                state: "running",
                statusText: toolStatusLabel(labelMode, context, {
                    static: "Edit",
                    active: "Editing",
                    completed: "Edited",
                }),
                body: `${formatPathTarget(theme, summary.path)}${summary.suffix}`,
            });
        }

        const state = summary.hasInvalidEdits || context.isError ? "error" : "success";
        return renderGlowupCall(theme, {
            state,
            statusText: summary.statusText,
            body: `${formatPathTarget(theme, summary.path)}${summary.suffix}`,
        });
    }

    function renderEditResult(
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
            ? (nativeEditPierrePayloads.get(context.toolCallId) ??
              getPierreDiffPayloadFromDetails(result.details, diffRenderLimits(mutationSettings)))
            : undefined;
        if (pierrePayload) {
            return renderPierreDiff(
                pierrePayload,
                theme,
                { expanded: options.expanded, mutationSettings },
                context,
            );
        }

        const details = context.isError ? undefined : diffDetailsParser.parse(result.details);
        if (details !== undefined && hasNonWhitespaceText(details.diff)) {
            const path = pathField(context.args);
            const summaryPayload = buildLargeDiffSummaryPayload(
                {
                    path: path ?? "",
                    diffText: details.diff,
                },
                diffRenderLimits(mutationSettings),
            );
            if (summaryPayload !== undefined) {
                return renderPierreDiff(
                    summaryPayload,
                    theme,
                    { expanded: options.expanded, mutationSettings },
                    context,
                );
            }

            const sections = parseDiffSections(details.diff, path);
            const showAllRows = options.expanded || mutationSettings.defaultView === "full";
            let diffOptions: GlowupDiffRenderOptions = {
                collapsedLineBudget: mutationSettings.previewLines,
            };
            if (!showAllRows) {
                diffOptions = { ...diffOptions, maxWrappedRows: 1 };
            }

            return renderGlowupDiff(theme, sections, showAllRows, diffOptions);
        }

        return renderGlowupOutput(theme, textOutput(result), {
            expanded:
                options.expanded || (!context.isError && mutationSettings.defaultView === "full"),
            mode: "head",
            maxPreviewLines: 5,
        });
    }

    function clear(): void {
        generation += 1;
        editPreviews.clear();
        nativeEditSnapshots.clear();
        nativeEditPierrePayloads.clear();
    }

    function stats() {
        return {
            ...editPreviews.stats(),
            nativeEditSnapshots: nativeEditSnapshots.size,
            nativeEditPierrePayloads: nativeEditPierrePayloads.size,
        };
    }

    function rememberCompletedPreview(
        toolCallId: string,
        preview: { readonly path: string; readonly diff: string },
    ): void {
        editPreviews.set(toolCallId, buildEditPreview(preview));
    }

    return {
        stats,
        rememberCompletedPreview,
        captureNativeEditSnapshot,
        finishNativeEditSnapshot,
        renderEditCall,
        renderEditResult,
        clear,
    };
}
