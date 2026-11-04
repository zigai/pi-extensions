import { call, empty, stack, text, type GlowupRenderer } from "@zigai/pi-glowup/protocol";

import {
    glowupWireTextOutput,
    parseGlowupWireArgs,
    parseGlowupWireResult,
    type GlowupWireCallContext,
    type GlowupWireRecord,
    type GlowupWireToolResult,
} from "../../glowup/wire.ts";
import { WEB_RUN_LABELS, webRunActions, webRunLabels, webRunResultLines } from "./rendering.ts";

function renderWebRunCall(args: GlowupWireRecord, context: GlowupWireCallContext) {
    const actions = webRunActions(args).map((action) =>
        call(webRunLabels(action.labels, context.phase, context.isError), {
            body: text({
                kind: "text",
                text: action.target,
                tone: action.isUrl ? "url" : "accent",
            }),
        }),
    );
    if (actions.length === 0)
        return call(webRunLabels(WEB_RUN_LABELS, context.phase, context.isError));

    const first = actions[0];
    return actions.length === 1 && first !== undefined ? first : stack(actions);
}

export const webRunGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
    renderCall: renderWebRunCall,
    renderResult(result, context) {
        // Let Glowup's error fallback retain the failure text, even when collapsed.
        if (context.isError) return undefined;

        // Undefined means fallback, not hidden: successful collapsed results are explicitly empty.
        if (!context.expanded) return empty();

        return stack(
            webRunResultLines(glowupWireTextOutput(result) ?? "").map((line) =>
                text({
                    kind: "text",
                    text: line.text,
                    bold: line.kind === "title",
                    tone:
                        line.kind === "url"
                            ? "url"
                            : line.kind === "omission"
                              ? "muted"
                              : "default",
                }),
            ),
        );
    },
} satisfies GlowupRenderer<GlowupWireRecord, GlowupWireToolResult>;
