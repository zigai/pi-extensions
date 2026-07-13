import type { Component } from "@earendil-works/pi-tui";
import type { CodexRenderTheme } from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type { CodexLookRenderContext, CodexLookToolResult } from "../tool-rendering/protocol.ts";

export {
    CODEX_LOOK_RENDERING_PROPERTY,
    type CodexLookRendering,
    type CodexLookRenderingAdapter,
    type CodexLookRenderingPreference,
    type CodexLookSection,
    type CodexLookView,
} from "../tool-rendering/protocol.ts";

/** Matcher used to opt selected third-party tools out of Codex-look conversion. */
export type ToolNameMatcher = string | RegExp | ((toolName: string) => boolean);

/** Render context consumed by Codex-look's internal third-party renderers. */
export type ThirdPartyToolRenderContext = CodexLookRenderContext & {
    readonly lastComponent?: Component | undefined;
    readonly cwd?: string;
    readonly invalidate?: () => void;
    readonly result?: ThirdPartyToolResult | undefined;
};

/** Minimal result shape consumed by Codex-look third-party renderers. */
export type ThirdPartyToolResult = CodexLookToolResult;

/** Codex-look renderer pair for a non-native tool. */
export type ThirdPartyToolRenderer = {
    readonly renderCall: (
        args: unknown,
        theme: CodexRenderTheme,
        context: ThirdPartyToolRenderContext,
    ) => Component;
    readonly renderResult: (
        result: ThirdPartyToolResult,
        options: { readonly expanded: boolean; readonly isPartial: boolean },
        theme: CodexRenderTheme,
        context: ThirdPartyToolRenderContext,
    ) => Component;
};

/** Registry entry for a known third-party tool family. */
export type ThirdPartyToolRendererPlugin = {
    readonly name: string;
    readonly matches: (toolName: string) => boolean;
    readonly createRenderer: (
        toolName: string,
        options?: ThirdPartyToolRenderingOptions,
    ) => ThirdPartyToolRenderer;
};

/** Policy for automatic third-party tool renderer conversion. */
export type ThirdPartyToolRenderingOptions = {
    readonly enabled?: boolean;
    readonly preserveTools?: ReadonlyArray<ToolNameMatcher>;
    readonly renderers?: ReadonlyArray<ThirdPartyToolRendererPlugin>;
    readonly labelMode?: ToolLabelMode;
};
