import type { Component } from "@earendil-works/pi-tui";
import type { GlowupRenderTheme } from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type { GlowupRenderContext, GlowupToolResult } from "../tool-rendering/protocol.ts";

export {
    GLOWUP_RENDERING_PROPERTY,
    type GlowupRendering,
    type GlowupRenderingAdapter,
    type GlowupRenderingPreference,
    type GlowupSection,
    type GlowupView,
} from "../tool-rendering/protocol.ts";

/** Matcher used to opt selected third-party tools out of Glowup conversion. */
export type ToolNameMatcher = string | RegExp | ((toolName: string) => boolean);

/** Render context consumed by Glowup's internal third-party renderers. */
export type ThirdPartyToolRenderContext = GlowupRenderContext & {
    readonly lastComponent?: Component | undefined;
    readonly cwd?: string;
    readonly invalidate?: () => void;
    readonly result?: ThirdPartyToolResult | undefined;
};

/** Minimal result shape consumed by Glowup third-party renderers. */
export type ThirdPartyToolResult = GlowupToolResult;

/** Glowup renderer pair for a non-native tool. */
export type ThirdPartyToolRenderer = {
    readonly renderCall: (
        args: unknown,
        theme: GlowupRenderTheme,
        context: ThirdPartyToolRenderContext,
    ) => Component;
    readonly renderResult: (
        result: ThirdPartyToolResult,
        options: { readonly expanded: boolean; readonly isPartial: boolean },
        theme: GlowupRenderTheme,
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
