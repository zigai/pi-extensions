import {
    emptyComponent,
    makeComponent,
    renderGlowupBody,
    renderGlowupOutput,
    type GlowupRenderTheme,
} from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import {
    callState,
    DEFAULT_TOOL_CALL_PREVIEW_LINES,
    renderThirdPartyCall,
    thirdPartyStatusLabel,
} from "./call-rendering.ts";
import type {
    GlowupCallContext,
    GlowupCallLabels,
    GlowupExecutionPhase,
    GlowupInline,
    GlowupNode,
    GlowupPreview,
    GlowupRenderer,
    GlowupResultContext,
    GlowupSummaryNode,
    GlowupSyntax,
    GlowupTone,
} from "../tool-rendering/protocol.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "./types.ts";

type UnknownGlowupRenderer = {
    readonly version: 2;
    readonly parseArgs?: (value: unknown) => unknown;
    readonly parseResult?: (value: unknown) => unknown;
    readonly renderCall?: (args: unknown, context: GlowupCallContext) => GlowupNode | undefined;
    readonly renderResult?: (
        result: unknown,
        context: GlowupResultContext<unknown>,
    ) => GlowupNode | undefined;
};

const DEFAULT_EXPANDED_PREVIEW_LINES = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
    try {
        return Reflect.get(record, key);
    } catch {
        return undefined;
    }
}

function parseTone(value: unknown): GlowupTone | undefined {
    switch (value) {
        case "default":
        case "muted":
        case "dim":
        case "accent":
        case "success":
        case "error":
        case "path":
        case "url":
        case "code":
            return value;
        default:
            return undefined;
    }
}

function parseInline(value: unknown): GlowupInline | undefined {
    if (typeof value === "string") return value;
    if (!isRecord(value) || field(value, "kind") !== "text") return undefined;
    const valueText = field(value, "text");
    if (typeof valueText !== "string") return undefined;
    const rawTone = field(value, "tone");
    const tone = rawTone === undefined ? undefined : parseTone(rawTone);
    if (rawTone !== undefined && tone === undefined) return undefined;
    const rawBold = field(value, "bold");
    if (rawBold !== undefined && typeof rawBold !== "boolean") return undefined;
    return {
        kind: "text",
        text: valueText,
        ...(tone === undefined ? {} : { tone }),
        ...(rawBold === undefined ? {} : { bold: rawBold }),
    };
}

function parseSyntax(value: unknown): GlowupSyntax | undefined {
    if (!isRecord(value)) return undefined;
    const language = field(value, "language");
    const path = field(value, "path");
    if (language !== undefined && typeof language !== "string") return undefined;
    if (path !== undefined && typeof path !== "string") return undefined;
    return {
        ...(language === undefined ? {} : { language }),
        ...(path === undefined ? {} : { path }),
    };
}

function parsePreview(value: unknown): GlowupPreview | undefined {
    if (!isRecord(value)) return undefined;
    const mode = field(value, "mode");
    if (mode !== undefined && mode !== "head" && mode !== "headTail" && mode !== "hidden") {
        return undefined;
    }
    const collapsedLines = field(value, "collapsedLines");
    const expandedLines = field(value, "expandedLines");
    const expandable = field(value, "expandable");
    const parseLimit = (limit: unknown): number | undefined =>
        typeof limit === "number" && Number.isFinite(limit) && limit >= 1 ? limit : undefined;
    const parsedCollapsedLines = parseLimit(collapsedLines);
    const parsedExpandedLines = parseLimit(expandedLines);
    if (
        (collapsedLines !== undefined && parsedCollapsedLines === undefined) ||
        (expandedLines !== undefined && parsedExpandedLines === undefined)
    ) {
        return undefined;
    }
    if (expandable !== undefined && typeof expandable !== "boolean") return undefined;
    return {
        ...(mode === undefined ? {} : { mode }),
        ...(parsedCollapsedLines === undefined ? {} : { collapsedLines: parsedCollapsedLines }),
        ...(parsedExpandedLines === undefined ? {} : { expandedLines: parsedExpandedLines }),
        ...(expandable === undefined ? {} : { expandable }),
    };
}

