import type { JsonValue } from "../../json-value.js";
import type { GlowupNode } from "./nodes.js";
export {
    type GlowupTone,
    type GlowupInline,
    type GlowupSyntax,
    type GlowupPreview,
    type GlowupCallLabels,
    type GlowupTextNode,
    type GlowupSummaryNode,
    type GlowupCodeNode,
    type GlowupListNode,
    type GlowupCallNode,
    type GlowupOutputNode,
    type GlowupMutationLine,
    type GlowupMutationFile,
    type GlowupMutationNode,
    type GlowupStackNode,
    type GlowupEmptyNode,
    type GlowupNode,
    text,
    summary,
    code,
    list,
    call,
    output,
    mutation,
    stack,
    empty,
} from "./nodes.js";

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
    /** True when the settled or restored call has an associated tool result. */
    readonly hasResult?: boolean;
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

/** Parses a serialized runtime value into an adapter-owned value. */
export type GlowupParser<Value> = (value: JsonValue) => Value | undefined;

type GlowupRendererBase<Args> = {
    readonly version: typeof GLOWUP_RENDERING_VERSION;
    readonly parseArgs: GlowupParser<Args>;
};

type GlowupCallRendering<Args> = {
    /**
     * Optional renderer for incomplete streaming arguments. It receives serialized partial data
     * because the complete argument parser is not expected to accept an unfinished object.
     */
    readonly renderPartialCall?: (
        value: JsonValue,
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
export function defineGlowupRenderer<
    Args = unknown,
    Result = GlowupToolResult,
    const Renderer extends GlowupRenderer<Args, Result> = GlowupRenderer<Args, Result>,
>(renderer: Renderer): Renderer {
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

export {
    decodeGlowupNode,
    DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
    type GlowupNodeDecodeLimits,
} from "./decode.js";
