import {
    glowupWireString,
    parseGlowupWireArgs,
    parseGlowupWireResult,
    type GlowupWireCallContext,
    type GlowupWireRecord,
    type GlowupWireResultContext,
    type GlowupWireToolResult,
} from "../../glowup/wire.ts";

type ViewImageGlowupArgs = GlowupWireRecord;
type ViewImageGlowupResult = GlowupWireToolResult;

function summarizeArgs(args: ViewImageGlowupArgs): string | undefined {
    const path =
        glowupWireString(args, "path") ??
        glowupWireString(args, "file_path") ??
        glowupWireString(args, "image_path");
    const detail = glowupWireString(args, "detail");
    const parts = [
        path === undefined || path.length === 0 ? undefined : path,
        detail === undefined || detail.length === 0 ? undefined : `detail: ${detail}`,
    ].filter((value): value is string => value !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
}

function renderViewImageCall(args: ViewImageGlowupArgs) {
    const summary = summarizeArgs(args);
    return {
        kind: "call" as const,
        labels: {
            static: "View Image",
            running: "Viewing Image",
            completed: "Viewed Image",
        },
        ...(summary === undefined
            ? {}
            : {
                  body: {
                      kind: "text",
                      text: {
                          kind: "text",
                          text: summary,
                          tone: "path",
                      },
                  },
              }),
    };
}

export const viewImageGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
    renderPartialCall(value: unknown, _context: GlowupWireCallContext) {
        const args = parseGlowupWireArgs(value);
        return args === undefined
            ? {
                  kind: "call" as const,
                  labels: { static: "View Image", running: "Viewing Image" },
              }
            : renderViewImageCall(args);
    },
    renderCall(args: ViewImageGlowupArgs, _context: GlowupWireCallContext) {
        return renderViewImageCall(args);
    },
    renderResult(
        _result: ViewImageGlowupResult,
        context: GlowupWireResultContext<ViewImageGlowupArgs>,
    ) {
        return !context.isError && !context.isPartial ? ({ kind: "empty" } as const) : undefined;
    },
} as const;