function parseLabels(value: unknown): GlowupCallLabels | undefined {
    if (!isRecord(value)) return undefined;
    const staticLabel = field(value, "static");
    if (typeof staticLabel !== "string" || staticLabel.length === 0) return undefined;
    const running = field(value, "running");
    const completed = field(value, "completed");
    const failed = field(value, "failed");
    const parseOptionalLabel = (label: unknown): string | undefined =>
        label === undefined ? undefined : typeof label === "string" ? label : undefined;
    const parsedRunning = parseOptionalLabel(running);
    const parsedCompleted = parseOptionalLabel(completed);
    const parsedFailed = parseOptionalLabel(failed);
    if (
        (running !== undefined && parsedRunning === undefined) ||
        (completed !== undefined && parsedCompleted === undefined) ||
        (failed !== undefined && parsedFailed === undefined)
    ) {
        return undefined;
    }
    return {
        static: staticLabel,
        ...(parsedRunning === undefined ? {} : { running: parsedRunning }),
        ...(parsedCompleted === undefined ? {} : { completed: parsedCompleted }),
        ...(parsedFailed === undefined ? {} : { failed: parsedFailed }),
    };
}

function parseGlowupNode(value: unknown, depth = 0): GlowupNode | undefined {
    if (!isRecord(value) || depth > 8) return undefined;
    switch (field(value, "kind")) {
        case "empty":
            return { kind: "empty" };
        case "text": {
            const rawText = field(value, "text");
            const parsed = typeof rawText === "string" ? rawText : parseInline(rawText);
            return parsed === undefined ? undefined : { kind: "text", text: parsed };
        }
        case "summary": {
            const rawRows = field(value, "rows");
            if (!Array.isArray(rawRows)) return undefined;
            const rows: Array<{ readonly label: GlowupInline; readonly value: GlowupInline }> = [];
            for (const rawRow of rawRows) {
                if (!isRecord(rawRow)) return undefined;
                const label = parseInline(field(rawRow, "label"));
                const rowValue = parseInline(field(rawRow, "value"));
                if (label === undefined || rowValue === undefined) return undefined;
                rows.push({ label, value: rowValue });
            }
            return { kind: "summary", rows };
        }
        case "code": {
            const rawText = field(value, "text");
            if (typeof rawText !== "string") return undefined;
            const rawTitle = field(value, "title");
            const title = rawTitle === undefined ? undefined : parseInline(rawTitle);
            const rawSyntax = field(value, "syntax");
            const syntax = rawSyntax === undefined ? undefined : parseSyntax(rawSyntax);
            const rawPreview = field(value, "preview");
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (
                (rawTitle !== undefined && title === undefined) ||
                (rawSyntax !== undefined && syntax === undefined) ||
                (rawPreview !== undefined && preview === undefined)
            ) {
                return undefined;
            }
            return {
                kind: "code",
                text: rawText,
                ...(title === undefined ? {} : { title }),
                ...(syntax === undefined ? {} : { syntax }),
                ...(preview === undefined ? {} : { preview }),
            };
        }
        case "list": {
            const rawItems = field(value, "items");
            if (!Array.isArray(rawItems)) return undefined;
            const items: Array<GlowupInline | GlowupNode> = [];
            for (const rawItem of rawItems) {
                const inline = parseInline(rawItem);
                const node = inline === undefined ? parseGlowupNode(rawItem, depth + 1) : undefined;
                if (inline === undefined && node === undefined) return undefined;
                if (inline !== undefined) items.push(inline);
                else if (node !== undefined) items.push(node);
            }
            const rawPreview = field(value, "preview");
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (rawPreview !== undefined && preview === undefined) return undefined;
            return { kind: "list", items, ...(preview === undefined ? {} : { preview }) };
        }
        case "call": {
            const labels = parseLabels(field(value, "labels"));
            if (labels === undefined) return undefined;
            const rawBody = field(value, "body");
            const body = rawBody === undefined ? undefined : parseGlowupNode(rawBody, depth + 1);
            const rawPreview = field(value, "preview");
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (
                (rawBody !== undefined && body === undefined) ||
                (rawPreview !== undefined && preview === undefined)
            ) {
                return undefined;
            }
            return {
                kind: "call",
                labels,
                ...(body === undefined ? {} : { body }),
                ...(preview === undefined ? {} : { preview }),
            };
        }
        case "output": {
            const rawText = field(value, "text");
            const rawSyntax = field(value, "syntax");
            const rawPreview = field(value, "preview");
            const rawNoOutputLabel = field(value, "noOutputLabel");
            const syntax = rawSyntax === undefined ? undefined : parseSyntax(rawSyntax);
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (
                (rawText !== undefined && typeof rawText !== "string") ||
                (rawSyntax !== undefined && syntax === undefined) ||
                (rawPreview !== undefined && preview === undefined) ||
                (rawNoOutputLabel !== undefined &&
                    rawNoOutputLabel !== null &&
                    typeof rawNoOutputLabel !== "string")
            ) {
                return undefined;
            }
            return {
                kind: "output",
                ...(rawText === undefined ? {} : { text: rawText }),
                ...(syntax === undefined ? {} : { syntax }),
                ...(preview === undefined ? {} : { preview }),
                ...(rawNoOutputLabel === undefined ? {} : { noOutputLabel: rawNoOutputLabel }),
            };
        }
        case "stack": {
            const rawChildren = field(value, "children");
            if (!Array.isArray(rawChildren)) return undefined;
            const children: GlowupNode[] = [];
            for (const rawChild of rawChildren) {
                const child = parseGlowupNode(rawChild, depth + 1);
                if (child === undefined) return undefined;
                children.push(child);
            }
            return { kind: "stack", children };
        }
        default:
            return undefined;
    }
}

