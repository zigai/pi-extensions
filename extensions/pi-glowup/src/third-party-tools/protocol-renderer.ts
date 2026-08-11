import type { Component } from "@earendil-works/pi-tui";
import type { MutationSettings } from "../mutations/settings.ts";
import type { GlowupRenderTheme } from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import {
    decodeGlowupNode,
    type GlowupCallContext,
    type GlowupExecutionPhase,
    type GlowupNode,
    type GlowupRenderer,
    type GlowupResultContext,
} from "../tool-rendering/protocol.ts";
import { renderProtocolNode } from "./protocol-node-renderer.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolRenderer } from "./types.ts";

const MAX_MUTATION_CALL_SLOTS = 500;
const mutationCallSlots = new Map<string, ProtocolMutationCallSlot>();

class ProtocolMutationCallSlot implements Component {
    private hidden = false;

    constructor(
        private readonly toolCallId: string,
        private component: Component,
    ) {}

    belongsTo(toolCallId: string): boolean {
        return this.toolCallId === toolCallId;
    }

    innerComponent(): Component {
        return this.component;
    }

    update(component: Component): void {
        this.component = component;
        this.hidden = false;
    }

    hide(): void {
        this.hidden = true;
    }

    render(width: number): string[] {
        return this.hidden ? [] : this.component.render(width);
    }

    invalidate(): void {
        this.component.invalidate();
    }
}

function renderProtocolCallNode(
    node: GlowupNode,
    theme: GlowupRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
    mutationSettings: MutationSettings | undefined,
): Component {
    const previousSlot =
        context.lastComponent instanceof ProtocolMutationCallSlot &&
        context.lastComponent.belongsTo(context.toolCallId)
            ? context.lastComponent
            : undefined;
    const nodeContext =
        previousSlot === undefined
            ? context
            : { ...context, lastComponent: previousSlot.innerComponent() };
    const component = renderProtocolNode(node, theme, nodeContext, labelMode, mutationSettings);
    if (node.kind !== "mutation") return component;

    const slot = previousSlot ?? new ProtocolMutationCallSlot(context.toolCallId, component);
    slot.update(component);
    mutationCallSlots.delete(context.toolCallId);
    mutationCallSlots.set(context.toolCallId, slot);
    while (mutationCallSlots.size > MAX_MUTATION_CALL_SLOTS) {
        const oldest = mutationCallSlots.keys().next().value;
        if (typeof oldest !== "string") break;
        mutationCallSlots.delete(oldest);
    }
    return slot;
}

function hideMutationCallSlot(toolCallId: string): void {
    mutationCallSlots.get(toolCallId)?.hide();
}

type UnknownGlowupRenderer = {
    readonly version: 3;
    readonly parseArgs: (value: unknown) => unknown;
    readonly parseResult?: (value: unknown) => unknown;
    readonly renderPartialCall?: (
        value: unknown,
        context: GlowupCallContext,
    ) => GlowupNode | undefined;
    readonly renderCall?: (args: unknown, context: GlowupCallContext) => GlowupNode | undefined;
    readonly renderResult?: (
        result: unknown,
        context: GlowupResultContext<unknown>,
    ) => GlowupNode | undefined;
};

function publicCallContext(context: ThirdPartyToolRenderContext): GlowupCallContext {
    const phase: GlowupExecutionPhase =
        context.phase ??
        (context.isPartial || context.argsComplete === false
            ? context.executionStarted === true
                ? "running"
                : "pending"
            : "complete");
    return {
        toolName: context.toolName ?? "tool",
        toolCallId: context.toolCallId,
        phase,
        argsComplete: context.argsComplete,
        isPartial: context.isPartial,
        expanded: context.expanded,
        showImages: context.showImages,
        isError: context.isError,
        hasResult: context.result !== undefined,
    };
}

function publicResultContext(
    context: ThirdPartyToolRenderContext,
    args: unknown,
): GlowupResultContext<unknown> {
    return { ...publicCallContext(context), args };
}

