import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type {
    GlowupCallLabels,
    GlowupCallNode,
    GlowupCodeNode,
    GlowupInline,
    GlowupMutationFile,
    GlowupMutationLine,
    GlowupMutationNode,
    GlowupNode,
    GlowupOutputNode,
    GlowupPreview,
    GlowupSyntax,
    GlowupTone,
} from "./protocol.js";

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
const inlineObjectSchema = Type.Object({
    kind: Type.Literal("text"),
    text: Type.String(),
    tone: Type.Optional(toneSchema),
    bold: Type.Optional(Type.Boolean()),
});
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

type MutableMutationLine = {
    kind: GlowupMutationLine["kind"];
    text: string;
    oldLine?: number;
    newLine?: number;
};

type MutableMutationFile = {
    path: string;
    previousPath?: string;
    lines: GlowupMutationLine[];
    added: number;
    removed: number;
    countsKnown?: boolean;
};

type MutableGlowupCodeNode = {
    readonly kind: "code";
    readonly text: string;
    title?: GlowupInline;
    syntax?: GlowupSyntax;
    preview?: GlowupPreview;
};

type MutableGlowupCallNode = {
    readonly kind: "call";
    readonly labels: GlowupCallLabels;
    body?: GlowupNode;
    preview?: GlowupPreview;
};

type MutableGlowupOutputNode = {
    readonly kind: "output";
    text?: string;
    syntax?: GlowupSyntax;
    preview?: GlowupPreview;
    noOutputLabel?: string | null;
};

type MutableGlowupMutationNode = {
    readonly kind: "mutation";
    readonly labels: GlowupCallLabels;
    readonly files: GlowupMutationFile[];
    patch?: string;
};

function makeCodeNode(
    text: string,
    title: GlowupInline | undefined,
    syntax: GlowupSyntax | undefined,
    preview: GlowupPreview | undefined,
): GlowupCodeNode {
    const node: MutableGlowupCodeNode = { kind: "code", text };
    if (title !== undefined) {
        // SAFETY: Setting title on building MutableGlowupCodeNode.
        (node as MutableGlowupCodeNode).title = title;
    }
    if (syntax !== undefined) {
        // SAFETY: Setting syntax on building MutableGlowupCodeNode.
        (node as MutableGlowupCodeNode).syntax = syntax;
    }
    if (preview !== undefined) {
        // SAFETY: Setting preview on building MutableGlowupCodeNode.
        (node as MutableGlowupCodeNode).preview = preview;
    }
    return node;
}

function makeCallNode(
    labels: GlowupCallLabels,
    body: GlowupNode | undefined,
    preview: GlowupPreview | undefined,
): GlowupCallNode {
    const node: MutableGlowupCallNode = { kind: "call", labels };
    if (body !== undefined) {
        // SAFETY: Setting body on building MutableGlowupCallNode.
        (node as MutableGlowupCallNode).body = body;
    }
    if (preview !== undefined) {
        // SAFETY: Setting preview on building MutableGlowupCallNode.
        (node as MutableGlowupCallNode).preview = preview;
    }
    return node;
}

function makeOutputNode(
    text: string | undefined,
    syntax: GlowupSyntax | undefined,
    preview: GlowupPreview | undefined,
    noOutputLabel: string | null | undefined,
): GlowupOutputNode {
    const node: MutableGlowupOutputNode = { kind: "output" };
    if (text !== undefined) {
        // SAFETY: Setting text on building MutableGlowupOutputNode.
        (node as MutableGlowupOutputNode).text = text;
    }
    if (syntax !== undefined) {
        // SAFETY: Setting syntax on building MutableGlowupOutputNode.
        (node as MutableGlowupOutputNode).syntax = syntax;
    }
    if (preview !== undefined) {
        // SAFETY: Setting preview on building MutableGlowupOutputNode.
        (node as MutableGlowupOutputNode).preview = preview;
    }
    if (noOutputLabel !== undefined) {
        // SAFETY: Setting noOutputLabel on building MutableGlowupOutputNode.
        (node as MutableGlowupOutputNode).noOutputLabel = noOutputLabel;
    }
    return node;
}

function makeMutationNode(
    labels: GlowupCallLabels,
    files: GlowupMutationFile[],
    patch: string | undefined,
): GlowupMutationNode {
    const node: MutableGlowupMutationNode = { kind: "mutation", labels, files };
    if (patch !== undefined) {
        // SAFETY: Setting patch on building MutableGlowupMutationNode.
        (node as MutableGlowupMutationNode).patch = patch;
    }
    return node;
}
function countText(state: DecodeState, value: string): boolean {
    state.textCharacters += value.length;
    return state.textCharacters <= state.limits.maxTextCharacters;
}
type MutableInlineObject = {
    kind: "text";
    text: string;
    tone?: GlowupTone;
    bold?: boolean;
};

type MutableLabels = {
    static: string;
    running?: string;
    completed?: string;
    failed?: string;
};

type MutableSyntax = {
    language?: string;
    path?: string;
};