function toneText(theme: GlowupRenderTheme, value: GlowupInline): string {
    if (typeof value === "string") {
        return value;
    }

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

function labelsForNode(labels: GlowupCallLabels, context: ThirdPartyToolRenderContext) {
    return {
        static: labels.static,
        active: labels.running ?? `Calling ${labels.static}`,
        completed: labels.completed ?? `Called ${labels.static}`,
        failed: labels.failed,
        context,
    };
}

function statusLabel(
    mode: ToolLabelMode,
    context: ThirdPartyToolRenderContext,
    labels: GlowupCallLabels,
): string {
    if (mode === "lifecycle" && context.isError && labels.failed !== undefined) {
        return labels.failed;
    }
    const lifecycle = labelsForNode(labels, context);
    return thirdPartyStatusLabel(mode, context, lifecycle);
}

function previewLines(preview: GlowupPreview | undefined, expanded: boolean): number {
    if (expanded) {
        return preview?.expandedLines ?? DEFAULT_EXPANDED_PREVIEW_LINES;
    }
    return preview?.collapsedLines ?? DEFAULT_TOOL_CALL_PREVIEW_LINES;
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
                .map((item) => `• ${typeof item === "string" ? item : nodeText(item, theme)}`)
                .join("\n");
        case "output":
            return node.text ?? "";
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

function renderSummary(
    node: GlowupSummaryNode,
    theme: GlowupRenderTheme,
): ReturnType<typeof renderGlowupOutput> {
    return renderGlowupOutput(theme, nodeText(node, theme), {
        expanded: true,
        mode: "headTail",
        maxPreviewLines: DEFAULT_EXPANDED_PREVIEW_LINES,
        noOutputLabel: null,
    });
}

function renderNode(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
): ReturnType<typeof emptyComponent> {
    switch (node.kind) {
        case "empty":
            return emptyComponent();
        case "text":
            return renderGlowupBody(theme, toneText(theme, node.text));
        case "summary":
            return renderSummary(node, theme);
        case "code": {
            const content = renderGlowupOutput(theme, node.text, {
                expanded: context.expanded,
                mode: previewMode(node.preview),
                maxPreviewLines: previewLines(node.preview, context.expanded),
                noOutputLabel: null,
                ...(node.syntax === undefined ? {} : { syntax: node.syntax }),
            });
            if (node.title === undefined) {
                return content;
            }
            const title = renderGlowupBody(theme, toneText(theme, node.title));
            return makeComponent((width) => [...title.render(width), ...content.render(width)]);
        }
        case "list":
            return renderGlowupOutput(theme, nodeText(node, theme), {
                expanded: context.expanded,
                mode: previewMode(node.preview),
                maxPreviewLines: previewLines(node.preview, context.expanded),
                noOutputLabel: null,
            });
        case "output":
            return renderGlowupOutput(theme, node.text, {
                expanded: context.expanded,
                mode: previewMode(node.preview),
                maxPreviewLines: previewLines(node.preview, context.expanded),
                noOutputLabel: node.noOutputLabel ?? null,
                ...(node.syntax === undefined ? {} : { syntax: node.syntax }),
            });
        case "call": {
            const headerOptions = {
                state: callState(context),
                statusText: statusLabel(labelMode, context, node.labels),
                body: undefined,
                maxRenderedLines: previewLines(node.preview, context.expanded),
                expanded: context.expanded,
                ...(context.expanded
                    ? { expandable: false }
                    : node.preview?.expandable === undefined
                      ? {}
                      : { expandable: node.preview.expandable }),
            };
            if (node.body === undefined || node.body.kind === "text") {
                return renderThirdPartyCall(theme, {
                    ...headerOptions,
                    ...(node.body === undefined ? {} : { body: nodeText(node.body, theme) }),
                });
            }
            const header = renderThirdPartyCall(theme, headerOptions);
            const body = renderNode(node.body, theme, context, labelMode);
            return makeComponent((width) => [...header.render(width), ...body.render(width)]);
        }
        case "stack":
            return makeComponent((width) =>
                node.children.flatMap((child) =>
                    renderNode(child, theme, context, labelMode).render(width),
                ),
            );
    }
}

function publicCallContext(context: ThirdPartyToolRenderContext): GlowupCallContext {
    const phase: GlowupExecutionPhase =
        context.phase ??
        (context.isPartial || context.argsComplete === false
            ? context.executionStarted === true
                ? "running"
                : "pending"
            : "complete");
    return {
        toolName: context.toolName ?? "tool",
        toolCallId: context.toolCallId,
        phase,
        argsComplete: context.argsComplete,
        isPartial: context.isPartial,
        expanded: context.expanded,
        showImages: context.showImages,
        isError: context.isError,
    };
}

function publicResultContext(
    context: ThirdPartyToolRenderContext,
    args: unknown,
): GlowupResultContext<unknown> {
    return { ...publicCallContext(context), args };
}

function safelyParse(parser: ((value: unknown) => unknown) | undefined, value: unknown): unknown {
    if (parser === undefined) {
        return value;
    }
    try {
        return parser(value);
    } catch {
        return undefined;
    }
}

/** Creates a Pi renderer from a validated public Glowup adapter. */
export function createProtocolRenderer(
    adapter: UnknownGlowupRenderer,
    fallback: ThirdPartyToolRenderer,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            if (adapter.renderCall === undefined) {
                return fallback.renderCall(args, theme, context);
            }
            const parsedArgs = safelyParse(adapter.parseArgs, args);
            if (parsedArgs === undefined) {
                return fallback.renderCall(args, theme, context);
            }
            try {
                const node = adapter.renderCall(parsedArgs, publicCallContext(context));
                const parsedNode = node === undefined ? undefined : parseGlowupNode(node);
                return parsedNode === undefined
                    ? fallback.renderCall(args, theme, context)
                    : renderNode(parsedNode, theme, context, labelMode);
            } catch {
                return fallback.renderCall(args, theme, context);
            }
        },
        renderResult(result, options, theme, context) {
            if (adapter.renderResult === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            const parsedArgs = safelyParse(adapter.parseArgs, context.args);
            const parsedResult = safelyParse(adapter.parseResult, result);
            if (parsedArgs === undefined || parsedResult === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            try {
                const node = adapter.renderResult(
                    parsedResult,
                    publicResultContext(context, parsedArgs),
                );
                const parsedNode = node === undefined ? undefined : parseGlowupNode(node);
                return parsedNode === undefined
                    ? fallback.renderResult(result, options, theme, context)
                    : renderNode(parsedNode, theme, { ...context, args: parsedArgs }, labelMode);
            } catch {
                return fallback.renderResult(result, options, theme, context);
            }
        },
    };
}

/** Runtime guard for values crossing the tool-definition boundary. */
export function isGlowupRenderingAdapter(value: unknown): value is UnknownGlowupRenderer {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        if (Reflect.get(value, "version") !== 2) {
            return false;
        }
        const renderCall = Reflect.get(value, "renderCall");
        const renderResult = Reflect.get(value, "renderResult");
        return typeof renderCall === "function" || typeof renderResult === "function";
    } catch {
        return false;
    }
}

/** Extracts a public adapter from an unknown tool definition. */
export function glowupRenderingAdapter(
    toolDefinition: unknown,
    propertyName = "glowupRendering",
): UnknownGlowupRenderer | undefined {
    if (
        typeof toolDefinition !== "object" ||
        toolDefinition === null ||
        Array.isArray(toolDefinition)
    ) {
        return undefined;
    }
    try {
        const value = Reflect.get(toolDefinition, propertyName);
        return isGlowupRenderingAdapter(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/** Returns whether an unknown value is the public preserve preference. */
export function isGlowupPreservePreference(value: unknown): boolean {
    return value === "preserve";
}

export type { GlowupRenderer };
