import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type {
    Theme,
    ToolExecutionComponent,
    ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { ThirdPartyToolResult } from "../types.ts";
import type { BuiltInToolName } from "./names.ts";
import { type DiffRenderLimits } from "../../rendering/diff/payload.ts";
import { isActiveToolCall, type ToolLabelMode } from "../../rendering/status-labels.ts";
import { type MutationSettings } from "../../rendering/preview-settings.ts";

// Pi accepts both full ToolDefinitions and bare renderer pairs. Derive the row's
// definition from that constructor contract, including its optional shell mode.
export type PiRendererDefinition = Pick<
    NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>,
    "renderCall" | "renderResult" | "renderShell"
>;

export type ToolExecutionInstance = {
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly toolDefinition?: PiRendererDefinition;
    readonly executionStarted?: boolean;
    readonly argsComplete?: boolean;
    readonly result?: ThirdPartyToolResult;
};

export type PiToolRenderContext = {
    readonly args: unknown;
    readonly toolCallId: string;
    readonly executionStarted: boolean;
    readonly argsComplete: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly showImages: boolean;
    readonly isError: boolean;
    readonly cwd?: string;
    readonly invalidate?: (() => void) | undefined;
    readonly lastComponent?: Component | undefined;
    readonly result?: ThirdPartyToolResult | undefined;
};

type SdkToolRenderContext = Parameters<NonNullable<PiRendererDefinition["renderCall"]>>[2];

// The SDK deliberately leaves args/state untyped for schema-specific renderers.
// Glowup treats those two fields as opaque until its own parsers inspect them.
export type BuiltInToolRenderContext = Omit<SdkToolRenderContext, "args" | "state"> & {
    readonly args: unknown;
    readonly state: unknown;
} & Pick<PiToolRenderContext, "result">;

export type ToolCallArguments = PiToolRenderContext["args"];

export type BuiltInToolRendererOptions = {
    /** Called before renderer selection, including preserved and generic fallback rows. */
    readonly observeRow?: (
        row: ToolExecutionInstance,
        toolCallId: string,
        toolName: string,
    ) => void;

    readonly renderCall: (
        toolName: BuiltInToolName,
        args: ToolCallArguments,
        theme: Theme,
        context: BuiltInToolRenderContext,
    ) => Component | undefined;

    readonly renderResult: (
        toolName: BuiltInToolName,
        result: ThirdPartyToolResult,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: BuiltInToolRenderContext,
    ) => Component | undefined;
};

export type TextResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

export type BuiltInRenderTheme = Parameters<BuiltInToolRendererOptions["renderCall"]>[2];
export type BuiltInRenderContext = Parameters<BuiltInToolRendererOptions["renderCall"]>[3];
export type BuiltInResultOptions = Parameters<BuiltInToolRendererOptions["renderResult"]>[2];

const MUTATION_LABEL_COLUMN_WIDTH = "Writing".length;
const ACTIVE_MUTATION_ALIGNMENT_KEY = "glowupActiveMutationAlignment";
const MUTATION_RESULT_RENDERED_KEY = "glowupMutationResultRendered";

const mutableRenderStateSchema = Type.Object(
    {
        [ACTIVE_MUTATION_ALIGNMENT_KEY]: Type.Optional(Type.Boolean()),
        [MUTATION_RESULT_RENDERED_KEY]: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: true },
);

type MutableRenderState = Static<typeof mutableRenderStateSchema>;

const mutableRenderStateParser = {
    parse(value: unknown): MutableRenderState | undefined {
        try {
            return Value.Parse(mutableRenderStateSchema, value);
        } catch {
            return undefined;
        }
    },
};

export function mutationLabelColumnWidth(
    context: BuiltInRenderContext,
    labelMode: ToolLabelMode,
): number | undefined {
    if (labelMode !== "lifecycle") {
        return undefined;
    }

    const state = mutableRenderStateParser.parse(context.state);
    if (state === undefined) {
        return undefined;
    }

    if (context.isPartial) {
        state[ACTIVE_MUTATION_ALIGNMENT_KEY] = true;
        state[MUTATION_RESULT_RENDERED_KEY] = false;
    }

    if (
        state[ACTIVE_MUTATION_ALIGNMENT_KEY] === true &&
        state[MUTATION_RESULT_RENDERED_KEY] !== true
    ) {
        return MUTATION_LABEL_COLUMN_WIDTH;
    }

    return undefined;
}

export function markMutationResultRendered(context: BuiltInRenderContext): void {
    const state = mutableRenderStateParser.parse(context.state);
    if (state === undefined) {
        return;
    }

    const hadActiveMutationLayout = state[ACTIVE_MUTATION_ALIGNMENT_KEY] === true;
    if (!hadActiveMutationLayout) return;

    if (state[MUTATION_RESULT_RENDERED_KEY] !== true) {
        state[MUTATION_RESULT_RENDERED_KEY] = true;
        queueMicrotask(context.invalidate);
    }
}

export function diffRenderLimits(settings: MutationSettings): DiffRenderLimits {
    return {
        maxBytes: settings.limits.maxDiffBytes,
        maxLines: settings.limits.maxDiffLines,
    };
}

export function trimOldestMapEntries<T>(entries: Map<string, T>, limit: number): void {
    while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) return;
        entries.delete(oldest);
    }
}

export function callState(context: BuiltInRenderContext) {
    return context.isError ? "error" : isActiveToolCall(context) ? "running" : "success";
}
