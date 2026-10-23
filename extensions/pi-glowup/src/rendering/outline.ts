import Type from "typebox";
import type { CodePreview } from "./streaming/presentation.ts";
import { Value } from "typebox/value";
import { inlineObjectSchema, decodeGlowupNode } from "../tools/protocol/decode.ts";
import { stringParser } from "../json-scalar.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { makeComponent, omittedLinesLabel, toolExpandHint, wrapStyledText } from "./component.ts";
import {
    PREVIEW_MUTATION_SETTINGS,
    showsFullMutation,
    type MutationSettings,
} from "./preview-settings.ts";
import { selectSemanticDiffIndices, type SemanticDiffRowKind } from "./diff/preview-selection.ts";
import { buildUnifiedDiffRows } from "./diff/rows.ts";
import { getPierrePalette } from "./diff/theme.ts";
import { summaryDetail } from "./diff/pierre-renderer.ts";
import { formatMutationStats } from "./tool-header.ts";
import { mutationPayloads } from "../tools/protocol/mutation-renderer.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "./output.ts";
import { toolStatusLabel, type ToolLabelMode } from "./status-labels.ts";
import type { GlowupRenderTheme } from "./theme.ts";
import {
    call,
    code,
    output,
    stack,
    summary,
    text,
    type GlowupCallLabels,
    type GlowupInline,
    type GlowupNode,
    type GlowupMutationLine,
} from "../tools/protocol/contract.ts";
import { jsonObjectParser } from "../json-value.ts";
import { boundedPreviewValue, type PreviewValue } from "../tools/previews.ts";
import { textOutput } from "../tools/built-in/arguments.ts";
import type { ThirdPartyToolRenderer, ThirdPartyToolRenderContext } from "../tools/types.ts";

const inlineSchema = Type.Union([
    Type.String(),
    Type.Decode(inlineObjectSchema, (token) => token.text),
]);

function inline(value: GlowupInline): string {
    return Value.Decode(inlineSchema, value);
}

function listNode(item: GlowupInline | GlowupNode): GlowupNode {
    const scalar = stringParser.parse(item);
    if (scalar !== undefined) return text(scalar);
    if (Value.Check(inlineObjectSchema, item)) return text(item);

    const node = decodeGlowupNode(item);
    if (node === undefined) throw new Error("Outline list item is unavailable");
    return node;
}

function label(
    labels: GlowupCallLabels,
    context: ThirdPartyToolRenderContext,
    mode: ToolLabelMode,
): string {
    if (mode === "lifecycle" && context.isError && labels.failed !== undefined)
        return labels.failed;

    return toolStatusLabel(mode, context, {
        static: labels.static,
        active: labels.running ?? `${labels.static} running`,
        completed: labels.completed ?? labels.static,
    });
}

function replayOutlineNode(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    settings: MutationSettings,
): GlowupNode {
    if (node.kind === "mutation") {
        const payloads = mutationPayloads(node, settings);

        return {
            ...node,
            files: node.files.map((file, index) => {
                const payload = payloads[index];
                if (payload === undefined) return file;
                if (payload.kind === "summary")
                    return { ...file, lines: [{ kind: "omission", text: summaryDetail(payload) }] };

                const rows = buildUnifiedDiffRows(
                    payload.metadata,
                    { deletionLines: [], additionLines: [] },
                    getPierrePalette(theme),
                );

                return {
                    ...file,
                    lines: rows.map((row): GlowupMutationLine => {
                        if (row.kind !== "line") return { kind: "metadata", text: row.text };

                        let line: GlowupMutationLine = {
                            kind: row.lineType,
                            text: row.spans.map((span) => span.text).join(""),
                        };
                        if (row.oldLineNumber !== undefined)
                            line = { ...line, oldLine: row.oldLineNumber };

                        if (row.newLineNumber !== undefined)
                            line = { ...line, newLine: row.newLineNumber };

                        return line;
                    }),
                };
            }),
        };
    }

    if (node.kind === "call" && node.body !== undefined)
        return { ...node, body: replayOutlineNode(node.body, theme, settings) };

    if (node.kind === "stack")
        return {
            ...node,
            children: node.children.map((child) => replayOutlineNode(child, theme, settings)),
        };

    if (node.kind === "list")
        return {
            ...node,
            items: node.items.map((item) => replayOutlineNode(listNode(item), theme, settings)),
        };

    return node;
}

