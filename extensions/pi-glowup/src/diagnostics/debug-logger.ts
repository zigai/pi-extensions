import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { GlowupConfig, ConfigWarningReporter } from "../config/config.ts";

export type DebugLogValue =
    | string
    | number
    | boolean
    | null
    | readonly DebugLogValue[]
    | { readonly [key: string]: DebugLogValue | undefined };

export interface DebugLogFields {
    readonly [key: string]: DebugLogValue | undefined;
}

type DebugLogFieldsSupplier = () => DebugLogFields;

type DebugLogConfig = GlowupConfig["debugLog"];

type ResolvedDebugLogConfig = {
    readonly filePath: string;
    readonly maxBytes: number | null;
    readonly memorySampleIntervalMs: number;
};

type DebugFileLoggerOptions = {
    readonly extensionDirectory: string;
    readonly reportWarning: ConfigWarningReporter;
};

/** Writes JSONL diagnostics directly to disk so logging cannot accumulate in memory. */
export class DebugFileLogger {
    private readonly extensionDirectory: string;
    private readonly reportWarning: ConfigWarningReporter;
    private config: ResolvedDebugLogConfig | undefined;
    private memorySampleTimer: ReturnType<typeof setInterval> | undefined;
    private memorySnapshotFields: (() => DebugLogFields) | undefined;
    private writeFailureReported = false;

    constructor(options: DebugFileLoggerOptions) {
        this.extensionDirectory = options.extensionDirectory;
        this.reportWarning = options.reportWarning;
    }

    configure(config: DebugLogConfig): void {
        this.clearMemorySampleTimer();
        this.writeFailureReported = false;
        this.config = config.enabled
            ? {
                  filePath: resolveDebugLogPath(this.extensionDirectory, config.path),
                  maxBytes: config.maxBytes,
                  memorySampleIntervalMs: config.memorySampleIntervalMs,
              }
            : undefined;
        this.restartMemorySampleTimer();
    }

    /** Records diagnostics, evaluating field suppliers only while logging is enabled. */
    record(event: string, fields: DebugLogFields | DebugLogFieldsSupplier = {}): void {
        const config = this.config;
        if (config === undefined) {
            return;
        }

        const resolvedFields = fields instanceof Function ? fields() : fields;

        const line = `${JSON.stringify({
            timestamp: new Date().toISOString(),
            pid: process.pid,
            uptimeMs: Math.round(process.uptime() * 1000),
            event,
            fields: compactFields(resolvedFields),
        })}\n`;

        try {
            mkdirSync(dirname(config.filePath), { recursive: true });
            rotateDebugLogIfNeeded(config.filePath, config.maxBytes, Buffer.byteLength(line));
            appendFileSync(config.filePath, line, "utf8");
        } catch (cause: unknown) {
            this.reportWriteFailure(config.filePath, cause);
        }
    }

    startMemorySampling(snapshotFields: () => DebugLogFields): void {
        this.memorySnapshotFields = snapshotFields;
        this.restartMemorySampleTimer();
    }

    stopMemorySampling(): void {
        this.memorySnapshotFields = undefined;
        this.clearMemorySampleTimer();
    }

    private restartMemorySampleTimer(): void {
        this.clearMemorySampleTimer();
        const config = this.config;
        if (
            config === undefined ||
            this.memorySnapshotFields === undefined ||
            config.memorySampleIntervalMs <= 0
        ) {
            return;
        }

        this.memorySampleTimer = setInterval(() => {
            this.record("memory_sample", this.safeMemorySnapshotFields());
        }, config.memorySampleIntervalMs);
        this.memorySampleTimer.unref?.();
    }

    private safeMemorySnapshotFields(): DebugLogFields {
        const fields = this.memorySnapshotFields;
        if (fields === undefined) {
            return {};
        }
        try {
            return fields();
        } catch {
            return { snapshotFailed: true };
        }
    }

    private clearMemorySampleTimer(): void {
        if (this.memorySampleTimer === undefined) {
            return;
        }
        clearInterval(this.memorySampleTimer);
        this.memorySampleTimer = undefined;
    }

    private reportWriteFailure(filePath: string, cause: unknown): void {
        if (this.writeFailureReported) {
            return;
        }
        this.writeFailureReported = true;
        this.reportWarning(
            `[pi-glowup] Failed to write debug log ${filePath}: ${errorMessage(cause)}`,
        );
    }
}

function resolveDebugLogPath(extensionDirectory: string, configuredPath: string): string {
    const trimmedPath = configuredPath.trim();
    return isAbsolute(trimmedPath) ? trimmedPath : join(extensionDirectory, trimmedPath);
}

function rotateDebugLogIfNeeded(
    filePath: string,
    maxBytes: number | null,
    nextLineBytes: number,
): void {
    if (maxBytes === null) {
        return;
    }

    try {
        if (!existsSync(filePath) || statSync(filePath).size + nextLineBytes <= maxBytes) {
            return;
        }
        const rotatedPath = `${filePath}.1`;
        rmSync(rotatedPath, { force: true });
        renameSync(filePath, rotatedPath);
    } catch (cause: unknown) {
        if (!hasNodeErrorCode(cause, "ENOENT")) {
            throw cause;
        }
    }
}

function compactFields(fields: DebugLogFields): DebugLogFields {
    const compacted: Record<string, DebugLogValue> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
            compacted[key] = value;
        }
    }
    return compacted;
}

function errorMessage(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

function hasNodeErrorCode(cause: unknown, code: string): boolean {
    if (!(cause instanceof Error)) return false;
    // SAFETY: cause is proven to be an Error instance above; inspect optional Node.js code property.
    const errorWithCode = cause as Error & { code?: unknown };
    return errorWithCode.code === code;
}
