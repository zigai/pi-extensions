/** Tool definition property consumed by pi-codex-look when installed. */
export const CODEX_LOOK_RENDERING_PROPERTY = "codexLookRendering";

/** Simple opt-out or neutral preference for Codex-look rendering. */
export type CodexLookRenderingPreference = "auto" | "preserve";

/** Minimal tool-call render context exposed to passive Codex-look adapters. */
export type CodexLookRenderContext = {
    readonly args: unknown;
    readonly toolCallId: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
};

/** Minimal tool result shape exposed to passive Codex-look adapters. */
export type CodexLookToolResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

/** Compact Codex-look call states available to passive adapters. */
export type CodexLookCallState = "running" | "success" | "error" | "muted";

/** Output preview strategy for text returned by passive adapters. */
export type CodexLookOutputMode = "head" | "headTail" | "hidden";

/** Syntax hint for a rendered text block. */
export type CodexLookSyntax = {
    readonly language?: string;
    readonly path?: string;
};

/** Compact tool call view rendered by pi-codex-look. */
export type CodexLookCallView = {
    readonly kind: "call";
    readonly label: string;
    readonly activeLabel?: string;
    readonly completedLabel?: string;
    readonly body?: string;
    readonly state?: CodexLookCallState;
    readonly maxRenderedLines?: number;
    readonly expandable?: boolean;
};

/** Text output view rendered by pi-codex-look. */
export type CodexLookOutputView = {
    readonly kind: "output";
    readonly text?: string;
    readonly mode?: CodexLookOutputMode;
    readonly syntax?: CodexLookSyntax;
    readonly maxPreviewLines?: number;
    readonly noOutputLabel?: string | null;
};

/** Section in a structured Codex-look view. */
export type CodexLookSection =
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
          readonly syntax?: CodexLookSyntax;
      };

/** Structured multi-section view rendered by pi-codex-look. */
export type CodexLookSectionsView = {
    readonly kind: "sections";
    readonly sections: readonly CodexLookSection[];
    readonly maxPreviewLines?: number;
};

/** Intentionally empty Codex-look view. */
export type CodexLookEmptyView = {
    readonly kind: "empty";
};

/** View model returned by passive Codex-look adapters. */
export type CodexLookView =
    | CodexLookCallView
    | CodexLookOutputView
    | CodexLookSectionsView
    | CodexLookEmptyView;

/** Passive adapter that pi-codex-look consumes only when this extension is installed. */
export type CodexLookRenderingAdapter<
    Args = unknown,
    Result extends CodexLookToolResult = CodexLookToolResult,
> = {
    readonly version: 1;
    readonly renderCall?: (
        args: Args,
        context: CodexLookRenderContext,
    ) => CodexLookView | undefined;
    readonly renderResult?: (
        result: Result,
        options: { readonly expanded: boolean; readonly isPartial: boolean },
        context: CodexLookRenderContext,
    ) => CodexLookView | undefined;
};

/** Passive Codex-look rendering property accepted on third-party tool definitions. */
export type CodexLookRendering<
    Args = unknown,
    Result extends CodexLookToolResult = CodexLookToolResult,
> = CodexLookRenderingPreference | CodexLookRenderingAdapter<Args, Result>;
