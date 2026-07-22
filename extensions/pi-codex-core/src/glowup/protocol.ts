/**
 * Dependency-free client types for pi-glowup's declarative rendering protocol.
 *
 * Tool definitions carry these plain data objects whether or not Glowup is installed. Keeping this
 * module free of Glowup/Pi imports lets pi-codex-core remain independently installable; protocol
 * version validation at the consumer boundary provides runtime compatibility.
 */

export const GLOWUP_RENDERING_VERSION = 2 as const;

export type GlowupExecutionPhase = "pending" | "running" | "complete";

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

export type GlowupResultContext<Args = unknown> = GlowupCallContext & {
    readonly args: Args;
};

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

export type GlowupPreview = {
    readonly mode?: "head" | "headTail" | "hidden";
    readonly collapsedLines?: number;
    readonly expandedLines?: number;
    readonly expandable?: boolean;
};

export type GlowupTextNode = {
    readonly kind: "text";
    readonly text: GlowupInline;
};

export type GlowupCallNode = {
    readonly kind: "call";
    readonly labels: {
        readonly static: string;
        readonly running?: string;
        readonly completed?: string;
        readonly failed?: string;
    };
    readonly body?: GlowupNode;
    readonly preview?: GlowupPreview;
};

export type GlowupOutputNode = {
    readonly kind: "output";
    readonly text?: string;
    readonly preview?: GlowupPreview;
    readonly noOutputLabel?: string | null;
};

export type GlowupStackNode = {
    readonly kind: "stack";
    readonly children: ReadonlyArray<GlowupNode>;
};

export type GlowupEmptyNode = {
    readonly kind: "empty";
};

export type GlowupNode =
    | GlowupTextNode
    | GlowupCallNode
    | GlowupOutputNode
    | GlowupStackNode
    | GlowupEmptyNode;

export type GlowupRenderer<Args = unknown, Result = unknown> = {
    readonly version: typeof GLOWUP_RENDERING_VERSION;
    readonly parseArgs?: (value: unknown) => Args | undefined;
    readonly parseResult?: (value: unknown) => Result | undefined;
    readonly renderCall?: (args: Args, context: GlowupCallContext) => GlowupNode | undefined;
    readonly renderResult?: (
        result: Result,
        context: GlowupResultContext<Args>,
    ) => GlowupNode | undefined;
};

export type WithGlowupRendering<Definition, Args = unknown, Result = unknown> = Definition & {
    readonly glowupRendering: GlowupRenderer<Args, Result>;
};

export function defineGlowupRenderer<Args, Result>(
    renderer: GlowupRenderer<Args, Result>,
): GlowupRenderer<Args, Result> {
    return renderer;
}

export function text(value: GlowupInline): GlowupTextNode {
    return { kind: "text", text: value };
}

export function call(
    labels: GlowupCallNode["labels"],
    options: { readonly body?: GlowupNode; readonly preview?: GlowupPreview } = {},
): GlowupCallNode {
    return {
        kind: "call",
        labels,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.preview === undefined ? {} : { preview: options.preview }),
    };
}

export function output(
    value: string | undefined,
    options: {
        readonly preview?: GlowupPreview;
        readonly noOutputLabel?: string | null;
    } = {},
): GlowupOutputNode {
    return {
        kind: "output",
        ...(value === undefined ? {} : { text: value }),
        ...(options.preview === undefined ? {} : { preview: options.preview }),
        ...(options.noOutputLabel === undefined ? {} : { noOutputLabel: options.noOutputLabel }),
    };
}

export function stack(children: ReadonlyArray<GlowupNode>): GlowupStackNode {
    return { kind: "stack", children };
}

export function empty(): GlowupEmptyNode {
    return { kind: "empty" };
}
