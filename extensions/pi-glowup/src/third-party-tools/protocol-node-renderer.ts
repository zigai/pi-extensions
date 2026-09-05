import { stringParser } from "../json-scalar.ts";
import {
    emptyComponent,
    makeComponent,
    renderGlowupBody,
    renderGlowupOutput,
    type GlowupOutputRenderOptions,
    type GlowupRenderTheme,
} from "../rendering/core.ts";
import type { MutationSettings } from "../mutations/settings.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type {
    GlowupCallLabels,
    GlowupInline,
    GlowupNode,
    GlowupPreview,
    GlowupSummaryNode,
} from "../tool-rendering/protocol.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
    type ThirdPartyCallOptions,
} from "./call-rendering.ts";
import {
    renderProtocolMutation,
    type ProtocolMutationRenderOptions,
} from "./protocol-mutation-renderer.ts";
import type { ThirdPartyToolRenderContext } from "./types.ts";

const DEFAULT_EXPANDED_PREVIEW_LINES = 500;

function toneText(theme: GlowupRenderTheme, value: GlowupInline): string {
    if (!(value instanceof Object) || !("kind" in value)) return value;

    const token: Parameters<GlowupRenderTheme["fg"]>[0] = (() => {
        switch (value.tone) {
            case "accent":
            case "path":
            case "url":
                return "accent";
            case "success":
                return "success";
            case "error":
                return "error";
            case "dim":
                return "dim";
            case "muted":
                return "muted";
            case "code":
                return "syntaxString";
            case "default":
            case undefined:
                return "toolTitle";
        }
        return "toolTitle";
    })();
    const styled = theme.fg(token, value.text);
    return value.bold === true ? theme.bold(styled) : styled;
}

function statusLabel(
    mode: ToolLabelMode,
    context: ThirdPartyToolRenderContext,
    labels: GlowupCallLabels,
): string {
    if (mode === "lifecycle" && context.isError && labels.failed !== undefined) {
        return labels.failed;
    }
    const lifecycle = {
        static: labels.static,
        active: labels.running ?? `Calling ${labels.static}`,
        completed: labels.completed ?? `Called ${labels.static}`,
    };
    return thirdPartyStatusLabel(mode, context, lifecycle);
}

function previewLines(preview: GlowupPreview | undefined, expanded: boolean): number {
    return expanded
        ? (preview?.expandedLines ?? DEFAULT_EXPANDED_PREVIEW_LINES)
        : (preview?.collapsedLines ?? DEFAULT_TOOL_CALL_PREVIEW_LINES);
}

function previewMode(preview: GlowupPreview | undefined): "head" | "headTail" | "hidden" {
    return preview?.mode ?? "headTail";
}

function nodeText(node: GlowupNode, theme: GlowupRenderTheme): string {
    switch (node.kind) {
        case "text":
            return toneText(theme, node.text);
        case "summary":
            return node.rows
                .map(
                    (row) =>
                        `${toneText(theme, row.label)} ${theme.fg("dim", "→")} ${toneText(theme, row.value)}`,
                )
                .join("\n");
        case "code":
            return [node.title === undefined ? undefined : toneText(theme, node.title), node.text]
                .filter((value): value is string => value !== undefined)
                .join("\n");
        case "list":
            return node.items
                .map((item) => {
                    const str = stringParser.parse(item);
                    if (str !== undefined) {
                        return `• ${str}`;
                    }
                    if (
                        item instanceof Object &&
                        "kind" in item &&
                        item.kind === "text" &&
                        "text" in item &&
                        stringParser.parse(item.text) !== undefined
                    ) {
                        // SAFETY: Validated item has kind 'text' and string text, matching GlowupInline object.
                        return `• ${toneText(theme, item as GlowupInline)}`;
                    }
                    // SAFETY: Decoder verified list items are either GlowupInline or a valid GlowupNode.
                    return `• ${nodeText(item as GlowupNode, theme)}`;
                })
                .join("\n");
        case "output":
            return node.text ?? "";
        case "mutation":
            return node.files
                .map((file) =>
                    file.previousPath === undefined
                        ? file.path
                        : `${file.previousPath} → ${file.path}`,
                )
                .join("\n");
        case "stack":
            return node.children
                .map((child) => nodeText(child, theme))
                .filter(Boolean)
                .join("\n");
        case "call":
            return node.body === undefined ? "" : nodeText(node.body, theme);
        case "empty":
            return "";
    }
}

