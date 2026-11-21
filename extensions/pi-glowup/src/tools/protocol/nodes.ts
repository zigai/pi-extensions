import type { GlowupStreaming } from "./streaming.ts";

export type GlowupTone =
    | "default"
    | "muted"
    | "dim"
    | "accent"
    | "success"
    | "error"
    | "path"
    | "url"
    | "code";

export type GlowupInline =
    | string
    | {
          readonly kind: "text";
          readonly text: string;
          readonly tone?: GlowupTone;
          readonly bold?: boolean;
      };

export type GlowupSyntax = {
    readonly language?: string;
    readonly path?: string;
};

export type GlowupPreview = {
    readonly mode?: "head" | "headTail" | "hidden";
    readonly collapsedLines?: number;
    readonly expandedLines?: number;
    readonly expandable?: boolean;
};

export type GlowupCallLabels = {
    readonly static: string;
    readonly running?: string;
    readonly completed?: string;
    readonly failed?: string;
};

export type GlowupTextNode = {
    readonly kind: "text";
    readonly text: GlowupInline;
    readonly parts?: readonly GlowupInline[];
};

export type GlowupSummaryNode = {
    readonly kind: "summary";

    readonly rows: ReadonlyArray<{
        readonly label: GlowupInline;
        readonly value: GlowupInline;
    }>;
};

export type GlowupCodeNode = {
    readonly kind: "code";
    readonly text: string;
    readonly streaming?: GlowupStreaming;
    readonly title?: GlowupInline;
    readonly syntax?: GlowupSyntax;
    readonly preview?: GlowupPreview;
};

export type GlowupListNode = {
    readonly kind: "list";
    readonly items: ReadonlyArray<GlowupInline | GlowupNode>;

    /** Native tree connectors instead of bullets. Defaults to "bullet". */
    readonly style?: "bullet" | "tree";

    readonly preview?: GlowupPreview;
};

export type GlowupCallNode = {
    readonly kind: "call";
    readonly labels: GlowupCallLabels;

    /** Overrides this call's native indicator and failure label, not its children. */
    readonly state?: "running" | "success" | "error" | "muted";

    readonly body?: GlowupNode;
    readonly preview?: GlowupPreview;
};

export type GlowupOutputNode = {
    readonly kind: "output";
    readonly text?: string;
    readonly format?: "markdown";

    /** Generated content opts in; ordinary stdout/log output stays immediate. */
    readonly streaming?: GlowupStreaming;

    readonly syntax?: GlowupSyntax;
    readonly preview?: GlowupPreview;
    readonly noOutputLabel?: string | null;
};

export type GlowupMutationLine = {
    readonly kind: "context" | "addition" | "deletion" | "metadata" | "omission";
    readonly text: string;
    readonly oldLine?: number;
    readonly newLine?: number;
};

export type GlowupMutationFile = {
    readonly path: string;
    readonly previousPath?: string;
    readonly lines: ReadonlyArray<GlowupMutationLine>;

    /** Complete mutation statistics, which may exceed the bounded preview rows. */
    readonly added: number;

    readonly removed: number;

    /** False when a producer cannot determine a deletion's removed-line count. */
    readonly countsKnown?: boolean;
};

export type GlowupMutationNode = {
    readonly kind: "mutation";
    readonly labels: GlowupCallLabels;
    readonly files: ReadonlyArray<GlowupMutationFile>;

    /** Optional complete unified diff used for high-fidelity replay after execution. */
    readonly patch?: string;
};

export type GlowupStackNode = {
    readonly kind: "stack";
    readonly children: ReadonlyArray<GlowupNode>;
};

export type GlowupEmptyNode = {
    readonly kind: "empty";
};

export type GlowupNode =
    | GlowupCallNode
    | GlowupOutputNode
    | GlowupSummaryNode
    | GlowupCodeNode
    | GlowupListNode
    | GlowupTextNode
    | GlowupMutationNode
    | GlowupStackNode
    | GlowupEmptyNode;

export function text(
    value: GlowupInline,
    options: { readonly parts?: readonly GlowupInline[] } = {},
): GlowupTextNode {
    return {
        kind: "text",
        text: value,
        ...(options.parts !== undefined && { parts: options.parts }),
    };
}

export function summary(
    rows: ReadonlyArray<{ readonly label: GlowupInline; readonly value: GlowupInline }>,
): GlowupSummaryNode {
    return { kind: "summary", rows };
}

export function code(
    value: string,
    options: {
        readonly title?: GlowupInline;
        readonly streaming?: GlowupStreaming;
        readonly syntax?: GlowupSyntax;
        readonly preview?: GlowupPreview;
    } = {},
): GlowupCodeNode {
    let node: GlowupCodeNode = { kind: "code", text: value };
    if (options.streaming !== undefined) node = { ...node, streaming: options.streaming };

    if (options.title !== undefined) {
        node = { ...node, title: options.title };
    }

    if (options.syntax !== undefined) {
        node = { ...node, syntax: options.syntax };
    }

    if (options.preview !== undefined) {
        node = { ...node, preview: options.preview };
    }

    return node;
}

export function list(
    items: ReadonlyArray<GlowupInline | GlowupNode>,
    preview?: GlowupPreview,
    style?: "bullet" | "tree",
): GlowupListNode {
    let node: GlowupListNode = { kind: "list", items };
    if (style !== undefined) node = { ...node, style };

    if (preview !== undefined) {
        node = { ...node, preview };
    }

    return node;
}

export function call(
    labels: GlowupCallLabels,
    options: {
        readonly state?: GlowupCallNode["state"];
        readonly body?: GlowupNode;
        readonly preview?: GlowupPreview;
    } = {},
): GlowupCallNode {
    let node: GlowupCallNode = { kind: "call", labels };
    if (options.state !== undefined) node = { ...node, state: options.state };

    if (options.body !== undefined) {
        node = { ...node, body: options.body };
    }

    if (options.preview !== undefined) {
        node = { ...node, preview: options.preview };
    }

    return node;
}

export function output(
    value: string | undefined,
    options: {
        readonly format?: "markdown";
        readonly streaming?: GlowupStreaming;
        readonly syntax?: GlowupSyntax;
        readonly preview?: GlowupPreview;
        readonly noOutputLabel?: string | null;
    } = {},
): GlowupOutputNode {
    let node: GlowupOutputNode = { kind: "output" };
    if (options.format !== undefined) node = { ...node, format: options.format };
    if (options.streaming !== undefined) node = { ...node, streaming: options.streaming };

    if (value !== undefined) {
        node = { ...node, text: value };
    }

    if (options.syntax !== undefined) {
        node = { ...node, syntax: options.syntax };
    }

    if (options.preview !== undefined) {
        node = { ...node, preview: options.preview };
    }

    if (options.noOutputLabel !== undefined) {
        node = { ...node, noOutputLabel: options.noOutputLabel };
    }

    return node;
}

export function mutation(
    labels: GlowupCallLabels,
    files: ReadonlyArray<GlowupMutationFile>,
    options: { readonly patch?: string } = {},
): GlowupMutationNode {
    let node: GlowupMutationNode = { kind: "mutation", labels, files };
    if (options.patch !== undefined) {
        node = { ...node, patch: options.patch };
    }

    return node;
}

export function stack(children: ReadonlyArray<GlowupNode>): GlowupStackNode {
    return { kind: "stack", children };
}

export function empty(): GlowupEmptyNode {
    return { kind: "empty" };
}
