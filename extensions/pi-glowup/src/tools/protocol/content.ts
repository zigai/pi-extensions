import { presentGlowupContent } from "./streaming.ts";
import type { GlowupCodeNode, GlowupOutputNode } from "./nodes.ts";
import type { ThirdPartyToolRenderContext } from "../types.ts";

/** Resolve generated-content identity/completion once for compact, outline and nested layouts. */
export function protocolContent(
    node: GlowupCodeNode | GlowupOutputNode,
    context: ThirdPartyToolRenderContext,
    targetWidth: number,
    nodeKey = context.streamKey ?? "root",
): string {
    const source = node.text ?? "";
    if (node.kind !== "code" && node.streaming === undefined) return source;

    const declaration = node.streaming;
    const input = {
        key: `tool:${context.toolCallId}:${context.streamPhase ?? "call"}:content:${declaration?.key ?? nodeKey}`,
        source,
        complete:
            declaration?.complete ??
            context.contentComplete ??
            (context.argsComplete || context.isError),
        targetWidth,
        ...node.syntax,
        ...(context.invalidate !== undefined && { invalidate: context.invalidate }),
        toolCallId: context.toolCallId,
    };

    if (declaration?.mode === "immediate") return source;

    const kind = declaration?.kind ?? "code";
    if (kind === "code" && context.streamCode !== undefined) return context.streamCode(input);
    return presentGlowupContent({ ...input, kind });
}