function inline(value: GlowupInline, state: DecodeState): GlowupInline | undefined {
    if (Value.Check(stringSchema, value)) {
        return countText(state, value) ? value : undefined;
    }
    if (Value.Check(inlineObjectSchema, value) && countText(state, value.text)) {
        const detached: MutableInlineObject = {
            kind: "text",
            text: value.text,
        };
        if (value.tone !== undefined) detached.tone = value.tone;
        if (value.bold !== undefined) detached.bold = value.bold;
        return detached;
    }
    return undefined;
}
function cloneLabels(value: GlowupCallLabels, state: DecodeState): GlowupCallLabels | undefined {
    if (!countText(state, value.static)) return undefined;
    const detached: MutableLabels = {
        static: value.static,
    };
    if (value.running !== undefined) {
        if (!countText(state, value.running)) return undefined;
        detached.running = value.running;
    }
    if (value.completed !== undefined) {
        if (!countText(state, value.completed)) return undefined;
        detached.completed = value.completed;
    }
    if (value.failed !== undefined) {
        if (!countText(state, value.failed)) return undefined;
        detached.failed = value.failed;
    }
    return detached;
}
function cloneSyntax(value: GlowupSyntax, state: DecodeState): GlowupSyntax | undefined {
    const detached: MutableSyntax = {};
    if (value.language !== undefined) {
        if (!countText(state, value.language)) return undefined;
        detached.language = value.language;
    }
    if (value.path !== undefined) {
        if (!countText(state, value.path)) return undefined;
        detached.path = value.path;
    }
    return detached;
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
        case "summary": {
            if (value.rows.length > state.limits.maxCollectionItems) return undefined;
            const rows: Array<{ label: GlowupInline; value: GlowupInline }> = [];
            for (const row of value.rows) {
                const label = inline(row.label, state);
                const val = inline(row.value, state);
                if (label === undefined || val === undefined) return undefined;
                rows.push({ label, value: val });
            }
            return { kind: "summary", rows };
        }
        case "code": {
            if (!countText(state, value.text)) return undefined;
            const title = value.title !== undefined ? inline(value.title, state) : undefined;
            if (value.title !== undefined && title === undefined) return undefined;
            const syntax =
                value.syntax !== undefined ? cloneSyntax(value.syntax, state) : undefined;
            if (value.syntax !== undefined && syntax === undefined) return undefined;
            const preview =
                value.preview !== undefined ? normalizePreview(value.preview) : undefined;
            return makeCodeNode(value.text, title, syntax, preview);
        }
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
            const labels = cloneLabels(value.labels, state);
            if (labels === undefined) return undefined;
            const body =
                value.body === undefined
                    ? undefined
                    : decodeParsedNode(value.body, state, depth + 1);
            if (value.body !== undefined && body === undefined) return undefined;
            const preview =
                value.preview !== undefined ? normalizePreview(value.preview) : undefined;
            return makeCallNode(labels, body, preview);
        }
        case "output": {
            if (
                (value.text !== undefined && !countText(state, value.text)) ||
                (value.noOutputLabel !== undefined &&
                    value.noOutputLabel !== null &&
                    !countText(state, value.noOutputLabel))
            )
                return undefined;
            const syntax =
                value.syntax !== undefined ? cloneSyntax(value.syntax, state) : undefined;
            if (value.syntax !== undefined && syntax === undefined) return undefined;
            const preview =
                value.preview !== undefined ? normalizePreview(value.preview) : undefined;
            return makeOutputNode(value.text, syntax, preview, value.noOutputLabel);
        }
        case "mutation": {
            const labels = cloneLabels(value.labels, state);
            if (labels === undefined) return undefined;
            let itemCount = value.files.length;
            if (itemCount > state.limits.maxCollectionItems) return undefined;
            const files: GlowupMutationFile[] = [];
            for (const file of value.files) {
                itemCount += file.lines.length;
                if (
                    itemCount > state.limits.maxCollectionItems ||
                    !countText(state, file.path) ||
                    (file.previousPath !== undefined && !countText(state, file.previousPath))
                )
                    return undefined;
                const lines: GlowupMutationLine[] = [];
                for (const line of file.lines) {
                    if (!countText(state, line.text)) return undefined;
                    const mutationLine: MutableMutationLine = {
                        kind: line.kind,
                        text: line.text,
                    };
                    if (line.oldLine !== undefined) mutationLine.oldLine = line.oldLine;
                    if (line.newLine !== undefined) mutationLine.newLine = line.newLine;
                    lines.push(mutationLine);
                }
                const mutationFile: MutableMutationFile = {
                    path: file.path,
                    lines,
                    added: file.added,
                    removed: file.removed,
                };
                if (file.previousPath !== undefined) mutationFile.previousPath = file.previousPath;
                if (file.countsKnown !== undefined) mutationFile.countsKnown = file.countsKnown;
                files.push(mutationFile);
            }
            if (value.patch !== undefined && !countText(state, value.patch)) return undefined;
            return makeMutationNode(labels, files, value.patch);
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