function nodeRows(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    mode: ToolLabelMode,
    width: number,
    mutations: MutationSettings,
): string[] {
    switch (node.kind) {
        case "empty":
            return [];
        case "text":
            return inline(node.text)
                .split("\n")
                .flatMap((line) => wrapStyledText(line, width));
        case "summary":
            return node.rows.flatMap((row) =>
                `${inline(row.label)}: ${inline(row.value)}`
                    .split("\n")
                    .flatMap((line) => wrapStyledText(line, width)),
            );
        case "stack":
            return node.children.flatMap((child, index) =>
                nodeRows(
                    child,
                    theme,
                    { ...context, streamKey: `${context.streamKey ?? "root"}.${index}` },
                    mode,
                    width,
                    mutations,
                ),
            );
        case "call": {
            const heading = theme.bold(
                theme.fg("accent", `» ${label(node.labels, context, mode)}`),
            );
            const body =
                node.body === undefined
                    ? []
                    : nodeRows(
                          node.body,
                          theme,
                          { ...context, streamKey: `${context.streamKey ?? "root"}.body` },
                          mode,
                          Math.max(1, width - 2),
                          mutations,
                      );

            return [...wrapStyledText(heading, width), ...body.map((line) => `  ${line}`)];
        }
        case "list": {
            const rows = node.items.flatMap((item, index) => {
                const prefix = `${index + 1}. `;
                const bodyWidth = Math.max(1, width - prefix.length);
                const itemContext = {
                    ...context,
                    streamKey: `${context.streamKey ?? "root"}.${index}`,
                };
                const body = nodeRows(
                    listNode(item),
                    theme,
                    itemContext,
                    mode,
                    bodyWidth,
                    mutations,
                );

                return body.map((line, lineIndex) => {
                    if (lineIndex === 0) return `${prefix}${line}`;
                    return `${" ".repeat(prefix.length)}${line}`;
                });
            });

            return renderGlowupOutput(theme, rows.join("\n"), {
                expanded: context.expanded,
                mode: node.preview?.mode ?? "headTail",
                maxPreviewLines: node.preview?.collapsedLines ?? 6,
                maxExpandedLines: node.preview?.expandedLines ?? 500,
                prefixFirst: "",
                prefixRest: "",
                dimContent: false,
                noOutputLabel: null,
            }).render(width);
        }
        case "code":
        case "output": {
            let max = node.preview?.collapsedLines ?? 8;
            if (context.expanded) max = node.preview?.expandedLines ?? 500;

            let outputOptions: GlowupOutputRenderOptions = {
                expanded: context.expanded,
                mode: node.preview?.mode ?? "headTail",
                maxPreviewLines: max,
                maxExpandedLines: node.preview?.expandedLines ?? 500,
                prefixFirst: "",
                prefixRest: "",
                dimContent: false,
                noOutputLabel: null,
                invalidate: context.invalidate,
            };
            if (node.kind === "output")
                outputOptions = { ...outputOptions, noOutputLabel: node.noOutputLabel ?? null };

            if (node.syntax !== undefined)
                outputOptions = { ...outputOptions, syntax: node.syntax };

            let content = node.text;
            if (node.kind === "code" && context.streamCode !== undefined)
                content = context.streamCode({
                    key: `tool:${context.toolCallId}:code:${context.streamKey ?? "root"}`,
                    source: node.text,
                    ...node.syntax,
                    complete: context.argsComplete || context.isError,
                    targetWidth: Math.max(1, width),
                    ...(context.invalidate !== undefined && { invalidate: context.invalidate }),
                });

            const rows = renderGlowupOutput(theme, content, outputOptions).render(width);
            if (node.kind === "code" && node.title !== undefined)
                rows.unshift(...wrapStyledText(theme.fg("accent", inline(node.title)), width));

            return rows;
        }
        case "mutation": {
            const full = showsFullMutation(mutations, context.expanded);

            return node.files.flatMap((file) => {
                let path = file.path;
                if (file.previousPath !== undefined) path = `${file.previousPath} → ${file.path}`;

                let heading = theme.fg("accent", path);
                if (file.countsKnown !== false) {
                    const stats = formatMutationStats(
                        theme,
                        {
                            label: node.labels.static,
                            path,
                            added: file.added,
                            removed: file.removed,
                        },
                        undefined,
                    );
                    if (stats.length > 0) heading += ` ${stats}`;
                }

                const header = truncateToWidth(heading, width, "…");
                const kinds = file.lines.map((line): SemanticDiffRowKind => {
                    if (line.kind === "addition") return "insert";
                    if (line.kind === "deletion") return "delete";
                    if (line.kind === "context") return "context";
                    return "meta";
                });
                let indices: readonly number[] = file.lines.map((_line, index) => index);
                if (!full) indices = selectSemanticDiffIndices(kinds, mutations.previewLines);

                const body = indices.flatMap((index) => {
                    const line = file.lines[index];
                    if (line === undefined) throw new Error("Outline mutation row is unavailable");

                    let sign = " ";
                    if (line.kind === "addition") sign = "+";
                    if (line.kind === "deletion") sign = "-";
                    if (line.kind === "omission") sign = "…";

                    let text = `${sign} ${line.text}`;
                    if (line.kind === "omission") text = theme.fg("dim", text);
                    if (!context.expanded) text = truncateToWidth(text, width * 4, "…");

                    return wrapStyledText(text, width);
                });
                const omitted = file.lines.length - indices.length;
                if (omitted > 0)
                    body.push(
                        truncateToWidth(
                            theme.fg("dim", `${omittedLinesLabel(omitted)} (${toolExpandHint()})`),
                            width,
                            "…",
                        ),
                    );

                return [header, ...body];
            });
        }
    }

    throw new Error("Unsupported outline node");
}

