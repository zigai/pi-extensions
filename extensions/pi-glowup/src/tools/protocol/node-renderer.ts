import { protocolContent } from "./content.ts";
import { emptyComponent, makeComponent, wrapPrefixedLine } from "../../rendering/component.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../rendering/output.ts";
import { dim, type GlowupRenderTheme } from "../../rendering/theme.ts";
import type { MutationSettings } from "../../rendering/preview-settings.ts";
import { toolStatusLabel, type ToolLabelMode } from "../../rendering/status-labels.ts";
import type {
    GlowupCallLabels,
    GlowupCodeNode,
    GlowupListNode,
    GlowupInline,
    GlowupNode,
    GlowupPreview,
    GlowupSummaryNode,
} from "./contract.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderThirdPartyCall,
    type ThirdPartyCallOptions,
} from "../call-rendering.ts";
import { renderProtocolMutation, type ProtocolMutationRenderOptions } from "./mutation-renderer.ts";
import type { ThirdPartyToolRenderContext } from "../types.ts";

const DEFAULT_EXPANDED_PREVIEW_LINES = 500;
const BODY_INDENT = "    ";

type BodyPosition = "first" | "continued";

function bodyFirstPrefix(theme: GlowupRenderTheme, position: BodyPosition): string {
    if (position === "first") return dim(theme, "  └ ");
    return BODY_INDENT;
}

function renderBodyText(
    theme: GlowupRenderTheme,
    value: GlowupInline,
    position: BodyPosition,
): ReturnType<typeof makeComponent> {
    const prefixFirst = bodyFirstPrefix(theme, position);

    return makeComponent((width) =>
        wrapPrefixedLine(toneText(theme, value), width, prefixFirst, BODY_INDENT),
    );
}

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

    return toolStatusLabel(mode, context, lifecycle);
}

function previewLines(preview: GlowupPreview | undefined, expanded: boolean): number {
    return expanded
        ? (preview?.expandedLines ?? DEFAULT_EXPANDED_PREVIEW_LINES)
        : (preview?.collapsedLines ?? DEFAULT_TOOL_CALL_PREVIEW_LINES);
}

function previewMode(preview: GlowupPreview | undefined): "head" | "headTail" | "hidden" {
    return preview?.mode ?? "headTail";
}

type CodeContent = (
    node: GlowupCodeNode | Extract<GlowupNode, { kind: "output" }>,
    key: string,
    indent: number,
) => string;

function nodeText(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    codeContent: CodeContent = (value) => value.text ?? "",
    key = "root",
    indent = 0,
): string {
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
            return [
                node.title === undefined ? undefined : toneText(theme, node.title),
                codeContent(node, key, indent),
            ]
                .filter((value): value is string => value !== undefined)
                .join("\n");
        case "list":
            return node.items
                .map((item, index) => {
                    if (!(item instanceof Object)) return `• ${item}`;

                    if (item.kind === "text" && ("tone" in item || "bold" in item)) {
                        return `• ${toneText(theme, item)}`;
                    }

                    return `• ${nodeText(item, theme, codeContent, `${key}.${index}`, indent + 2)}`;
                })
                .join("\n");
        case "output":
            return codeContent(node, key, indent);
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
                .map((child, index) =>
                    nodeText(child, theme, codeContent, `${key}.${index}`, indent),
                )
                .filter(Boolean)
                .join("\n");
        case "call":
            return node.body === undefined
                ? ""
                : nodeText(node.body, theme, codeContent, `${key}.body`, indent);
        case "empty":
            return "";
    }

    throw new Error("Unsupported protocol node");
}

function renderSummary(node: GlowupSummaryNode, theme: GlowupRenderTheme, position: BodyPosition) {
    return renderGlowupOutput(theme, nodeText(node, theme), {
        expanded: true,
        mode: "headTail",
        maxPreviewLines: DEFAULT_EXPANDED_PREVIEW_LINES,
        noOutputLabel: null,
        prefixFirst: bodyFirstPrefix(theme, position),
        prefixRest: BODY_INDENT,
    });
}

