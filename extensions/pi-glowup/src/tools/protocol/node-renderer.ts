import { renderInline, renderText } from "./inline-renderer.ts";
import { displayMutationPath } from "../../rendering/path.ts";
import type { Component } from "@earendil-works/pi-tui";
import { protocolContent } from "./content.ts";
import { createMarkdownRows, previewRenderedRows } from "./rendered-content.ts";
import { text } from "./nodes.ts";
import { emptyComponent, makeComponent, wrapPrefixedLine } from "../../rendering/component.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../rendering/output.ts";
import {
    createSyntaxComponent,
    inheritSyntaxComponent,
    retireSyntaxComponent,
} from "../../rendering/syntax/component-owner.ts";
import { renderSyntaxComponent } from "../../rendering/syntax/code-component.ts";
import { dim, type GlowupRenderTheme } from "../../rendering/theme.ts";
import type { MutationSettings } from "../../rendering/preview-settings.ts";
import { toolStatusLabel, type ToolLabelMode } from "../../rendering/status-labels.ts";
import type {
    GlowupCallLabels,
    GlowupCodeNode,
    GlowupListNode,
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

type ProtocolSlot = {
    readonly toolCallId: string;
    readonly streamPhase: "call" | "result" | undefined;
    readonly streamKey: string | undefined;
};

const contentSlots = new WeakMap<
    Component,
    {
        readonly slot: ProtocolSlot;
        readonly kind: "code" | "output";
        readonly markdown?: ReturnType<typeof createMarkdownRows> | undefined;
    }
>();
const callBodies = new WeakMap<
    Component,
    { readonly slot: ProtocolSlot; readonly body: Component }
>();
const listChildren = new WeakMap<
    Component,
    { readonly slot: ProtocolSlot; readonly children: readonly Component[] }
>();
const stackChildren = new WeakMap<
    Component,
    { readonly slot: ProtocolSlot; readonly children: readonly Component[] }
>();

function protocolSlot(context: ThirdPartyToolRenderContext): ProtocolSlot {
    return {
        toolCallId: context.toolCallId,
        streamPhase: context.streamPhase,
        streamKey: context.streamKey,
    };
}

function sameProtocolSlot(
    slot: ProtocolSlot | undefined,
    context: ThirdPartyToolRenderContext,
): boolean {
    return (
        slot !== undefined &&
        slot.toolCallId === context.toolCallId &&
        slot.streamPhase === context.streamPhase &&
        slot.streamKey === context.streamKey
    );
}

function retireProtocolComponent(component: Component): void {
    const call = callBodies.get(component);
    if (call !== undefined) {
        callBodies.delete(component);
        retireProtocolComponent(call.body);
    }

    const list = listChildren.get(component);
    if (list !== undefined) {
        listChildren.delete(component);

        for (const child of list.children) retireProtocolComponent(child);
    }

    const stack = stackChildren.get(component);
    if (stack !== undefined) {
        stackChildren.delete(component);

        for (const child of stack.children) retireProtocolComponent(child);
    }

    contentSlots.delete(component);
    retireSyntaxComponent(component);
}

function retireReplacedComponent(node: GlowupNode, context: ThirdPartyToolRenderContext): void {
    const previous = context.lastComponent;
    if (previous === undefined) return;

    const content = contentSlots.get(previous);
    if (content !== undefined && sameProtocolSlot(content.slot, context)) {
        if (
            node.kind !== content.kind ||
            (node.syntax === undefined &&
                !(node.kind === "output" && node.format === "markdown")) ||
            (context.invalidate === undefined &&
                !(node.kind === "output" && node.format === "markdown"))
        )
            retireProtocolComponent(previous);

        return;
    }

    const call = callBodies.get(previous);
    if (call !== undefined && sameProtocolSlot(call.slot, context)) {
        if (
            node.kind !== "call" ||
            node.body === undefined ||
            (node.body.kind === "text" && node.body.parts === undefined)
        )
            retireProtocolComponent(previous);

        return;
    }

    const list = listChildren.get(previous);
    if (list !== undefined && sameProtocolSlot(list.slot, context) && node.kind !== "list")
        retireProtocolComponent(previous);

    const stack = stackChildren.get(previous);
    if (stack !== undefined && sameProtocolSlot(stack.slot, context) && node.kind !== "stack")
        retireProtocolComponent(previous);
}

type BodyPosition = "first" | "continued" | "bare";

function bodyFirstPrefix(theme: GlowupRenderTheme, position: BodyPosition): string {
    if (position === "bare") return "";
    if (position === "first") return dim(theme, "  └ ");
    return BODY_INDENT;
}

function renderBodyText(
    theme: GlowupRenderTheme,
    value: Extract<GlowupNode, { kind: "text" }>,
    position: BodyPosition,
): ReturnType<typeof makeComponent> {
    return makeComponent((width) =>
        wrapPrefixedLine(
            renderText(theme, value),
            width,
            bodyFirstPrefix(theme, position),
            position === "bare" ? "" : BODY_INDENT,
        ),
    );
}

function statusLabel(
    mode: ToolLabelMode,
    context: ThirdPartyToolRenderContext,
    labels: GlowupCallLabels,
    isError = context.isError,
): string {
    if (mode === "lifecycle" && isError && labels.failed !== undefined) {
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
    width = Number.MAX_SAFE_INTEGER,
): string {
    switch (node.kind) {
        case "text":
            return renderText(theme, node);
        case "summary":
            return node.rows
                .map(
                    (row) =>
                        `${renderInline(theme, row.label)} ${theme.fg("dim", "→")} ${renderInline(theme, row.value)}`,
                )
                .join("\n");
        case "code":
            return [
                node.title === undefined ? undefined : renderInline(theme, node.title),
                codeContent(node, key, indent),
            ]
                .filter((value): value is string => value !== undefined)
                .join("\n");
        case "list":
            return node.items
                .map((item, index) => {
                    const tree = node.style === "tree";
                    const itemIndent = indent + (tree ? 4 : 2);
                    let content: string;
                    if (!(item instanceof Object)) content = item;
                    else if (item.kind === "text" && ("tone" in item || "bold" in item))
                        content = renderInline(theme, item);
                    else
                        content = nodeText(
                            item,
                            theme,
                            codeContent,
                            `${key}.${index}`,
                            itemIndent,
                            width,
                        );

                    if (!tree) return `• ${content}`;

                    const last = index === node.items.length - 1;
                    return wrapPrefixedLine(
                        content,
                        Math.max(1, width - indent),
                        dim(theme, last ? "  └ " : "  ├ "),
                        last ? BODY_INDENT : dim(theme, "  │ "),
                    ).join("\n");
                })
                .join("\n");
        case "output":
            return codeContent(node, key, indent);
        case "mutation":
            return node.files
                .map((file) => displayMutationPath(file.path, file.previousPath))
                .join("\n");
        case "stack":
            return node.children
                .map((child, index) =>
                    nodeText(child, theme, codeContent, `${key}.${index}`, indent, width),
                )
                .filter(Boolean)
                .join("\n");
        case "call":
            return node.body === undefined
                ? ""
                : nodeText(node.body, theme, codeContent, `${key}.body`, indent, width);
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
        prefixRest: position === "bare" ? "" : BODY_INDENT,
        ...(position === "bare" && { dimContent: false }),
    });
}

function renderSemanticList(
    node: GlowupListNode,
    theme: GlowupRenderTheme,
    { lastComponent, ...context }: ThirdPartyToolRenderContext,
    position: BodyPosition,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings | undefined,
): Component {
    let previous: readonly Component[] = [];
    if (lastComponent !== undefined) {
        const old = listChildren.get(lastComponent);
        if (old !== undefined && sameProtocolSlot(old.slot, context)) previous = old.children;
    }

    for (const child of previous.slice(node.items.length)) retireProtocolComponent(child);
    const buildChildren = (old: readonly Component[]) =>
        node.items.map((item, index) => {
            const child = !(item instanceof Object)
                ? text(item)
                : item.kind === "text" && ("tone" in item || "bold" in item)
                  ? text(item)
                  : item;

            return renderProtocolNode(
                child,
                theme,
                {
                    ...context,
                    lastComponent: old[index],
                    ...(context.invalidate !== undefined && {
                        invalidate: () => {
                            rendered.invalidate();
                            context.invalidate?.();
                        },
                    }),
                    streamKey: `${context.streamKey ?? "root"}.${index}`,
                },
                labelMode,
                mutationSettings,
                "bare",
            );
        });
    let children = buildChildren(previous);
    const slot = protocolSlot(context);
    const rendered = makeComponent((width) => {
        const tree = node.style === "tree";
        const indent = tree ? 4 : 2;
        const outerIndent = tree || position === "bare" ? 0 : BODY_INDENT.length;
        const contentWidth = Math.max(1, width - outerIndent);
        const rows = children.flatMap((child, index) => {
            const last = index === children.length - 1;
            const first = tree ? dim(theme, last ? "  └ " : "  ├ ") : "• ";
            const rest = tree && !last ? dim(theme, "  │ ") : " ".repeat(indent);

            return child
                .render(Math.max(1, contentWidth - indent))
                .map((row, rowIndex) => `${rowIndex === 0 ? first : rest}${row}`);
        });
        const visible = previewRenderedRows(
            rows,
            theme,
            node.preview,
            context.expanded,
            contentWidth,
        );
        if (outerIndent === 0) return visible;
        return visible.map(
            (row, index) => `${index === 0 ? bodyFirstPrefix(theme, position) : BODY_INDENT}${row}`,
        );
    });
    const component: Component = {
        render: (width) => rendered.render(width),
        invalidate() {
            for (const child of children) child.invalidate();
            children = buildChildren(children);
            listChildren.set(component, { slot, children });
            rendered.invalidate();
        },
    };

    listChildren.set(component, { slot, children });

    return component;
}

function hasRichContent(node: GlowupListNode["items"][number]): boolean {
    if (!(node instanceof Object)) return false;

    switch (node.kind) {
        case "text":
            return "parts" in node;
        case "output":
            return node.format === "markdown";
        case "stack":
            return node.children.some(hasRichContent);
        case "call":
            return node.body !== undefined && hasRichContent(node.body);
        case "list":
            return node.style === "tree" || node.items.some(hasRichContent);
        case "code":
        case "empty":
        case "mutation":
        case "summary":
            return false;
    }

    throw new Error("Unsupported protocol node");
}

function renderProtocolList(
    node: GlowupListNode,
    theme: GlowupRenderTheme,
    { lastComponent, ...context }: ThirdPartyToolRenderContext,
    position: BodyPosition,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings | undefined,
) {
    if (node.style === "tree" || position === "bare" || node.items.some(hasRichContent))
        return renderSemanticList(
            node,
            theme,
            { ...context, lastComponent },
            position,
            labelMode,
            mutationSettings,
        );

    // Preserve the established ordinary bullet frames byte-for-byte.
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
            context.streamKey ?? "root",
            0,
            Math.max(1, width - BODY_INDENT.length),
        );

        return renderGlowupOutput(theme, content, options).render(width);
    });
}

