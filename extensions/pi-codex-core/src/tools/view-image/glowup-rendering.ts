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

function imagePath(args: ViewImageGlowupArgs): string | undefined {
    return (
        glowupWireString(args, "path") ??
        glowupWireString(args, "file_path") ??
        glowupWireString(args, "image_path")
    );
}

function renderViewImageCall(args: ViewImageGlowupArgs) {
    const path = imagePath(args);
    const labels = {
        static: "View Image",
        running: "Viewing Image",
        completed: "Viewed Image",
    };
    return path === undefined || path.length === 0
        ? { kind: "call" as const, labels }
        : {
              kind: "call" as const,
              labels,
              body: {
                  kind: "text" as const,
                  text: { kind: "text" as const, text: path, tone: "path" as const },
              },
          };
}

export const viewImageGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
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