function renderSummary(node: GlowupSummaryNode, theme: GlowupRenderTheme) {
    return renderGlowupOutput(theme, nodeText(node, theme), {
        expanded: true,
        mode: "headTail",
        maxPreviewLines: DEFAULT_EXPANDED_PREVIEW_LINES,
        noOutputLabel: null,
    });
}

/** Renders a decoded public protocol node through Glowup's private style engine. */
export function renderProtocolNode(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
    mutationSettings?: MutationSettings,
): ReturnType<typeof emptyComponent> {
    switch (node.kind) {
        case "empty":
            return emptyComponent();
        case "text":
            return renderGlowupBody(toneText(theme, node.text));
        case "summary":
            return renderSummary(node, theme);
        case "code": {
            let outputOptions: GlowupOutputRenderOptions = {
                expanded: context.expanded,
                mode: previewMode(node.preview),
                maxPreviewLines: previewLines(node.preview, context.expanded),
                noOutputLabel: null,
            };
            if (node.syntax !== undefined) {
                outputOptions = { ...outputOptions, syntax: node.syntax };
            }
            const content = renderGlowupOutput(theme, node.text, outputOptions);
            if (node.title === undefined) return content;
            const title = renderGlowupBody(toneText(theme, node.title));
            return makeComponent((width) => [...title.render(width), ...content.render(width)]);
        }
        case "list":
            return renderGlowupOutput(theme, nodeText(node, theme), {
                expanded: context.expanded,
                mode: previewMode(node.preview),
                maxPreviewLines: previewLines(node.preview, context.expanded),
                noOutputLabel: null,
            });
        case "output": {
            let outputOptions: GlowupOutputRenderOptions = {
                expanded: context.expanded,
                mode: previewMode(node.preview),
                maxPreviewLines: previewLines(node.preview, context.expanded),
                noOutputLabel: node.noOutputLabel ?? null,
            };
            if (node.syntax !== undefined) {
                outputOptions = { ...outputOptions, syntax: node.syntax };
            }
            return renderGlowupOutput(theme, node.text, outputOptions);
        }
        case "mutation": {
            let mutationOptions: ProtocolMutationRenderOptions = {
                label: statusLabel(labelMode, context, node.labels),
                state: callState(context),
            };
            if (mutationSettings !== undefined) {
                mutationOptions = { ...mutationOptions, mutationSettings };
            }
            return renderProtocolMutation(node, theme, context, mutationOptions);
        }
        case "call": {
            let headerOptions: ThirdPartyCallOptions = {
                state: callState(context),
                statusText: statusLabel(labelMode, context, node.labels),
                body: undefined,
                maxRenderedLines: previewLines(node.preview, context.expanded),
                expanded: context.expanded,
            };
            if (context.expanded) {
                headerOptions = { ...headerOptions, expandable: false };
            } else if (node.preview?.expandable !== undefined) {
                headerOptions = { ...headerOptions, expandable: node.preview.expandable };
            }
            if (node.body === undefined || node.body.kind === "text") {
                return renderThirdPartyCall(theme, {
                    ...headerOptions,
                    body: node.body === undefined ? undefined : nodeText(node.body, theme),
                });
            }
            const header = renderThirdPartyCall(theme, headerOptions);
            const body = renderProtocolNode(node.body, theme, context, labelMode, mutationSettings);
            return makeComponent((width) => [...header.render(width), ...body.render(width)]);
        }
        case "stack":
            return makeComponent((width) =>
                node.children.flatMap((child) =>
                    renderProtocolNode(child, theme, context, labelMode, mutationSettings).render(
                        width,
                    ),
                ),
            );
    }
}
