/** Tool definition property consumed by pi-glowup when installed. */
export const GLOWUP_RENDERING_PROPERTY = "glowupRendering";

/** Simple opt-out or neutral preference for Glowup rendering. */
export type GlowupRenderingPreference = "auto" | "preserve";

/** Minimal tool-call render context exposed to passive Glowup adapters. */
export type GlowupRenderContext = {
    readonly args: unknown;
    readonly toolCallId: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
};

/** Minimal tool result shape exposed to passive Glowup adapters. */
export type GlowupToolResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

/** Compact Glowup call states available to passive adapters. */
export type GlowupCallState = "running" | "success" | "error" | "muted";

/** Output preview strategy for text returned by passive adapters. */
export type GlowupOutputMode = "head" | "headTail" | "hidden";

/** Syntax hint for a rendered text block. */
export type GlowupSyntax = {
    readonly language?: string;
    readonly path?: string;
};

/** Compact tool call view rendered by pi-glowup. */
export type GlowupCallView = {
    readonly kind: "call";
    readonly label: string;
    readonly activeLabel?: string;
    readonly completedLabel?: string;
    readonly body?: string;
    readonly state?: GlowupCallState;
    readonly maxRenderedLines?: number;
    readonly expandable?: boolean;
};

/** Text output view rendered by pi-glowup. */
export type GlowupOutputView = {
    readonly kind: "output";
    readonly text?: string;
    readonly mode?: GlowupOutputMode;
    readonly syntax?: GlowupSyntax;
    readonly maxPreviewLines?: number;
    readonly noOutputLabel?: string | null;
};

/** Section in a structured Glowup view. */
export type GlowupSection =
    | {
          readonly kind: "text";
          readonly text: string;
      }
    | {
          readonly kind: "summary";
          readonly label?: string;
          readonly text: string;
      }
    | {
          readonly kind: "code";
          readonly title?: string;
          readonly text: string;
          readonly syntax?: GlowupSyntax;
      };

/** Structured multi-section view rendered by pi-glowup. */
export type GlowupSectionsView = {
    readonly kind: "sections";
    readonly sections: readonly GlowupSection[];
    readonly maxPreviewLines?: number;
};

/** Intentionally empty Glowup view. */
export type GlowupEmptyView = {
    readonly kind: "empty";
};

/** View model returned by passive Glowup adapters. */
export type GlowupView = GlowupCallView | GlowupOutputView | GlowupSectionsView | GlowupEmptyView;

/** Passive adapter that pi-glowup consumes only when this extension is installed. */
export type GlowupRenderingAdapter<
    Args = unknown,
    Result extends GlowupToolResult = GlowupToolResult,
> = {
    readonly version: 1;
    readonly renderCall?: (args: Args, context: GlowupRenderContext) => GlowupView | undefined;
    readonly renderResult?: (
        result: Result,
        options: { readonly expanded: boolean; readonly isPartial: boolean },
        context: GlowupRenderContext,
    ) => GlowupView | undefined;
};

/** Passive Glowup rendering property accepted on third-party tool definitions. */
export type GlowupRendering<Args = unknown, Result extends GlowupToolResult = GlowupToolResult> =
    | GlowupRenderingPreference
    | GlowupRenderingAdapter<Args, Result>;
