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
    readonly isCurrent?: () => boolean;
    readonly invalidate?: () => void;
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
async function formatAndStoreScriptPreview(options: FormatScriptPreviewOptions): Promise<void> {
    const script = parseScriptInvocation(options.command);
    if (options.formatter === undefined || script === undefined) return;
    const formatterOptions = options.signal === undefined ? {} : { signal: options.signal };
    const formattedScript = await formatScriptInvocation(
        script,
        options.formatter,
        formatterOptions,
    );
    if (formattedScript.code !== script.code && (options.isCurrent?.() ?? true)) {
        options.sink.set(options.toolCallId, boundedScriptPreview(formattedScript));
        options.invalidate?.();
    }
}

/** Starts best-effort formatter work without blocking Pi tool preflight or result delivery. */
export function scheduleFormattedScriptPreview(options: FormatScriptPreviewOptions): void {
    void formatAndStoreScriptPreview(options).catch(() => {});
}
