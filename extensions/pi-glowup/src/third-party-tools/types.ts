import type { Component } from "@earendil-works/pi-tui";
import type { GlowupRenderTheme } from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type { MutationSettings } from "../mutations/settings.ts";
import type {
    GlowupCallContext,
    GlowupExecutionPhase,
    GlowupToolResult,
} from "../tool-rendering/protocol.ts";

/** Matcher used to preserve selected tools' original Pi renderers. */
export type ToolNameMatcher = string | RegExp | ((toolName: string) => boolean);

/** Internal context translated from Pi's ToolExecutionComponent. */
export type ThirdPartyToolRenderContext = Omit<GlowupCallContext, "toolName" | "phase"> & {
    readonly toolName?: string;
    readonly phase?: GlowupExecutionPhase;
    readonly args: unknown;
    readonly executionStarted?: boolean;
    readonly cwd?: string;
    readonly invalidate?: () => void;
    readonly lastComponent?: Component | undefined;
    readonly result?: ThirdPartyToolResult | undefined;
};

/** Internal result shape used by the generic renderer. */
export type ThirdPartyToolResult = GlowupToolResult;

/** Pi-facing renderer produced by the private Glowup rendering engine. */
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

/** Registry entry for a transitional renderer that has not moved to its owning package yet. */
export type ThirdPartyToolRendererPlugin = {
    readonly name: string;
    readonly matches: (toolName: string) => boolean;
    readonly createRenderer: (
        toolName: string,
        options?: ThirdPartyToolRenderingOptions,
    ) => ThirdPartyToolRenderer;
};

/** Policy for third-party and generic compatibility rendering. */
export type ThirdPartyToolRenderingOptions = {
    readonly enabled?: boolean;
    readonly preserveTools?: ReadonlyArray<ToolNameMatcher>;
    readonly renderers?: ReadonlyArray<ThirdPartyToolRendererPlugin>;
    readonly labelMode?: ToolLabelMode;
    readonly mutationSettings?: MutationSettings;
};

/** Builds a public-compatible execution context for internal renderers. */
export function executionPhase(context: {
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
}): GlowupExecutionPhase {
    if (context.isPartial || !context.argsComplete) {
        return context.executionStarted ? "running" : "pending";
    }
    return "complete";
}