function renderProtocolList(
    node: GlowupListNode,
    theme: GlowupRenderTheme,
    { lastComponent: _lastComponent, ...context }: ThirdPartyToolRenderContext,
    position: BodyPosition,
) {
    const { streamKey } = context;
    const options: GlowupOutputRenderOptions = {
        expanded: context.expanded,
        mode: previewMode(node.preview),
        maxPreviewLines: previewLines(node.preview, context.expanded),
        noOutputLabel: null,
        prefixFirst: bodyFirstPrefix(theme, position),
        prefixRest: BODY_INDENT,
    };

    return makeComponent((width) => {
        const content = nodeText(
            node,
            theme,
            (value, key, indent) =>
                protocolContent(
                    value,
                    context,
                    Math.max(1, width - BODY_INDENT.length - indent),
                    key,
                ),
            streamKey ?? "root",
        );

        return renderGlowupOutput(theme, content, options).render(width);
    });
}

function renderProtocolContent(
    node: Extract<GlowupNode, { kind: "code" | "output" }>,
    theme: GlowupRenderTheme,
    { lastComponent: _lastComponent, ...context }: ThirdPartyToolRenderContext,
    position: BodyPosition,
) {
    let contentPosition = position;
    if (node.kind === "code" && node.title !== undefined) contentPosition = "continued";

    let noOutputLabel: string | null = null;
    if (node.kind === "output") noOutputLabel = node.noOutputLabel ?? null;

    const options: GlowupOutputRenderOptions = {
        expanded: context.expanded,
        mode: previewMode(node.preview),
        maxPreviewLines: previewLines(node.preview, context.expanded),
        maxExpandedLines: previewLines(node.preview, true),
        noOutputLabel,
        prefixFirst: bodyFirstPrefix(theme, contentPosition),
        prefixRest: BODY_INDENT,
        invalidate: context.invalidate,
        ...(node.syntax !== undefined && { syntax: node.syntax }),
    };
    const content = makeComponent((width) =>
        renderGlowupOutput(
            theme,
            protocolContent(node, context, Math.max(1, width - BODY_INDENT.length)),
            options,
        ).render(width),
    );
    if (node.kind !== "code" || node.title === undefined) return content;

    const title = renderBodyText(theme, node.title, position);

    return makeComponent((width) => [...title.render(width), ...content.render(width)]);
}

/** Renders a decoded public protocol node through Glowup's private style engine. */
export function renderProtocolNode(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
    mutationSettings?: MutationSettings,
    position: BodyPosition = "first",
): ReturnType<typeof emptyComponent> {
    switch (node.kind) {
        case "empty":
            return emptyComponent();
        case "text":
            return renderBodyText(theme, node.text, position);
        case "summary":
            return renderSummary(node, theme, position);
        case "code":
        case "output":
            return renderProtocolContent(node, theme, context, position);
        case "list":
            return renderProtocolList(node, theme, context, position);
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
            const body = renderProtocolNode(
                node.body,
                theme,
                {
                    ...context,
                    streamKey: `${context.streamKey ?? "root"}.body`,
                },
                labelMode,
                mutationSettings,
            );

            return makeComponent((width) => [...header.render(width), ...body.render(width)]);
        }
        case "stack": {
            const { lastComponent: _lastComponent, ...childContext } = context;
            const firstVisible = node.children.findIndex((child) => child.kind !== "empty");
            const buildChildren = () =>
                node.children.map((child, index) => {
                    let childPosition: BodyPosition = "continued";
                    if (index === firstVisible) childPosition = position;

                    return renderProtocolNode(
                        child,
                        theme,
                        {
                            ...childContext,
                            lastComponent: undefined,
                            streamKey: `${childContext.streamKey ?? "root"}.${index}`,
                        },
                        labelMode,
                        mutationSettings,
                        childPosition,
                    );
                });
            let children = buildChildren();
            const rendered = makeComponent((width) =>
                children.flatMap((child) => child.render(width)),
            );

            return {
                render: (width) => rendered.render(width),
                invalidate() {
                    for (const child of children) child.invalidate();

                    // Text and headers bake theme colors when constructed.
                    children = buildChildren();
                    rendered.invalidate();
                },
            };
        }
    }

    throw new Error("Unsupported protocol node");
}