function renderProtocolContent(
    node: Extract<GlowupNode, { kind: "code" | "output" }>,
    theme: GlowupRenderTheme,
    { lastComponent, ...context }: ThirdPartyToolRenderContext,
    position: BodyPosition,
) {
    const markdown = node.kind === "output" && node.format === "markdown";
    const syntaxAware = node.syntax !== undefined || markdown;
    let contentPosition = position;
    if (node.kind === "code" && node.title !== undefined && position !== "bare")
        contentPosition = "continued";

    let noOutputLabel: string | null = null;
    if (node.kind === "output") noOutputLabel = node.noOutputLabel ?? null;

    let previous: Component | undefined;
    if (
        lastComponent !== undefined &&
        sameProtocolSlot(contentSlots.get(lastComponent)?.slot, context)
    )
        previous = lastComponent;

    let ownedMarkdown: ReturnType<typeof createMarkdownRows> | undefined;
    if (markdown && previous !== undefined) ownedMarkdown = contentSlots.get(previous)?.markdown;

    const createContent = (invalidate: (() => void) | undefined): Component => {
        let contentContext = context;
        if (invalidate !== undefined) contentContext = { ...context, invalidate };

        const options: GlowupOutputRenderOptions = {
            expanded: context.expanded,
            mode: previewMode(node.preview),
            maxPreviewLines: previewLines(node.preview, context.expanded),
            maxExpandedLines: previewLines(node.preview, true),
            noOutputLabel,
            prefixFirst: bodyFirstPrefix(theme, contentPosition),
            prefixRest: position === "bare" ? "" : BODY_INDENT,
            ...(position === "bare" && { dimContent: false }),
            invalidate,
            syntaxSource: node.text ?? "",
            ...(node.syntax !== undefined &&
                context.renderProbe !== true && { syntax: node.syntax }),
        };

        if (markdown) {
            ownedMarkdown ??= createMarkdownRows(theme, invalidate);
            ownedMarkdown.update(theme, invalidate);
        }

        const markdownContent = ownedMarkdown;
        const body = makeComponent((width) => {
            const indent = position === "bare" ? 0 : BODY_INDENT.length;
            const contentWidth = Math.max(1, width - indent);
            const content = protocolContent(node, contentContext, contentWidth);
            if (markdownContent === undefined)
                return renderGlowupOutput(theme, content, options).render(width);

            let rows = markdownContent.render(content, contentWidth);
            if (rows.length === 0 && noOutputLabel !== null) rows = [dim(theme, noOutputLabel)];

            return previewRenderedRows(
                rows,
                theme,
                node.preview,
                context.expanded,
                contentWidth,
            ).map(
                (row, index) =>
                    `${index === 0 ? bodyFirstPrefix(theme, contentPosition) : position === "bare" ? "" : BODY_INDENT}${row}`,
            );
        });

        return {
            render(width) {
                if (markdownContent?.syncSyntaxVersion() === true) body.invalidate();
                if (invalidate === undefined || !syntaxAware) return body.render(width);
                return renderSyntaxComponent(body, invalidate, width);
            },
            invalidate() {
                markdownContent?.invalidate();
                body.invalidate();
            },
        };
    };
    let content: Component;
    if (context.invalidate !== undefined && syntaxAware) {
        content = createSyntaxComponent(
            previous,
            context.invalidate,
            createContent,
            // Markdown observes the visible streamed source when it renders.
            markdown ? undefined : (node.text ?? ""),
        );
    } else {
        if (previous !== undefined) retireSyntaxComponent(previous);
        content = createContent(context.invalidate);
    }

    contentSlots.set(content, {
        slot: protocolSlot(context),
        kind: node.kind,
        markdown: ownedMarkdown,
    });

    if (node.kind !== "code" || node.title === undefined) return content;

    const title = renderBodyText(theme, text(node.title), position);
    const titled = makeComponent((width) => [...title.render(width), ...content.render(width)]);
    inheritSyntaxComponent(titled, content);
    contentSlots.set(titled, { slot: protocolSlot(context), kind: node.kind });

    return titled;
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
    retireReplacedComponent(node, context);

    switch (node.kind) {
        case "empty":
            return emptyComponent();
        case "text":
            return renderBodyText(theme, node, position);
        case "summary":
            return renderSummary(node, theme, position);
        case "code":
        case "output":
            return renderProtocolContent(node, theme, context, position);
        case "list":
            return renderProtocolList(node, theme, context, position, labelMode, mutationSettings);
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
            let isError = context.isError;
            if (node.state !== undefined) isError = node.state === "error";

            let headerOptions: ThirdPartyCallOptions = {
                state: node.state ?? callState(context),
                statusText: statusLabel(labelMode, context, node.labels, isError),
                body: undefined,
                maxRenderedLines: previewLines(node.preview, context.expanded),
                expanded: context.expanded,
            };
            if (context.expanded) {
                headerOptions = { ...headerOptions, expandable: false };
            } else if (node.preview?.expandable !== undefined) {
                headerOptions = { ...headerOptions, expandable: node.preview.expandable };
            }

            if (
                node.body === undefined ||
                (node.body.kind === "text" && node.body.parts === undefined)
            ) {
                return renderThirdPartyCall(theme, {
                    ...headerOptions,
                    body: node.body === undefined ? undefined : nodeText(node.body, theme),
                });
            }

            let previous: Component | undefined;
            if (context.lastComponent !== undefined) {
                const old = callBodies.get(context.lastComponent);
                if (old !== undefined && sameProtocolSlot(old.slot, context)) previous = old.body;
            }

            const invalidateHost = context.invalidate;
            const header = renderThirdPartyCall(theme, headerOptions);
            const body = renderProtocolNode(
                node.body,
                theme,
                {
                    ...context,
                    lastComponent: previous,
                    ...(context.invalidate !== undefined && {
                        invalidate: () => {
                            rendered.invalidate();
                            invalidateHost?.();
                        },
                    }),
                    streamKey: `${context.streamKey ?? "root"}.body`,
                },
                labelMode,
                mutationSettings,
                position === "bare" ? "bare" : "first",
            );
            const rendered = makeComponent((width) => [
                ...header.render(width),
                ...body.render(width),
            ]);
            const component: Component = {
                render: (width) => rendered.render(width),
                invalidate() {
                    header.invalidate();
                    body.invalidate();
                    rendered.invalidate();
                },
            };

            callBodies.set(component, { slot: protocolSlot(context), body });

            return component;
        }
        case "stack": {
            const { lastComponent: _lastComponent, ...childContext } = context;
            const firstVisible = node.children.findIndex((child) => child.kind !== "empty");
            const buildChildren = (previous: readonly Component[] = []) =>
                node.children.map((child, index) => {
                    let childPosition: BodyPosition = position === "bare" ? "bare" : "continued";
                    if (index === firstVisible) childPosition = position;

                    return renderProtocolNode(
                        child,
                        theme,
                        {
                            ...childContext,
                            lastComponent: previous[index],
                            ...(childContext.invalidate !== undefined && {
                                invalidate: () => {
                                    rendered.invalidate();
                                    childContext.invalidate?.();
                                },
                            }),
                            streamKey: `${childContext.streamKey ?? "root"}.${index}`,
                        },
                        labelMode,
                        mutationSettings,
                        childPosition,
                    );
                });
            let previous: readonly Component[] | undefined;
            if (context.lastComponent !== undefined) {
                const old = stackChildren.get(context.lastComponent);
                if (old !== undefined && sameProtocolSlot(old.slot, context))
                    previous = old.children;
            }

            if (previous !== undefined) {
                for (const child of previous.slice(node.children.length))
                    retireProtocolComponent(child);
            }

            let children = buildChildren(previous);
            const slot = protocolSlot(context);
            const rendered = makeComponent((width) =>
                children.flatMap((child) => child.render(width)),
            );

            const component: Component = {
                render: (width) => rendered.render(width),
                invalidate() {
                    for (const child of children) child.invalidate();

                    // Text and headers bake theme colors when constructed.
                    children = buildChildren(children);
                    stackChildren.set(component, { slot, children });
                    rendered.invalidate();
                },
            };

            stackChildren.set(component, { slot, children });

            return component;
        }
    }

    throw new Error("Unsupported protocol node");
}
