import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type { GlowupInline, GlowupNode } from "./protocol.js";

export type GlowupNodeDecodeLimits = {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxCollectionItems: number;
    readonly maxTextCharacters: number;
};

export const DEFAULT_GLOWUP_NODE_DECODE_LIMITS: GlowupNodeDecodeLimits = {
    maxDepth: 8,
    maxNodes: 1_000,
    maxCollectionItems: 1_000,
    maxTextCharacters: 1_000_000,
};

const stringSchema = Type.String();
const toneSchema = Type.Union([
    Type.Literal("default"),
    Type.Literal("muted"),
    Type.Literal("dim"),
    Type.Literal("accent"),
    Type.Literal("success"),
    Type.Literal("error"),
    Type.Literal("path"),
    Type.Literal("url"),
    Type.Literal("code"),
]);
const inlineSchema = Type.Union([
    Type.String(),
    Type.Object({
        kind: Type.Literal("text"),
        text: Type.String(),
        tone: Type.Optional(toneSchema),
        bold: Type.Optional(Type.Boolean()),
    }),
]);
const syntaxSchema = Type.Object({
    language: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
});
const previewSchema = Type.Object({
    mode: Type.Optional(
        Type.Union([Type.Literal("head"), Type.Literal("headTail"), Type.Literal("hidden")]),
    ),
    collapsedLines: Type.Optional(Type.Number({ minimum: 1 })),
    expandedLines: Type.Optional(Type.Number({ minimum: 1 })),
    expandable: Type.Optional(Type.Boolean()),
});
const labelsSchema = Type.Object({
    static: Type.String({ minLength: 1 }),
    running: Type.Optional(Type.String()),
    completed: Type.Optional(Type.String()),
    failed: Type.Optional(Type.String()),
});
const mutationLineSchema = Type.Object({
    kind: Type.Union([
        Type.Literal("context"),
        Type.Literal("addition"),
        Type.Literal("deletion"),
        Type.Literal("metadata"),
        Type.Literal("omission"),
    ]),
    text: Type.String(),
    oldLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
    newLine: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
const mutationFileSchema = Type.Object({
    path: Type.String({ minLength: 1 }),
    previousPath: Type.Optional(Type.String({ minLength: 1 })),
    lines: Type.Array(mutationLineSchema),
    added: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    removed: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    countsKnown: Type.Optional(Type.Boolean()),
});
const glowupNodeSchema = Type.Cyclic(
    {
        Node: Type.Union([
            Type.Object({ kind: Type.Literal("empty") }),
            Type.Object({ kind: Type.Literal("text"), text: inlineSchema }),
            Type.Object({
                kind: Type.Literal("summary"),
                rows: Type.Array(Type.Object({ label: inlineSchema, value: inlineSchema })),
            }),
            Type.Object({
                kind: Type.Literal("code"),
                text: Type.String(),
                title: Type.Optional(inlineSchema),
                syntax: Type.Optional(syntaxSchema),
                preview: Type.Optional(previewSchema),
            }),
            Type.Object({
                kind: Type.Literal("list"),
                items: Type.Array(Type.Union([inlineSchema, Type.Ref("Node")])),
                preview: Type.Optional(previewSchema),
            }),
            Type.Object({
                kind: Type.Literal("call"),
                labels: labelsSchema,
                body: Type.Optional(Type.Ref("Node")),
                preview: Type.Optional(previewSchema),
            }),
            Type.Object({
                kind: Type.Literal("output"),
                text: Type.Optional(Type.String()),
                syntax: Type.Optional(syntaxSchema),
                preview: Type.Optional(previewSchema),
                noOutputLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
            Type.Object({
                kind: Type.Literal("mutation"),
                labels: labelsSchema,
                files: Type.Array(mutationFileSchema, { minItems: 1 }),
                patch: Type.Optional(Type.String()),
            }),
            Type.Object({ kind: Type.Literal("stack"), children: Type.Array(Type.Ref("Node")) }),
        ]),
    },
    "Node",
);
type ParsedNode = Static<typeof glowupNodeSchema>;

type DecodeState = {
    readonly limits: GlowupNodeDecodeLimits;
    nodes: number;
    textCharacters: number;
};
function countText(state: DecodeState, value: string): boolean {
    state.textCharacters += value.length;
    return state.textCharacters <= state.limits.maxTextCharacters;
}
function inline(value: GlowupInline, state: DecodeState): GlowupInline | undefined {
    const text = Value.Check(stringSchema, value) ? Value.Parse(stringSchema, value) : value.text;
    return countText(state, text) ? value : undefined;
}
function countSyntax(
    value: { readonly language?: string; readonly path?: string },
    state: DecodeState,
): boolean {
    return (
        (value.language === undefined || countText(state, value.language)) &&
        (value.path === undefined || countText(state, value.path))
    );
}
function countLabels(
    value: {
        readonly static: string;
        readonly running?: string;
        readonly completed?: string;
        readonly failed?: string;
    },
    state: DecodeState,
): boolean {
    return [value.static, value.running, value.completed, value.failed].every(
        (label) => label === undefined || countText(state, label),
    );
}
function decodeParsedNode(
    value: ParsedNode,
    state: DecodeState,
    depth: number,
): GlowupNode | undefined {
    if (depth > state.limits.maxDepth || ++state.nodes > state.limits.maxNodes) return undefined;
    switch (value.kind) {
        case "empty":
            return { kind: "empty" };
        case "text": {
            const text = Value.Parse(inlineSchema, value.text);
            return inline(text, state) === undefined ? undefined : { kind: "text", text };
        }
        case "summary":
            if (value.rows.length > state.limits.maxCollectionItems) return undefined;
            for (const row of value.rows)
                if (
                    inline(row.label, state) === undefined ||
                    inline(row.value, state) === undefined
                )
                    return undefined;
            return value;
        case "code":
            if (
                !countText(state, value.text) ||
                (value.title !== undefined && inline(value.title, state) === undefined) ||
                (value.syntax !== undefined && !countSyntax(value.syntax, state))
            )
                return undefined;
            return value.preview === undefined
                ? value
                : { ...value, preview: normalizePreview(value.preview) };
        case "list": {
            if (value.items.length > state.limits.maxCollectionItems) return undefined;
            const items: Array<GlowupInline | GlowupNode> = [];
            for (const item of value.items) {
                if (Value.Check(inlineSchema, item)) {
                    const parsedInline = Value.Parse(inlineSchema, item);
                    if (inline(parsedInline, state) === undefined) return undefined;
                    items.push(parsedInline);
                } else {
                    const child = decodeParsedNode(item, state, depth + 1);
                    if (child === undefined) return undefined;
                    items.push(child);
                }
            }
            return value.preview === undefined
                ? { ...value, items }
                : { ...value, items, preview: normalizePreview(value.preview) };
        }
        case "call": {
            if (!countLabels(value.labels, state)) return undefined;
            const body =
                value.body === undefined
                    ? undefined
                    : decodeParsedNode(value.body, state, depth + 1);
            if (value.body !== undefined && body === undefined) return undefined;
            let node: GlowupNode = { kind: "call", labels: value.labels };
            if (body !== undefined) node = { ...node, body };
            if (value.preview !== undefined)
                node = { ...node, preview: normalizePreview(value.preview) };
            return node;
        }
        case "output":
            if (
                (value.text !== undefined && !countText(state, value.text)) ||
                (value.noOutputLabel !== undefined &&
                    value.noOutputLabel !== null &&
                    !countText(state, value.noOutputLabel)) ||
                (value.syntax !== undefined && !countSyntax(value.syntax, state))
            )
                return undefined;
            return value.preview === undefined
                ? value
                : { ...value, preview: normalizePreview(value.preview) };
        case "mutation": {
            if (!countLabels(value.labels, state)) return undefined;
            let itemCount = value.files.length;
            if (itemCount > state.limits.maxCollectionItems) return undefined;
            for (const file of value.files) {
                itemCount += file.lines.length;
                if (
                    itemCount > state.limits.maxCollectionItems ||
                    !countText(state, file.path) ||
                    (file.previousPath !== undefined && !countText(state, file.previousPath))
                )
                    return undefined;
                for (const line of file.lines) if (!countText(state, line.text)) return undefined;
            }
            return value.patch !== undefined && !countText(state, value.patch) ? undefined : value;
        }
        case "stack": {
            if (value.children.length > state.limits.maxCollectionItems) return undefined;
            const children: GlowupNode[] = [];
            for (const item of value.children) {
                const child = decodeParsedNode(item, state, depth + 1);
                if (child === undefined) return undefined;
                children.push(child);
            }
            return { kind: "stack", children };
        }
    }
}
function normalizePreview(value: Static<typeof previewSchema>): Static<typeof previewSchema> {
    let preview: Static<typeof previewSchema> = value;
    if (value.collapsedLines !== undefined)
        preview = { ...preview, collapsedLines: Math.trunc(value.collapsedLines) };
    if (value.expandedLines !== undefined)
        preview = { ...preview, expandedLines: Math.trunc(value.expandedLines) };
    return preview;
}

/** Decodes and bounds a semantic node returned across the tool-definition boundary. */
export function decodeGlowupNode(
    value: unknown,
    limits: GlowupNodeDecodeLimits = DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
): GlowupNode | undefined {
    if (
        !Number.isSafeInteger(limits.maxDepth) ||
        !Number.isSafeInteger(limits.maxNodes) ||
        !Number.isSafeInteger(limits.maxCollectionItems) ||
        !Number.isSafeInteger(limits.maxTextCharacters) ||
        limits.maxDepth < 0 ||
        limits.maxNodes < 1 ||
        limits.maxCollectionItems < 1 ||
        limits.maxTextCharacters < 1
    )
        return undefined;
    try {
        const parsed = Value.Parse(glowupNodeSchema, value);
        return decodeParsedNode(parsed, { limits, nodes: 0, textCharacters: 0 }, 0);
    } catch {
        return undefined;
    }
}
