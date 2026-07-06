import type { Component } from "@earendil-works/pi-tui";
import type { CodexRenderTheme } from "../rendering/core.ts";

/** Optional property third-party tools can set to preserve their own renderer. */
export const CODEX_LOOK_RENDERING_PROPERTY = "codexLookRendering";

/** Rendering preference read from third-party tool definitions when present. */
export type CodexLookRenderingPreference = "auto" | "preserve";

/** Matcher used to opt selected third-party tools out of Codex-look conversion. */
export type ToolNameMatcher = string | RegExp | ((toolName: string) => boolean);

/** Minimal render context consumed by Codex-look third-party renderers. */
export type ThirdPartyToolRenderContext = {
    readonly args: unknown;
    readonly toolCallId: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
};

/** Minimal result shape consumed by Codex-look third-party renderers. */
export type ThirdPartyToolResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

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
    readonly createRenderer: (toolName: string) => ThirdPartyToolRenderer;
};

/** Policy for automatic third-party tool renderer conversion. */
export type ThirdPartyToolRenderingOptions = {
    readonly enabled?: boolean;
    readonly preserveTools?: ReadonlyArray<ToolNameMatcher>;
    readonly renderers?: ReadonlyArray<ThirdPartyToolRendererPlugin>;
};
