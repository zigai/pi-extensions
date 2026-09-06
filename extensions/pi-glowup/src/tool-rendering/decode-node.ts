import Type, { type Static, type TProperties, type TObject } from "typebox";
import { Guard } from "typebox/guard";
import { Value } from "typebox/value";
import type {
    GlowupCallNode,
    GlowupCodeNode,
    GlowupInline,
    GlowupListNode,
    GlowupMutationFile,
    GlowupMutationNode,
    GlowupNode,
    GlowupOutputNode,
    GlowupPreview,
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
const collectionLengthSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
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
// Child fields stay unknown here: only the bounded traversal may inspect them.
const nodeSchemas = {
    empty: Type.Object({ kind: Type.Literal("empty") }),
    text: Type.Object({ kind: Type.Literal("text"), text: Type.Unknown() }),
    summary: Type.Object({ kind: Type.Literal("summary"), rows: Type.Unknown() }),
    code: Type.Object({
        kind: Type.Literal("code"),
        text: Type.String(),
        title: Type.Optional(Type.Unknown()),
        syntax: Type.Optional(Type.Unknown()),
        preview: Type.Optional(Type.Unknown()),
    }),
    list: Type.Object({
        kind: Type.Literal("list"),
        items: Type.Unknown(),
        preview: Type.Optional(Type.Unknown()),
    }),
    call: Type.Object({
        kind: Type.Literal("call"),
        labels: Type.Unknown(),
        body: Type.Optional(Type.Unknown()),
        preview: Type.Optional(Type.Unknown()),
    }),
    output: Type.Object({
        kind: Type.Literal("output"),
        text: Type.Optional(Type.String()),
        syntax: Type.Optional(Type.Unknown()),
        preview: Type.Optional(Type.Unknown()),
        noOutputLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    mutation: Type.Object({
        kind: Type.Literal("mutation"),
        labels: Type.Unknown(),
        files: Type.Unknown(),
        patch: Type.Optional(Type.String()),
    }),
    stack: Type.Object({ kind: Type.Literal("stack"), children: Type.Unknown() }),
};
const summaryRowSchema = Type.Object({ label: Type.Unknown(), value: Type.Unknown() });
const mutationFileSchema = Type.Object({
    path: Type.String({ minLength: 1 }),
    previousPath: Type.Optional(Type.String({ minLength: 1 })),
    lines: Type.Unknown(),
    added: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    removed: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    countsKnown: Type.Optional(Type.Boolean()),
});

type DecodeState = {
    readonly limits: GlowupNodeDecodeLimits;
    readonly active: WeakSet<object>;
    readonly fields: WeakMap<object, Map<string, unknown>>;
    nodes: number;
    textCharacters: number;
};

function reject(): never {
    // Translated to the public undefined failure channel at the boundary below.
    throw new Error("Invalid or over-budget Glowup node");
}

function countText(state: DecodeState, value: string): void {
    state.textCharacters += value.length;
    if (state.textCharacters > state.limits.maxTextCharacters) reject();
}

// oxlint-disable-next-line antislop/no-unknown-parameters, antislop/no-unknown-returns -- readField is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
function readField(value: unknown, key: string, state: DecodeState): unknown {
    if (!Guard.IsObject(value)) return reject();
    let fields = state.fields.get(value);
    if (fields === undefined) {
        fields = new Map();
        state.fields.set(value, fields);
    }
    if (!fields.has(key)) fields.set(key, value[key]);
    return fields.get(key);
}

function capture<Properties extends TProperties>(
    schema: TObject<Properties>,
    // oxlint-disable-next-line antislop/no-unknown-parameters -- capture is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
    value: unknown,
    state: DecodeState,
    textFields: readonly string[] = [],
): Static<TObject<Properties>> {
    if (!Guard.IsObjectNotArray(value)) return reject();
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(schema.properties)) {
        const field = readField(value, key, state);
        if (textFields.includes(key) && Value.Check(stringSchema, field)) countText(state, field);
        // Omit undefined optional fields, preserving exact optional public types.
        if (field !== undefined) entries.push([key, field]);
    }
    const captured: unknown = Object.fromEntries(entries);
    if (!Value.Check(schema, captured)) return reject();
    return captured;
}

// oxlint-disable-next-line antislop/no-unknown-parameters -- collection is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
function collection(value: unknown, maximum: number, state: DecodeState) {
    if (!Guard.IsArray(value)) return reject();
    const length = readField(value, "length", state);
    if (!Value.Check(collectionLengthSchema, length) || length > maximum) return reject();
    // Never invoke a producer iterator or copy an array before checking its length.
    return { values: value, length };
}

// oxlint-disable-next-line antislop/no-unknown-parameters -- decodeInline is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
function decodeInline(value: unknown, state: DecodeState): GlowupInline {
    if (Value.Check(stringSchema, value)) {
        countText(state, value);
        return value;
    }
    return capture(inlineObjectSchema, value, state, ["text"]);
}

// oxlint-disable-next-line antislop/no-unknown-parameters -- decodePreview is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
function decodePreview(value: unknown, state: DecodeState): GlowupPreview {
    const preview = capture(previewSchema, value, state);
    if (preview.collapsedLines !== undefined)
        preview.collapsedLines = Math.trunc(preview.collapsedLines);
    if (preview.expandedLines !== undefined)
        preview.expandedLines = Math.trunc(preview.expandedLines);
    return preview;
}

function decodeListItem(
    // oxlint-disable-next-line antislop/no-unknown-parameters -- decodeListItem is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
    value: unknown,
    state: DecodeState,
    depth: number,
): GlowupInline | GlowupNode {
    if (Value.Check(stringSchema, value)) return decodeInline(value, state);
    // A text node contains an inline; a styled inline contains a string. Capture the
    // discriminator and text once even when this falls through to node decoding.
    if (
        readField(value, "kind", state) === "text" &&
        Value.Check(stringSchema, readField(value, "text", state))
    ) {
        return decodeInline(value, state);
    }
    return decodeNode(value, state, depth);
}

// oxlint-disable-next-line antislop/no-unknown-parameters -- decodeNode is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
function decodeNode(value: unknown, state: DecodeState, depth: number): GlowupNode {
    if (depth > state.limits.maxDepth || ++state.nodes > state.limits.maxNodes) return reject();
    if (!Guard.IsObjectNotArray(value) || state.active.has(value)) return reject();
    state.active.add(value);
    try {
        return decodeVariant(value, state, depth);
    } finally {
        state.active.delete(value);
    }
}

// oxlint-disable-next-line antislop/no-unknown-parameters -- decodeVariant is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
function decodeVariant(value: unknown, state: DecodeState, depth: number): GlowupNode {
    switch (readField(value, "kind", state)) {
        case "empty":
            return capture(nodeSchemas.empty, value, state);
        case "text": {
            const node = capture(nodeSchemas.text, value, state);
            return { kind: "text", text: decodeInline(node.text, state) };
        }
        case "summary": {
            const node = capture(nodeSchemas.summary, value, state);
            const { values, length } = collection(
                node.rows,
                state.limits.maxCollectionItems,
                state,
            );
            const rows = [];
            for (let index = 0; index < length; index++) {
                const row = capture(
                    summaryRowSchema,
                    readField(values, String(index), state),
                    state,
                );
                rows.push({
                    label: decodeInline(row.label, state),
                    value: decodeInline(row.value, state),
                });
            }
            return { kind: "summary", rows };
        }
        case "code": {
            const source = capture(nodeSchemas.code, value, state, ["text"]);
            let node: GlowupCodeNode = { kind: "code", text: source.text };
            if (source.title !== undefined)
                node = { ...node, title: decodeInline(source.title, state) };
            if (source.syntax !== undefined)
                node = {
                    ...node,
                    syntax: capture(syntaxSchema, source.syntax, state, ["language", "path"]),
                };
            if (source.preview !== undefined)
                node = { ...node, preview: decodePreview(source.preview, state) };
            return node;
        }
        case "list": {
            const source = capture(nodeSchemas.list, value, state);
            const { values, length } = collection(
                source.items,
                state.limits.maxCollectionItems,
                state,
            );
            const items: Array<GlowupInline | GlowupNode> = [];
            for (let index = 0; index < length; index++)
                items.push(
                    decodeListItem(readField(values, String(index), state), state, depth + 1),
                );
            let node: GlowupListNode = { kind: "list", items };
            if (source.preview !== undefined)
                node = { ...node, preview: decodePreview(source.preview, state) };
            return node;
        }
        case "call": {
            const source = capture(nodeSchemas.call, value, state);
            let node: GlowupCallNode = {
                kind: "call",
                labels: capture(labelsSchema, source.labels, state, [
                    "static",
                    "running",
                    "completed",
                    "failed",
                ]),
            };
            if (source.body !== undefined)
                node = { ...node, body: decodeNode(source.body, state, depth + 1) };
            if (source.preview !== undefined)
                node = { ...node, preview: decodePreview(source.preview, state) };
            return node;
        }
        case "output": {
            const source = capture(nodeSchemas.output, value, state, ["text", "noOutputLabel"]);
            let node: GlowupOutputNode = { kind: "output" };
            if (source.text !== undefined) node = { ...node, text: source.text };
            if (source.noOutputLabel !== undefined)
                node = { ...node, noOutputLabel: source.noOutputLabel };
            if (source.syntax !== undefined)
                node = {
                    ...node,
                    syntax: capture(syntaxSchema, source.syntax, state, ["language", "path"]),
                };
            if (source.preview !== undefined)
                node = { ...node, preview: decodePreview(source.preview, state) };
            return node;
        }
        case "mutation": {
            const source = capture(nodeSchemas.mutation, value, state, ["patch"]);
            const labels = capture(labelsSchema, source.labels, state, [
                "static",
                "running",
                "completed",
                "failed",
            ]);
            const { values, length } = collection(
                source.files,
                state.limits.maxCollectionItems,
                state,
            );
            if (length === 0) return reject();
            let remaining = state.limits.maxCollectionItems - length;
            const files: GlowupMutationFile[] = [];
            for (let index = 0; index < length; index++) {
                const file = capture(
                    mutationFileSchema,
                    readField(values, String(index), state),
                    state,
                    ["path", "previousPath"],
                );
                const { values: rows, length: rowCount } = collection(file.lines, remaining, state);
                remaining -= rowCount;
                const lines = [];
                for (let row = 0; row < rowCount; row++)
                    lines.push(
                        capture(mutationLineSchema, readField(rows, String(row), state), state, [
                            "text",
                        ]),
                    );
                files.push({ ...file, lines });
            }
            let node: GlowupMutationNode = { kind: "mutation", labels, files };
            if (source.patch !== undefined) node = { ...node, patch: source.patch };
            return node;
        }
        case "stack": {
            const source = capture(nodeSchemas.stack, value, state);
            const { values, length } = collection(
                source.children,
                state.limits.maxCollectionItems,
                state,
            );
            const children: GlowupNode[] = [];
            for (let index = 0; index < length; index++)
                children.push(
                    decodeNode(readField(values, String(index), state), state, depth + 1),
                );
            return { kind: "stack", children };
        }
        default:
            return reject();
    }
}

/** Decodes a bounded, detached semantic snapshot; malformed or over-budget input returns undefined. */
export function decodeGlowupNode(
    // oxlint-disable-next-line antislop/no-unknown-parameters -- decodeGlowupNode is part of the bounded semantic decoder; capture-once, oversized-input, cycle and snapshot-isolation tests cover this untrusted traversal seam.
    value: unknown,
    limits: GlowupNodeDecodeLimits = DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
): GlowupNode | undefined {
    try {
        // Capture limits too: validation and traversal must use the same values.
        const budget = {
            maxDepth: limits.maxDepth,
            maxNodes: limits.maxNodes,
            maxCollectionItems: limits.maxCollectionItems,
            maxTextCharacters: limits.maxTextCharacters,
        };
        if (
            !Number.isSafeInteger(budget.maxDepth) ||
            !Number.isSafeInteger(budget.maxNodes) ||
            !Number.isSafeInteger(budget.maxCollectionItems) ||
            !Number.isSafeInteger(budget.maxTextCharacters) ||
            budget.maxDepth < 0 ||
            budget.maxNodes < 1 ||
            budget.maxCollectionItems < 1 ||
            budget.maxTextCharacters < 1
        )
            return undefined;
        return decodeNode(
            value,
            {
                limits: budget,
                active: new WeakSet(),
                fields: new WeakMap(),
                nodes: 0,
                textCharacters: 0,
            },
            0,
        );
    } catch {
        return undefined;
    }
}