function safelyParse(parser: (value: unknown) => unknown, value: unknown): unknown {
    try {
        return parser(value);
    } catch {
        return undefined;
    }
}

function safelyRender(render: () => unknown): GlowupNode | undefined {
    try {
        return decodeGlowupNode(render());
    } catch {
        return undefined;
    }
}

/** Creates a Pi renderer from a validated public Glowup adapter. */
export function createProtocolRenderer(
    adapter: UnknownGlowupRenderer,
    fallback: ThirdPartyToolRenderer,
    labelMode: ToolLabelMode = "static",
    mutationSettings?: MutationSettings,
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            if (context.argsComplete === false && adapter.renderPartialCall !== undefined) {
                const partialNode = safelyRender(() =>
                    adapter.renderPartialCall?.(args, publicCallContext(context)),
                );
                return partialNode === undefined
                    ? fallback.renderCall(args, theme, context)
                    : renderProtocolCallNode(
                          partialNode,
                          theme,
                          context,
                          labelMode,
                          mutationSettings,
                      );
            }
            if (adapter.renderCall === undefined) {
                return fallback.renderCall(args, theme, context);
            }
            const parsedArgs = safelyParse(adapter.parseArgs, args);
            if (parsedArgs === undefined) {
                return fallback.renderCall(args, theme, context);
            }
            const node = safelyRender(() =>
                adapter.renderCall?.(parsedArgs, publicCallContext(context)),
            );
            return node === undefined
                ? fallback.renderCall(args, theme, context)
                : renderProtocolCallNode(node, theme, context, labelMode, mutationSettings);
        },
        renderResult(result, options, theme, context) {
            if (adapter.renderResult === undefined || adapter.parseResult === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            const parsedArgs = safelyParse(adapter.parseArgs, context.args);
            const parsedResult = safelyParse(adapter.parseResult, result);
            if (parsedArgs === undefined || parsedResult === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            const resultContext = { ...context, args: parsedArgs, result };
            const node = safelyRender(() =>
                adapter.renderResult?.(
                    parsedResult,
                    publicResultContext(resultContext, parsedArgs),
                ),
            );
            if (node === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            if (node.kind === "mutation") hideMutationCallSlot(context.toolCallId);
            return renderProtocolNode(node, theme, resultContext, labelMode, mutationSettings);
        },
    };
}

/** Runtime guard for values crossing the tool-definition boundary. */
function isGlowupRenderingAdapter(value: unknown): value is UnknownGlowupRenderer {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    try {
        if (Reflect.get(value, "version") !== 3) return false;
        if (typeof Reflect.get(value, "parseArgs") !== "function") return false;
        const parseResult = Reflect.get(value, "parseResult");
        const renderPartialCall = Reflect.get(value, "renderPartialCall");
        const renderCall = Reflect.get(value, "renderCall");
        const renderResult = Reflect.get(value, "renderResult");
        if (renderPartialCall !== undefined && typeof renderPartialCall !== "function")
            return false;
        if (renderCall !== undefined && typeof renderCall !== "function") return false;
        if (renderResult !== undefined && typeof renderResult !== "function") return false;
        if (typeof renderPartialCall === "function" && typeof renderCall !== "function")
            return false;
        if (typeof renderResult === "function" && typeof parseResult !== "function") return false;
        return typeof renderCall === "function" || typeof renderResult === "function";
    } catch {
        return false;
    }
}

/** Extracts a public adapter from an unknown tool definition. */
export function glowupRenderingAdapter(
    toolDefinition: unknown,
    propertyName = "glowupRendering",
): UnknownGlowupRenderer | undefined {
    if (
        typeof toolDefinition !== "object" ||
        toolDefinition === null ||
        Array.isArray(toolDefinition)
    ) {
        return undefined;
    }
    try {
        const value = Reflect.get(toolDefinition, propertyName);
        return isGlowupRenderingAdapter(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

export type { GlowupRenderer };
