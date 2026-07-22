import { call, defineGlowupRenderer, empty, text } from "../../glowup/protocol.ts";

type ViewImageGlowupArgs = Readonly<Record<string, unknown>>;

type ViewImageGlowupResult = {
    readonly content?: unknown;
    readonly details?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" ? value : undefined;
}

function parseArgs(value: unknown): ViewImageGlowupArgs | undefined {
    return isRecord(value) ? value : undefined;
}

function parseResult(value: unknown): ViewImageGlowupResult | undefined {
    if (!isRecord(value)) return undefined;
    return {
        ...(value.content === undefined ? {} : { content: value.content }),
        ...(value.details === undefined ? {} : { details: value.details }),
    };
}

function summarizeArgs(args: ViewImageGlowupArgs): string | undefined {
    const path =
        getString(args, "path") ?? getString(args, "file_path") ?? getString(args, "image_path");
    const detail = getString(args, "detail");
    const parts = [
        path === undefined || path.length === 0 ? undefined : path,
        detail === undefined || detail.length === 0 ? undefined : `detail: ${detail}`,
    ].filter((value): value is string => value !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
}

export const viewImageGlowupRendering = defineGlowupRenderer<
    ViewImageGlowupArgs,
    ViewImageGlowupResult
>({
    version: 2,
    parseArgs,
    parseResult,
    renderCall(args) {
        const summary = summarizeArgs(args);
        return call(
            {
                static: "View Image",
                running: "Viewing Image",
                completed: "Viewed Image",
            },
            summary === undefined
                ? {}
                : {
                      body: text({
                          kind: "text",
                          text: summary,
                          tone: "path",
                      }),
                  },
        );
    },
    renderResult(_result, context) {
        return !context.isError && !context.isPartial ? empty() : undefined;
    },
});
