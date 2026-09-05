import type { Component } from "@earendil-works/pi-tui";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import type { MutationSettings } from "../mutations/settings.ts";
import type { GlowupRenderTheme } from "../rendering/core.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import {
    decodeGlowupNode,
    type GlowupCallContext,
    type GlowupExecutionPhase,
    type GlowupNode,
    type GlowupRenderer,
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
        const oldest = mutationCallSlots.keys().next();
        if (oldest.done === true) break;
        mutationCallSlots.delete(oldest.value);
    }
    return slot;
}

function hideMutationCallSlot(toolCallId: string): void {
    mutationCallSlots.get(toolCallId)?.hide();
}

const parserSchema = Type.Function([Type.Unknown()], Type.Unknown());
const rendererSchema = Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown());
const renderingAdapterSchema = Type.Object(
    {
        version: Type.Literal(3),
        parseArgs: parserSchema,
        parseResult: Type.Optional(parserSchema),
        renderPartialCall: Type.Optional(rendererSchema),
        renderCall: Type.Optional(rendererSchema),
        renderResult: Type.Optional(rendererSchema),
    },
    { additionalProperties: true },
);
type UnknownGlowupRenderer = Static<typeof renderingAdapterSchema>;

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

function safelyRender(render: () => GlowupNode | undefined): GlowupNode | undefined {
    try {
        return render();
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
                    decodeGlowupNode(adapter.renderPartialCall?.(args, publicCallContext(context))),
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
            const node = safelyRender(() => {
                if (args === undefined) return undefined;
                const parsedArgs = adapter.parseArgs(args);
                return parsedArgs === undefined
                    ? undefined
                    : decodeGlowupNode(
                          adapter.renderCall?.(parsedArgs, publicCallContext(context)),
                      );
            });
            return node === undefined
                ? fallback.renderCall(args, theme, context)
                : renderProtocolCallNode(node, theme, context, labelMode, mutationSettings);
        },
        renderResult(result, options, theme, context) {
            if (adapter.renderResult === undefined || adapter.parseResult === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            const resultContext = { ...context, result };
            const node = safelyRender(() => {
                if (context.args === undefined) return undefined;
                const parsedArgs = adapter.parseArgs(context.args);
                const parsedResult = adapter.parseResult?.(result);
                if (parsedArgs === undefined || parsedResult === undefined) return undefined;
                return decodeGlowupNode(
                    adapter.renderResult?.(parsedResult, {
                        ...publicCallContext(resultContext),
                        args: parsedArgs,
                    }),
                );
            });
            if (node === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            if (node.kind === "mutation") hideMutationCallSlot(context.toolCallId);
            return renderProtocolNode(node, theme, resultContext, labelMode, mutationSettings);
        },
    };
}

const renderingAdapterParser = {
    parse(toolDefinition: unknown, propertyName: string): UnknownGlowupRenderer | undefined {
        const definitionSchema = Type.Object({ [propertyName]: renderingAdapterSchema });
        try {
            if (!Value.Check(definitionSchema, toolDefinition)) return undefined;
            const adapter = Value.Parse(definitionSchema, toolDefinition)[propertyName];
            if (adapter === undefined) return undefined;
            if (adapter.renderPartialCall !== undefined && adapter.renderCall === undefined)
                return undefined;
            if (adapter.renderResult !== undefined && adapter.parseResult === undefined)
                return undefined;
            return adapter.renderCall === undefined && adapter.renderResult === undefined
                ? undefined
                : adapter;
        } catch {
            return undefined;
        }
    },
};

/** Extracts a public adapter from an unknown tool definition. */
export function glowupRenderingAdapter(
    toolDefinition: unknown,
    propertyName = "glowupRendering",
): UnknownGlowupRenderer | undefined {
    return renderingAdapterParser.parse(toolDefinition, propertyName);
}

export type { GlowupRenderer };
