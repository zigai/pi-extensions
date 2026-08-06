/** Property read from a Pi tool definition when Glowup is installed. */
export const GLOWUP_RENDERING_PROPERTY = "glowupRendering" as const;

/** Protocol version implemented by this package. */
export const GLOWUP_RENDERING_VERSION = 3 as const;

/** Explicit request to keep a tool's own Pi renderer. Omission means automatic selection. */
export type GlowupRenderingPreference = "preserve";

/** Execution phase used by declarative Glowup renderers. */
export type GlowupExecutionPhase = "pending" | "running" | "complete";

/** Context available while rendering a tool call. */
export type GlowupCallContext = {
    readonly toolName: string;
    readonly toolCallId: string;
    readonly phase: GlowupExecutionPhase;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
};

/** Context available while rendering a tool result. */
export type GlowupResultContext<Args = unknown> = GlowupCallContext & {
    /** Original call arguments, parsed by the adapter when it provides a parser. */
    readonly args: Args;
};

/** Minimal result shape used by the generic renderer. */
export type GlowupToolResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

/** Parses an unknown runtime value into an adapter-owned value. */
export type GlowupParser<Value> = (value: unknown) => Value | undefined;

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
    | GlowupStackNode
    | GlowupEmptyNode;

type GlowupRendererBase<Args> = {
    readonly version: typeof GLOWUP_RENDERING_VERSION;
    readonly parseArgs: GlowupParser<Args>;
};

type GlowupCallRendering<Args> = {
    /**
     * Optional renderer for incomplete streaming arguments. It receives the raw value because the
     * complete argument parser is not expected to accept an unfinished object.
     */
    readonly renderPartialCall?: (
        value: unknown,
        context: GlowupCallContext,
    ) => GlowupNode | undefined;
    readonly renderCall: (args: Args, context: GlowupCallContext) => GlowupNode | undefined;
};

type GlowupCallRenderer<Args> = GlowupRendererBase<Args> &
    GlowupCallRendering<Args> & {
        readonly parseResult?: never;
        readonly renderResult?: never;
    };

type GlowupResultRenderer<Args, Result> = GlowupRendererBase<Args> & {
    readonly renderCall?: never;
    readonly parseResult: GlowupParser<Result>;
    readonly renderResult: (
        result: Result,
        context: GlowupResultContext<Args>,
    ) => GlowupNode | undefined;
};

type GlowupCallAndResultRenderer<Args, Result> = GlowupRendererBase<Args> &
    GlowupCallRendering<Args> & {
        readonly parseResult: GlowupParser<Result>;
        readonly renderResult: (
            result: Result,
            context: GlowupResultContext<Args>,
        ) => GlowupNode | undefined;
    };

/** Public rendering adapter implemented by a tool owner. */
export type GlowupRenderer<Args = unknown, Result = GlowupToolResult> =
    | GlowupCallRenderer<Args>
    | GlowupResultRenderer<Args, Result>
    | GlowupCallAndResultRenderer<Args, Result>;

/** Rendering property accepted on a Pi tool definition. */
export type GlowupRendering<Args = unknown, Result = GlowupToolResult> =
    | GlowupRenderingPreference
    | GlowupRenderer<Args, Result>;

/** Defines an immutable, versioned rendering adapter for a tool owner. */
export function defineGlowupRenderer<Args = unknown, Result = GlowupToolResult>(
    renderer: GlowupRenderer<Args, Result>,
): GlowupRenderer<Args, Result> {
    return renderer;
}

/** Tool definition carrying passive Glowup rendering metadata. */
export type ToolWithGlowupRendering<
    Definition extends object,
    Args = unknown,
    Result = GlowupToolResult,
> = Definition & {
    readonly glowupRendering: GlowupRendering<Args, Result>;
};

/** Attaches Glowup rendering metadata while preserving the complete tool-definition type. */
export function withGlowupRendering<
    Definition extends object,
    Args = unknown,
    Result = GlowupToolResult,
>(
    definition: Definition,
    rendering: GlowupRendering<Args, Result>,
): ToolWithGlowupRendering<Definition, Args, Result> {
    return { ...definition, [GLOWUP_RENDERING_PROPERTY]: rendering };
}

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
    return {
        kind: "code",
        text: value,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.syntax === undefined ? {} : { syntax: options.syntax }),
        ...(options.preview === undefined ? {} : { preview: options.preview }),
    };
}

/** Creates a bounded list component. */
export function list(
    items: ReadonlyArray<GlowupInline | GlowupNode>,
    preview?: GlowupPreview,
): GlowupListNode {
    return {
        kind: "list",
        items,
        ...(preview === undefined ? {} : { preview }),
    };
}

/** Creates a tool call component. */
export function call(
    labels: GlowupCallLabels,
    options: { readonly body?: GlowupNode; readonly preview?: GlowupPreview } = {},
): GlowupCallNode {
    return {
        kind: "call",
        labels,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.preview === undefined ? {} : { preview: options.preview }),
    };
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
    return {
        kind: "output",
        ...(value === undefined ? {} : { text: value }),
        ...(options.syntax === undefined ? {} : { syntax: options.syntax }),
        ...(options.preview === undefined ? {} : { preview: options.preview }),
        ...(options.noOutputLabel === undefined ? {} : { noOutputLabel: options.noOutputLabel }),
    };
}

/** Creates an ordered component composition. */
export function stack(children: ReadonlyArray<GlowupNode>): GlowupStackNode {
    return { kind: "stack", children };
}

/** Creates an intentionally empty component. */
export function empty(): GlowupEmptyNode {
    return { kind: "empty" };
}

export {
    decodeGlowupNode,
    DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
    type GlowupNodeDecodeLimits,
} from "./decode-node.ts";
