import { type JsonValue } from "../../json-value.ts";
import { formatPathTarget } from "../../rendering/path.ts";
import { makeComponent } from "../../rendering/component.ts";
import { parseDiffSections } from "../../rendering/diff/text-diff.ts";
import { renderGlowupCall } from "../../rendering/tool-header.ts";
import {
    renderGlowupDiff,
    type GlowupDiffRenderOptions,
} from "../../rendering/diff/text-renderer.ts";
import { toolStatusLabel, type ToolLabelMode } from "../../rendering/status-labels.ts";
import { hasNonWhitespaceText } from "../../text-boundaries.ts";
import { diffDetailsParser } from "../../unknown-values.ts";
import { pathField } from "./arguments.ts";
import {
    callState,
    trimOldestMapEntries,
    type BuiltInRenderContext,
    type BuiltInRenderTheme,
    type TextResult,
} from "./context.ts";
import { captureDeletedTextPreview, type DeletedTextPreview } from "./delete-preview.ts";
import { type MutationSettings } from "../../rendering/preview-settings.ts";

export function createNativeDeleteFeature() {
    let generation = 0;
    const nativeDeletePreviews = new Map<string, DeletedTextPreview>();

    function persistedDeletePreview(
        result: TextResult | undefined,
        filePath: string | undefined,
    ): DeletedTextPreview | undefined {
        if (filePath === undefined) return undefined;

        const details = diffDetailsParser.parse(result?.details);
        if (details === undefined || !hasNonWhitespaceText(details.diff)) return undefined;

        const { diff } = details;
        const normalized = diff.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        const pathHeader = `${filePath}\n`;
        const body = normalized.startsWith(pathHeader)
            ? normalized.slice(pathHeader.length)
            : normalized;
        const section = parseDiffSections(body, filePath)[0];
        if (section === undefined || section.removed === 0) return undefined;

        return { section, removed: section.removed };
    }

    async function captureNativeDeletePreview(
        toolCallId: string,
        cwd: string,
        filePath: string | undefined,
        mutationSettings: MutationSettings,
    ): Promise<void> {
        if (
            nativeDeletePreviews.has(toolCallId) ||
            filePath === undefined ||
            filePath.length === 0
        ) {
            return;
        }
        const captureGeneration = generation;
        const preview = await captureDeletedTextPreview(
            cwd,
            filePath,
            mutationSettings.limits.maxDeletePreimageBytes,
        );
        if (captureGeneration !== generation) {
            return;
        }

        if (preview !== undefined) {
            nativeDeletePreviews.set(toolCallId, preview);
            trimOldestMapEntries(nativeDeletePreviews, 300);
        }
    }

    function renderDeleteCall(
        args: JsonValue | undefined,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        labelMode: ToolLabelMode,
        mutationSettings: MutationSettings,
    ) {
        const filePath = pathField(args);
        const preview =
            nativeDeletePreviews.get(context.toolCallId) ??
            persistedDeletePreview(context.result, filePath);
        const header = renderGlowupCall(theme, {
            state: callState(context),
            statusText: toolStatusLabel(labelMode, context, {
                static: "Delete",
                active: "Deleting",
                completed: "Deleted",
            }),
            body: `${formatPathTarget(theme, filePath)}${preview === undefined || preview.removed === 0 ? "" : ` (${theme.fg("toolDiffRemoved", `-${preview.removed}`)})`}`,
        });
        if (preview === undefined || preview.section.lines.length === 0) {
            return header;
        }

        const showAllRows = context.expanded || mutationSettings.defaultView === "full";
        let diffOptions: GlowupDiffRenderOptions = {
            collapsedLineBudget: mutationSettings.previewLines,
        };
        if (!showAllRows) {
            diffOptions = { ...diffOptions, maxWrappedRows: 1 };
        }

        const body = renderGlowupDiff(theme, [preview.section], showAllRows, diffOptions);

        return makeComponent((width) => [...header.render(width), ...body.render(width)]);
    }

    function clear(): void {
        generation += 1;
        nativeDeletePreviews.clear();
    }

    return { captureNativeDeletePreview, renderDeleteCall, clear };
}
