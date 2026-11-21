import type { Component } from "@earendil-works/pi-tui";
import type { JsonValue } from "../json-value.ts";
import type { GlowupRenderTheme } from "../rendering/theme.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type { MutationSettings } from "../rendering/preview-settings.ts";
import type { CodePreview, CodeSource } from "../rendering/streaming/presentation.ts";
import type {
    GlowupCallContext,
    GlowupExecutionPhase,
    GlowupToolResult,
} from "./protocol/contract.ts";

export type ToolNameMatcher =
    | { readonly kind: "pattern"; readonly pattern: RegExp }
    | { readonly kind: "predicate"; readonly matches: (toolName: string) => boolean };

/** Internal context translated from Pi's ToolExecutionComponent. */
export type ThirdPartyToolRenderContext = Omit<GlowupCallContext, "toolName" | "phase"> & {
    readonly toolName?: string;
    readonly streamCode?: CodePreview;
    readonly streamKey?: string;
    readonly streamPhase?: "call" | "result";
    readonly renderProbe?: boolean;
    readonly contentComplete?: boolean;
    readonly phase?: GlowupExecutionPhase;
    readonly args: JsonValue | undefined;
    readonly executionStarted?: boolean;
    readonly state?: unknown;
    readonly cwd?: string;
    readonly invalidate?: () => void;
    readonly lastComponent?: Component | undefined;
    readonly result?: ThirdPartyToolResult | undefined;
};

export type ThirdPartyToolResult = GlowupToolResult;

export type ThirdPartyToolRenderer = {
    readonly codeSource?: (
        args: JsonValue | undefined,
        context: ThirdPartyToolRenderContext,
    ) => CodeSource | undefined;

    readonly renderCall: (
        args: JsonValue | undefined,
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

export type ThirdPartyToolRendererPlugin = {
    readonly name: string;
    readonly matches: (toolName: string) => boolean;

    readonly createRenderer: (
        toolName: string,
        options?: ThirdPartyToolRenderingOptions,
    ) => ThirdPartyToolRenderer;
};

export type ThirdPartyToolRenderingOptions = {
    readonly enabled?: boolean;
    readonly isStreamingCall?: (toolCallId: string) => boolean;

    /** Exact full or base tool names, also supported by JSON configuration. */
    readonly preserveTools?: ReadonlyArray<string>;

    /** Programmatic policies, evaluated after exact-name preservation. */
    readonly preserveMatchers?: ReadonlyArray<ToolNameMatcher>;

    readonly renderers?: ReadonlyArray<ThirdPartyToolRendererPlugin>;
    readonly labelMode?: ToolLabelMode;
    readonly mutationSettings?: MutationSettings;
    readonly streamCode?: CodePreview;

    readonly codemodePreview?: {
        get(
            toolCallId: string,
            source: string,
            options?: {
                readonly contentWidth: number;
                readonly completed: boolean;
                readonly expanded: boolean;
            },
        ): string | undefined;

        observe(
            toolCallId: string,
            invalidate: (() => void) | undefined,
            completed?: boolean,
        ): (() => void) | undefined;
    };
};

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
