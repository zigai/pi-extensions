import { createHash } from "node:crypto";
import type { DebugLogFields } from "./logger.ts";

/** Receives render diagnostics; field suppliers run only inside an enabled sink. */
export type RenderDiagnosticSink = (event: string, fields: () => DebugLogFields) => void;
export type ScriptFormatStage =
    | "preview"
    | "embedded-heredoc"
    | "embedded-filter"
    | "statement"
    | "block";
export type ScriptSegmentOrigin = "standalone" | "heredoc" | "file-heredoc" | "inline";

export type ScriptSegmentDiagnostic = {
    readonly language: string;
    readonly origin: ScriptSegmentOrigin;
    readonly start?: number;
    readonly end?: number;
    readonly code: string;
    readonly displayCode?: string;
    readonly formattable: boolean;
    readonly formatted?: boolean;
    readonly skipReason?: string;
};

/** Caller context forwarded with formatter options; never read when diagnostics are off. */
export type ScriptFormatDiagnostics = {
    readonly toolCallId?: string;
    readonly stage?: ScriptFormatStage;

    /** Extracted source before private literal masking, when it differs from formatter input. */
    readonly sourceCode?: string;

    /**
     * Final code of the `script_analysis` segment, or of the whole command on the shell path,
     * this call formats part of; recorded as `segmentHash`. Absent while the source streams.
     */
    readonly segmentCode?: string;
    readonly recordSegment?: (segment: ScriptSegmentDiagnostic) => void;
};

const MAX_DEDUPE_KEYS = 20_000;
const MAX_MEMOIZED_HASHES = 512;
const MAX_STACK_CHARS = 2_000;
let sink: RenderDiagnosticSink | undefined;
let emitted = new Set<string>();
const memoizedHashes = new Map<string, string>();

/** Enables render diagnostics while debugLog is enabled; undefined disables them. */
export function configureRenderDiagnostics(next: RenderDiagnosticSink | undefined): void {
    sink = next;

    if (next === undefined) resetRenderDiagnostics();
}

/** Forgets per-session deduplication so a new session records restored history again. */
export function resetRenderDiagnostics(): void {
    emitted = new Set();
    memoizedHashes.clear();
}

export function renderDiagnosticsEnabled(): boolean {
    return sink !== undefined;
}

/** First 16 hex characters of SHA-256; only call while diagnostics are enabled. */
export function diagnosticCodeHash(code: string): string {
    const memoized = memoizedHashes.get(code);
    if (memoized !== undefined) return memoized;

    const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);

    if (memoizedHashes.size >= MAX_MEMOIZED_HASHES) memoizedHashes.clear();
    memoizedHashes.set(code, hash);

    return hash;
}

export function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/**
 * Records a render event. A dedupe key supplier suppresses repeats within a session;
 * both suppliers are evaluated only while diagnostics are enabled.
 */
export function recordRenderEvent(
    event: string,
    fields: () => DebugLogFields,
    dedupeKey?: () => string,
): void {
    const current = sink;
    if (current === undefined) return;

    if (dedupeKey !== undefined) {
        const key = `${event}\0${dedupeKey()}`;
        if (emitted.has(key)) return;

        if (emitted.size >= MAX_DEDUPE_KEYS) emitted = new Set();
        emitted.add(key);
    }

    current(event, fields);
}

/** Records an exception Glowup swallows; behavior stays unchanged. */
export function recordRenderError(where: string, cause: unknown, toolCallId?: string): void {
    if (sink === undefined) return;

    const message = errorMessage(cause);

    recordRenderEvent(
        "render_error",
        () => ({
            where,
            toolCallId,
            message,
            stack: errorStack(cause),
        }),
        () => `${where}\0${toolCallId ?? ""}\0${message}`,
    );
}

function errorMessage(cause: unknown): string {
    if (cause instanceof Error) return cause.message;
    return String(cause);
}

function errorStack(cause: unknown): string | undefined {
    if (!(cause instanceof Error) || cause.stack === undefined) return undefined;
    return cause.stack.slice(0, MAX_STACK_CHARS);
}

/** Converts an extracted segment into log fields. */
export function scriptSegmentFields(segment: ScriptSegmentDiagnostic): DebugLogFields {
    let displayHash: string | undefined;
    if (segment.displayCode !== undefined && segment.displayCode !== segment.code)
        displayHash = diagnosticCodeHash(segment.displayCode);

    return {
        language: segment.language,
        origin: segment.origin,
        start: segment.start,
        end: segment.end,
        codeHash: diagnosticCodeHash(segment.code),
        displayHash,
        bytes: utf8Bytes(segment.code),
        formattable: segment.formattable,
        formatted: segment.formatted,
        skipReason: segment.skipReason,
    };
}
