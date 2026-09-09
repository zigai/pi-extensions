/** Semantic tones understood by the Glowup style engine. */
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

/** Inline text with optional semantic styling. */
export type GlowupInline =
    | string
    | {
          readonly kind: "text";
          readonly text: string;
          readonly tone?: GlowupTone;
          readonly bold?: boolean;
      };

/** Syntax metadata for code-bearing blocks. */
export type GlowupSyntax = {
    readonly language?: string;
    readonly path?: string;
};

/** Shared collapsed/expanded preview policy. */
export type GlowupPreview = {
    readonly mode?: "head" | "headTail" | "hidden";
    readonly collapsedLines?: number;
    readonly expandedLines?: number;
    readonly expandable?: boolean;
};

/** Lifecycle labels used by a call component. */
export type GlowupCallLabels = {
    readonly static: string;
    readonly running?: string;
    readonly completed?: string;
    readonly failed?: string;
};

/** Plain text component. */
export type GlowupTextNode = {
    readonly kind: "text";
    readonly text: GlowupInline;
};

/** Structured label/value row. */
export type GlowupSummaryNode = {
    readonly kind: "summary";

    readonly rows: ReadonlyArray<{
        readonly label: GlowupInline;
        readonly value: GlowupInline;
    }>;
};

/** Syntax-aware code component. */
export type GlowupCodeNode = {
    readonly kind: "code";
    readonly text: string;
    readonly title?: GlowupInline;
    readonly syntax?: GlowupSyntax;
    readonly preview?: GlowupPreview;
};

/** Bounded list component. */
export type GlowupListNode = {
    readonly kind: "list";
    readonly items: ReadonlyArray<GlowupInline | GlowupNode>;
    readonly preview?: GlowupPreview;
};

/** Tool call component. */
export type GlowupCallNode = {
    readonly kind: "call";
    readonly labels: GlowupCallLabels;
    readonly body?: GlowupNode;
    readonly preview?: GlowupPreview;
};

/** Tool output component. */
export type GlowupOutputNode = {
    readonly kind: "output";
    readonly text?: string;
    readonly syntax?: GlowupSyntax;
    readonly preview?: GlowupPreview;
    readonly noOutputLabel?: string | null;
};

/** One semantic source row in a mutation preview. */
export type GlowupMutationLine = {
    readonly kind: "context" | "addition" | "deletion" | "metadata" | "omission";
    readonly text: string;
    readonly oldLine?: number;
    readonly newLine?: number;
};

/** One file changed by a mutation. */
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

/** Responsive, syntax-aware file mutation component. */
export type GlowupMutationNode = {
    readonly kind: "mutation";
    readonly labels: GlowupCallLabels;
    readonly files: ReadonlyArray<GlowupMutationFile>;

    /** Optional complete unified diff used for high-fidelity replay after execution. */
    readonly patch?: string;
};

/** Ordered component composition. */
export type GlowupStackNode = {
    readonly kind: "stack";
    readonly children: ReadonlyArray<GlowupNode>;
};

/** Intentionally empty component. */
export type GlowupEmptyNode = {
    readonly kind: "empty";
};

/** Declarative component tree understood by pi-glowup. */
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

/** Creates a text component with semantic styling. */
export function text(value: GlowupInline): GlowupTextNode {
    return { kind: "text", text: value };
}

/** Creates a structured summary component. */
export function summary(
    rows: ReadonlyArray<{ readonly label: GlowupInline; readonly value: GlowupInline }>,
): GlowupSummaryNode {
    return { kind: "summary", rows };
}

/** Creates a syntax-aware code component. */
export function code(
    value: string,
    options: {
        readonly title?: GlowupInline;
        readonly syntax?: GlowupSyntax;
        readonly preview?: GlowupPreview;
    } = {},
): GlowupCodeNode {
    let node: GlowupCodeNode = { kind: "code", text: value };
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

/** Creates a bounded list component. */
export function list(
    items: ReadonlyArray<GlowupInline | GlowupNode>,
    preview?: GlowupPreview,
): GlowupListNode {
    let node: GlowupListNode = { kind: "list", items };
    if (preview !== undefined) {
        node = { ...node, preview };
    }

    return node;
}

/** Creates a tool call component. */
export function call(
    labels: GlowupCallLabels,
    options: { readonly body?: GlowupNode; readonly preview?: GlowupPreview } = {},
): GlowupCallNode {
    let node: GlowupCallNode = { kind: "call", labels };
    if (options.body !== undefined) {
        node = { ...node, body: options.body };
    }

    if (options.preview !== undefined) {
        node = { ...node, preview: options.preview };
    }

    return node;
}

/** Creates an output component. */
export function output(
    value: string | undefined,
    options: {
        readonly syntax?: GlowupSyntax;
        readonly preview?: GlowupPreview;
        readonly noOutputLabel?: string | null;
    } = {},
): GlowupOutputNode {
    let node: GlowupOutputNode = { kind: "output" };
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

/** Creates a responsive, syntax-aware file mutation component. */
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

/** Creates an ordered component composition. */
export function stack(children: ReadonlyArray<GlowupNode>): GlowupStackNode {
    return { kind: "stack", children };
}

/** Creates an intentionally empty component. */
export function empty(): GlowupEmptyNode {
    return { kind: "empty" };
}
