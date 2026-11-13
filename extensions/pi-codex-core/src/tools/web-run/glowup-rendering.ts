import { call, empty, stack, text, type GlowupRenderer } from "@zigai/pi-glowup/protocol";

import {
    glowupWireTextOutput,
    parseGlowupWireArgs,
    parseGlowupWireResult,
    type GlowupWireCallContext,
    type GlowupWireRecord,
    type GlowupWireToolResult,
} from "../../glowup/wire.ts";
import {
    WEB_RUN_LABELS,
    webRunCallActions,
    webRunLabels,
    webRunReferenceRows,
    webRunResultLines,
    type WebRunReferenceRow,
} from "./rendering.ts";

function renderWebRunCall(args: GlowupWireRecord, context: GlowupWireCallContext) {
    const resultSucceeded = context.hasResult === true && !context.isError;
    const actions = webRunCallActions(args, resultSucceeded).map((action) =>
        call(webRunLabels(action.labels, context.phase, context.isError), {
            body: text({
                kind: "text",
                text: action.target,
                tone: action.isUrl ? "url" : "accent",
            }),
        }),
    );
    if (actions.length === 0 && resultSucceeded) return empty();
    if (actions.length === 0)
        return call(webRunLabels(WEB_RUN_LABELS, context.phase, context.isError));

    const first = actions[0];
    return actions.length === 1 && first !== undefined ? first : stack(actions);
}

function renderReferenceRow(row: WebRunReferenceRow) {
    const target = { kind: "text", text: row.target, tone: row.isUrl ? "url" : "accent" } as const;

    return call(
        { static: row.label },
        {
            state: row.error === undefined ? "success" : "error",
            body:
                row.error === undefined
                    ? text(target)
                    : text(`${row.target} (${row.error})`, {
                          parts: [target, { kind: "text", text: ` (${row.error})`, tone: "muted" }],
                      }),
        },
    );
}

export const webRunGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
    renderCall: renderWebRunCall,
    renderResult(result, context) {
        // Let Glowup's error fallback retain the failure text, even when collapsed.
        if (context.isError) return undefined;

        const rawOutput = glowupWireTextOutput(result) ?? "";
        const references = webRunReferenceRows(context.args, rawOutput).map(renderReferenceRow);

        // Undefined means fallback, not hidden: successful collapsed results are explicitly empty.
        if (!context.expanded) return references.length === 0 ? empty() : stack(references);

        return stack([
            ...references,
            ...webRunResultLines(rawOutput).map((line) =>
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
        ]);
    },
} satisfies GlowupRenderer<GlowupWireRecord, GlowupWireToolResult>;
