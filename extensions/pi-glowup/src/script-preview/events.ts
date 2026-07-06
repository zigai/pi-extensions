import { formatScriptInvocation, type ScriptBlockFormatter } from "./formatters.ts";
import { boundedScriptPreview } from "./store.ts";
import { parseScriptInvocation, type ScriptInvocation } from "../rendering/core.ts";

type ScriptPreviewSink = {
    set(toolCallId: string, preview: ScriptInvocation): void;
};

export type FormatScriptPreviewOptions = {
    readonly sink: ScriptPreviewSink;
    readonly toolCallId: string;
    readonly command: string;
    readonly formatter: ScriptBlockFormatter | undefined;
    readonly signal?: AbortSignal;
};

/** Stores the cheap raw script preview for the command currently associated with a tool call. */
export function rememberRawScriptPreview(
    sink: ScriptPreviewSink,
    toolCallId: string,
    command: string,
): void {
    const script = parseScriptInvocation(command);
    if (script === undefined) {
        return;
    }
    sink.set(toolCallId, boundedScriptPreview(script));
}

/** Formats and stores a script preview after the final bash command is known. */
export async function formatAndStoreScriptPreview(
    options: FormatScriptPreviewOptions,
): Promise<void> {
    const script = parseScriptInvocation(options.command);
    if (script === undefined || options.formatter === undefined) {
        return;
    }

    const formattedScript = await formatScriptInvocation(
        script,
        options.formatter,
        options.signal === undefined ? {} : { signal: options.signal },
    );
    if (formattedScript.code !== script.code) {
        options.sink.set(options.toolCallId, boundedScriptPreview(formattedScript));
    }
}

/** Starts best-effort formatter work without blocking Pi tool preflight or result delivery. */
export function scheduleFormattedScriptPreview(options: FormatScriptPreviewOptions): void {
    void formatAndStoreScriptPreview(options).catch(() => {});
}