export function renderOutlineNode(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    { lastComponent: _lastComponent, ...context }: ThirdPartyToolRenderContext,
    mode: ToolLabelMode,
    mutations: MutationSettings = PREVIEW_MUTATION_SETTINGS,
) {
    const replay = replayOutlineNode(node, theme, mutations);

    return makeComponent((width) =>
        nodeRows(replay, theme, context, mode, Math.max(1, width - 2), mutations).map((line) =>
            truncateToWidth(`  ${line}`, width, ""),
        ),
    );
}

export function createOutlineRenderer(
    toolName: string,
    mode: ToolLabelMode = "lifecycle",
    codeSource?: ThirdPartyToolRenderer["codeSource"],
    streamCode?: CodePreview,
): ThirdPartyToolRenderer {
    return {
        ...(codeSource !== undefined && { codeSource }),
        renderCall: (args, theme, context) => {
            const object = jsonObjectParser.parse(args) ?? {};
            const rows = Object.entries(object).flatMap(([name, value]) => {
                if (name === "command" || name === "code" || name === "content") return [];

                const preview = boundedPreviewValue(value, new WeakSet(), 0, name);
                let text = stringParser.parse(preview) ?? JSON.stringify(preview);
                if (Array.isArray(preview))
                    text = preview
                        .map(
                            (item: PreviewValue) =>
                                stringParser.parse(item) ?? JSON.stringify(item),
                        )
                        .join(", ");
                else {
                    const nested = jsonObjectParser.parse(preview);
                    if (nested !== undefined) text = Object.keys(nested).join(", ");
                }

                return [{ label: name, value: text }];
            });
            const children: GlowupNode[] = [];
            if (rows.length > 0) children.push(summary(rows));

            let source: ReturnType<NonNullable<ThirdPartyToolRenderer["codeSource"]>>;
            if (streamCode !== undefined) source = codeSource?.(args, context);

            let renderContext = context;

            if (source !== undefined && streamCode !== undefined) {
                children.push(
                    code(source.source, {
                        syntax: {
                            ...(source.language !== undefined && { language: source.language }),
                            ...(source.path !== undefined && { path: source.path }),
                        },
                    }),
                );

                const key = source.key;

                renderContext = {
                    ...context,
                    streamCode: (input) => streamCode({ ...input, key }),
                };
            } else {
                for (const field of ["command", "code", "content"]) {
                    const value = stringParser.parse(object[field]);
                    if (value !== undefined) children.push(code(value));
                }
            }

            return renderOutlineNode(
                call({ static: toolName }, { body: stack(children) }),
                theme,
                renderContext,
                mode,
            );
        },
        renderResult: (result, options, theme, context) => {
            const content = textOutput(result) ?? "";
            return renderOutlineNode(
                output(content),
                theme,
                { ...context, expanded: options.expanded },
                mode,
            );
        },
    };
}
