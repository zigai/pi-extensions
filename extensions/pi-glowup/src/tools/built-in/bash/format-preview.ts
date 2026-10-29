import {
    formatScriptInvocation,
    type ScriptBlockFormatter,
    type ScriptBlockFormatterOptions,
} from "./formatter.ts";
import { scriptInvocationFromPrograms, type ScriptInvocation } from "./invocation.ts";
import { extractEmbeddedPrograms, type EmbeddedProgram } from "./embedded-programs.ts";
import {
    recordRenderError,
    type ScriptFormatDiagnostics,
} from "../../../diagnostics/render-events.ts";

type ScriptPreviewSink = {
    get(toolCallId: string): ScriptInvocation | undefined;
    set(toolCallId: string, preview: ScriptInvocation): void;
};

export type FormatScriptPreviewOptions = {
    readonly sink: ScriptPreviewSink;
    readonly toolCallId: string;
    readonly command: string;
    readonly formatter: ScriptBlockFormatter | undefined;
    readonly embeddedFormatting?: boolean;
    readonly programs?: readonly EmbeddedProgram[];
    readonly signal?: AbortSignal;
    readonly targetWidth?: number;
    readonly isCurrent?: () => boolean;
    readonly invalidate?: () => void;
    readonly recordSegment?: ScriptFormatDiagnostics["recordSegment"];
};

/** Source the embedded formatter can rewrite in place inside a Bash command. */
export function hasEmbeddedSource(
    programs: readonly EmbeddedProgram[],
    formatter: ScriptBlockFormatter | undefined,
): boolean {
    return (
        formatter !== undefined &&
        programs.some((program) => !program.incomplete && !program.expandable)
    );
}

export function scriptForPreview(
    command: string,
    formatter: ScriptBlockFormatter | undefined,
    embeddedFormatting = false,
    programs?: readonly EmbeddedProgram[],
): ScriptInvocation | undefined {
    programs ??= extractEmbeddedPrograms(command);

    const script = scriptInvocationFromPrograms(programs);
    if (script !== undefined) return script;

    if (
        formatter?.profileFor?.("bash") === undefined &&
        !(embeddedFormatting && hasEmbeddedSource(programs, formatter))
    )
        return undefined;

    return { label: "Bash", language: "bash", code: command };
}

/** Stores the cheap raw script preview for the command currently associated with a tool call. */
export function rememberRawScriptPreview(
    sink: ScriptPreviewSink,
    toolCallId: string,
    command: string,
    formatter?: ScriptBlockFormatter,
    embeddedFormatting = false,
    programs?: readonly EmbeddedProgram[],
): void {
    const script = scriptForPreview(command, formatter, embeddedFormatting, programs);
    if (script === undefined) {
        return;
    }

    sink.set(toolCallId, script);
}

/** Formats and stores a script preview after the final bash command is known. */
export async function formatAndStoreScriptPreview(
    options: FormatScriptPreviewOptions,
): Promise<boolean> {
    const script = scriptForPreview(
        options.command,
        options.formatter,
        options.embeddedFormatting,
        options.programs,
    );
    if (options.formatter === undefined || script === undefined) return false;

    const formatterOptions: ScriptBlockFormatterOptions = {
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(options.targetWidth !== undefined && { targetWidth: options.targetWidth }),
        diagnostics: {
            toolCallId: options.toolCallId,
            stage: "block",
            segmentCode: script.code,
            ...(options.recordSegment !== undefined && { recordSegment: options.recordSegment }),
        },
    };
    const formattedScript = await formatScriptInvocation(
        script,
        options.formatter,
        formatterOptions,
    );
    const previousCode = options.sink.get(options.toolCallId)?.code ?? script.code;
    if (formattedScript.code !== previousCode && (options.isCurrent?.() ?? true)) {
        options.sink.set(options.toolCallId, formattedScript);
        options.invalidate?.();
    }

    return formattedScript !== script;
}

/** Starts best-effort formatter work without blocking Pi tool preflight or result delivery. */
export function scheduleFormattedScriptPreview(options: FormatScriptPreviewOptions): void {
    void formatAndStoreScriptPreview(options).catch((cause: unknown) => {
        recordRenderError("bash.format-preview", cause, options.toolCallId);
    });
}
