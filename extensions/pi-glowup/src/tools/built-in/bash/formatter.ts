import { spawn, type ChildProcessByStdio } from "node:child_process";
import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { ScriptInvocation } from "./invocation.ts";
import { jsonObjectParser, type JsonValue } from "../../../json-value.ts";
import { stringParser } from "../../../json-scalar.ts";
import { Value } from "typebox/value";
import {
    scriptFormatterProfileSchema,
    type ScriptFormatterProfile,
} from "../../../settings-input.ts";
import { prepareFormatterCommand, type PreparedFormatterCommand } from "./display-profile.ts";
import { compactPythonStructuralBlankRows } from "../../../rendering/syntax/highlighter.ts";
import {
    diagnosticCodeHash,
    recordRenderError,
    recordRenderEvent,
    renderDiagnosticsEnabled,
    utf8Bytes,
    type ScriptFormatDiagnostics,
} from "../../../diagnostics/render-events.ts";
import { filterFormatterCommand, formatFilterProgram } from "./filter-formatting.ts";

export type ScriptBlockFormatterInput = {
    readonly label: string;
    readonly language: string;
    readonly code: string;
    readonly targetWidth?: number;
    /** Columns before the first row, for programs embedded after a command prefix. */
    readonly firstLineOffset?: number;
};

export type ScriptBlockFormatterOptions = {
    readonly signal?: AbortSignal;
    readonly targetWidth?: number;
    readonly diagnostics?: ScriptFormatDiagnostics;
};

export type ScriptBlockFormatter = ((
    input: ScriptBlockFormatterInput,
    options?: ScriptBlockFormatterOptions,
) => Promise<string | undefined>) & {
    readonly profileFor?: (language: string) => ScriptFormatterProfile | undefined;
};

export type ScriptFormatterCommands = ReadonlyMap<string, ScriptFormatterProfile>;
export type ScriptFormatterWarningReporter = (message: string) => void;

export type ScriptFormatterParseOptions = {
    readonly source?: string;
    readonly reportWarning?: ScriptFormatterWarningReporter;
};

const FORMATTER_TIMEOUT_MS = 1_000;
const FORMATTER_TERMINATION_GRACE_MS = 250;
const FORMATTER_MAX_BUFFER = 1024 * 1024;
const FORMATTER_MAX_INPUT_BYTES = 64 * 1024;
const MAX_CONCURRENT_FORMATTERS = 2;
const MAX_QUEUED_FORMATTERS = 20;
const MAX_FORMATTER_CACHE_ENTRIES = 300;
const MAX_FORMATTER_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_STDERR_CHARS = 600;

type ScriptFormatOutcome =
    | "formatted"
    | "unchanged"
    | "cached"
    | "declined"
    | "failed"
    | "timeout"
    | "output-limit"
    | "input-limit"
    | "missing-executable"
    | "cancelled"
    | "queue-full"
    | "no-profile";

type FormatterRun = {
    readonly output: string | undefined;
    readonly outcome: ScriptFormatOutcome;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly stderr?: string;
};

type FormatAttempt = FormatterRun & {
    readonly profileKind?: string;
    readonly targetWidth?: number;
    readonly detail?: string;
};

type FormatterQueueEntry = {
    readonly signal: AbortSignal | undefined;
    readonly resolve: (release: (() => void) | undefined) => void;
    abort: (() => void) | undefined;
};

let activeFormatterCount = 0;
const queuedFormatters: FormatterQueueEntry[] = [];

function reportFormatterWarning(options: ScriptFormatterParseOptions, message: string): void {
    options.reportWarning?.(`[pi-glowup] ${message}`);
}

function formatterSource(options: ScriptFormatterParseOptions): string {
    return options.source ?? "script formatter config";
}

function isSafeFormatterCommandPart(value: JsonValue): value is string {
    const text = stringParser.parse(value);
    return text !== undefined && text.trim().length > 0 && !text.includes("\0");
}

function formatterProfile(value: JsonValue): ScriptFormatterProfile | undefined {
    try {
        const profile = Value.Parse(scriptFormatterProfileSchema, value);
        if (!(profile.command ?? []).every(isSafeFormatterCommandPart)) return undefined;
        return profile;
    } catch {
        return undefined;
    }
}

function normalizeCode(code: string): string {
    return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "");
}

function substituteWidthPlaceholders(
    args: readonly string[],
    targetWidth: number | undefined,
): string[] {
    if (targetWidth === undefined) {
        return args.map((arg) => arg.replace(/\{width\}|\{line_length\}|\{cols\}/gi, "88"));
    }

    const widthStr = String(targetWidth);

    return args.map((arg) => arg.replace(/\{width\}|\{line_length\}|\{cols\}/gi, widthStr));
}

export function parseScriptFormatterCommandsValue(
    value: unknown,
    options: ScriptFormatterParseOptions = {},
): ScriptFormatterCommands {
    const record = jsonObjectParser.parse(value);
    if (record === undefined) {
        reportFormatterWarning(
            options,
            `Ignoring invalid ${formatterSource(options)}: expected object`,
        );
        return new Map();
    }

    const commands = new Map<string, ScriptFormatterProfile>();
    const invalidEntries: string[] = [];
    for (const [language, value] of Object.entries(record)) {
        if (language.trim().length === 0) {
            invalidEntries.push("<blank>");
            continue;
        }

        const command = formatterProfile(value);
        if (command === undefined || (command.kind !== "command" && command.kind !== language)) {
            invalidEntries.push(language);
            continue;
        }

        commands.set(language, command);
    }

    if (invalidEntries.length > 0) {
        const shownEntries = invalidEntries.slice(0, 3).join(", ");
        const hiddenCount = invalidEntries.length - Math.min(invalidEntries.length, 3);
        const suffix = hiddenCount > 0 ? ` (+${hiddenCount} more)` : "";
        reportFormatterWarning(
            options,
            `Ignoring invalid formatter command entries in ${formatterSource(options)}: ${shownEntries}${suffix}`,
        );
    }

    return commands;
}

export function parseScriptFormatterCommands(
    value: string | undefined,
    options: ScriptFormatterParseOptions = {},
): ScriptFormatterCommands {
    if (value === undefined || value.trim().length === 0) {
        return new Map();
    }

    try {
        const parsed: unknown = JSON.parse(value);
        return parseScriptFormatterCommandsValue(parsed, options);
    } catch {
        reportFormatterWarning(
            options,
            `Ignoring invalid ${formatterSource(options)}: expected JSON object`,
        );
        return new Map();
    }
}

// Result completion is deliberately independent of permit ownership: a failed preview
// returns promptly, but the child owns its permit until Node confirms stdio closure.
async function runFormatterCommand(
    executable: string,
    args: readonly string[],
    input: string,
    options: ScriptBlockFormatterOptions,
    release: () => void,
    cwd: string | undefined,
    reportFailure: (message: string) => void,
): Promise<FormatterRun> {
    if (options.signal?.aborted === true) {
        release();
        return Promise.resolve({ output: undefined, outcome: "cancelled" });
    }

    const targetWidth = options.targetWidth;
    const finalArgs = substituteWidthPlaceholders(args, targetWidth);
    const widthEnv =
        targetWidth === undefined
            ? undefined
            : {
                  TUFF_LINE_LENGTH: String(targetWidth),
                  RUFF_LINE_LENGTH: String(targetWidth),
                  COLUMNS: String(targetWidth),
              };
    const env = { ...process.env, ...widthEnv };

    // Formatter stderr is read only for the private debug log; otherwise it stays ignored.
    const captureStderr = renderDiagnosticsEnabled();

    return new Promise((resolve) => {
        let settled = false;
        let terminating = false;
        let stdout = "";
        let stdoutBytes = 0;
        let stderr = "";
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let child: ChildProcessByStdio<Writable, Readable, Readable | null>;

        try {
            const spawnOptions = { shell: false, signal: options.signal, cwd, env } as const;
            if (captureStderr) {
                child = spawn(executable, [...finalArgs], {
                    ...spawnOptions,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            } else {
                child = spawn(executable, [...finalArgs], {
                    ...spawnOptions,
                    stdio: ["pipe", "pipe", "ignore"],
                });
            }
        } catch (cause: unknown) {
            release();

            recordRenderError("formatter.spawn", cause, options.diagnostics?.toolCallId);

            if (options.signal?.aborted !== true) reportFailure("could not start");
            resolve({ output: undefined, outcome: "failed" });

            return;
        }

        const finish = (run: FormatterRun): void => {
            if (settled) return;

            settled = true;
            clearTimeout(timeout);
            stdout = "";
            resolve(run);
        };

        const capturedStderr = (): string | undefined => {
            if (!captureStderr || stderr.length === 0) return undefined;
            return stderr;
        };

        const fail = (reason?: string, outcome: ScriptFormatOutcome = "failed"): void => {
            if (reason !== undefined && options.signal?.aborted !== true && !settled)
                reportFailure(reason);

            let resolvedOutcome = outcome;
            if (options.signal?.aborted === true) resolvedOutcome = "cancelled";
            finish({ output: undefined, outcome: resolvedOutcome });

            if (terminating) return;

            terminating = true;
            child.kill();

            // SIGTERM can be ignored. Cleanup stays owned even after preview fallback.
            escalation = setTimeout(() => {
                child.kill("SIGKILL");
            }, FORMATTER_TERMINATION_GRACE_MS);
            escalation.unref();
        };

        const timeout = setTimeout(
            () => fail(`timed out after ${FORMATTER_TIMEOUT_MS} ms`, "timeout"),
            FORMATTER_TIMEOUT_MS,
        );
        timeout.unref();

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (settled) return;

            stdoutBytes += Buffer.byteLength(chunk, "utf8");
            if (stdoutBytes > FORMATTER_MAX_BUFFER) {
                fail(`output exceeded ${FORMATTER_MAX_BUFFER} bytes`, "output-limit");
                return;
            }

            stdout += chunk;
        });

        if (child.stderr !== null) {
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => {
                if (stderr.length < MAX_DIAGNOSTIC_STDERR_CHARS)
                    stderr = (stderr + chunk).slice(0, MAX_DIAGNOSTIC_STDERR_CHARS);
            });
        }

        child.stdin.on("error", () => fail());
        child.on("error", (cause: unknown) => {
            let outcome: ScriptFormatOutcome = "failed";
            if (options.signal?.aborted !== true) {
                let reason = "failed";
                if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
                    reason = "executable not found";
                    outcome = "missing-executable";
                }

                reportFailure(reason);
            }

            fail(undefined, outcome);
        });

        const abort = (): void => fail();
        options.signal?.addEventListener("abort", abort, { once: true });

        child.once("close", (code, signal) => {
            options.signal?.removeEventListener("abort", abort);
            clearTimeout(escalation);

            if (code !== 0 && options.signal?.aborted !== true) {
                if (code !== null) reportFailure(`exited with status ${code}`);
                else if (signal !== null) reportFailure(`terminated by ${signal}`);
                else reportFailure("failed");
            }

            const exit = {
                ...(code !== null && { exitCode: code }),
                ...(signal !== null && { signal }),
            };
            const capturedError = capturedStderr();
            const diagnostics = {
                ...exit,
                ...(capturedError !== undefined && { stderr: capturedError }),
            };
            if (code === 0) finish({ output: stdout, outcome: "formatted", ...diagnostics });
            else if (options.signal?.aborted === true)
                finish({ output: undefined, outcome: "cancelled", ...diagnostics });
            else finish({ output: undefined, outcome: "failed", ...diagnostics });

            release();
        });

        child.stdin.end(input);
    });
}

export type ScriptFormatterWorkload = {
    readonly active: number;
    readonly queued: number;
};

/** Content-free workload snapshot for diagnostics; active includes children awaiting close. */
export function getScriptFormatterWorkload(): ScriptFormatterWorkload {
    return { active: activeFormatterCount, queued: queuedFormatters.length };
}

async function acquireFormatterSlot(
    options: ScriptBlockFormatterOptions,
): Promise<(() => void) | undefined> {
    if (options.signal?.aborted === true) {
        return Promise.resolve(undefined);
    }

    if (activeFormatterCount < MAX_CONCURRENT_FORMATTERS) {
        activeFormatterCount += 1;
        return Promise.resolve(releaseFormatterSlot);
    }

    if (queuedFormatters.length >= MAX_QUEUED_FORMATTERS) {
        return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
        const entry: FormatterQueueEntry = {
            signal: options.signal,
            resolve,
            abort: undefined,
        };
        const abort = (): void => {
            const index = queuedFormatters.indexOf(entry);
            if (index >= 0) {
                queuedFormatters.splice(index, 1);
            }

            resolve(undefined);
        };

        entry.abort = abort;
        options.signal?.addEventListener("abort", abort, { once: true });
        queuedFormatters.push(entry);
    });
}

function releaseFormatterSlot(): void {
    activeFormatterCount = Math.max(0, activeFormatterCount - 1);
    startQueuedFormatters();
}

function startQueuedFormatters(): void {
    while (activeFormatterCount < MAX_CONCURRENT_FORMATTERS) {
        const entry = queuedFormatters.shift();
        if (entry === undefined) {
            return;
        }

        if (entry.abort !== undefined) {
            entry.signal?.removeEventListener("abort", entry.abort);
        }

        if (entry.signal?.aborted === true) {
            entry.resolve(undefined);
            continue;
        }

        activeFormatterCount += 1;
        entry.resolve(releaseFormatterSlot);
    }
}

function recordScriptFormat(
    input: ScriptBlockFormatterInput,
    options: ScriptBlockFormatterOptions,
    attempt: FormatAttempt,
    started: number,
): void {
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const context = options.diagnostics;
    const targetWidth = attempt.targetWidth ?? input.targetWidth ?? options.targetWidth;
    const dedupe = (): string =>
        [
            context?.toolCallId ?? "",
            context?.stage ?? "",
            input.language,
            String(targetWidth ?? ""),
            attempt.outcome,
            diagnosticCodeHash(input.code),
        ].join("\0");

    const fields = () => {
        let sourceCodeHash: string | undefined;
        if (context?.sourceCode !== undefined && context.sourceCode !== input.code)
            sourceCodeHash = diagnosticCodeHash(context.sourceCode);

        let outputHash: string | undefined;
        if (attempt.output !== undefined) outputHash = diagnosticCodeHash(attempt.output);

        let segmentHash: string | undefined;
        if (context?.segmentCode !== undefined)
            segmentHash = diagnosticCodeHash(context.segmentCode);

        return {
            toolCallId: context?.toolCallId,
            stage: context?.stage,
            language: input.language,
            profileKind: attempt.profileKind,
            codeHash: diagnosticCodeHash(input.code),
            sourceCodeHash,
            segmentHash,
            outputHash,
            bytes: utf8Bytes(input.code),
            targetWidth,
            outcome: attempt.outcome,
            ms,
            exitCode: attempt.exitCode,
            signal: attempt.signal,
            stderr: attempt.stderr,
            detail: attempt.detail,
        };
    };

    // Re-renders repeat cache hits and missing profiles; record each such pair once.
    if (attempt.outcome === "cached" || attempt.outcome === "no-profile")
        recordRenderEvent("script_format", fields, dedupe);
    else recordRenderEvent("script_format", fields);
}

export function createCommandScriptFormatter(
    commands: ScriptFormatterCommands,
    reportWarning: ScriptFormatterWarningReporter = reportExtensionDiagnostic,
): ScriptBlockFormatter | undefined {
    if (commands.size === 0) {
        return undefined;
    }

    const cache = new Map<string, { readonly output: string; readonly bytes: number }>();
    let cacheBytes = 0;
    const reportedFailures = new Set<string>();
    const reportFailure = (language: string, reason: string): void => {
        if (reportedFailures.has(language)) return;

        reportedFailures.add(language);
        reportWarning(`[pi-glowup] ${language} display formatter ${reason}`);
    };

    const remember = (key: string, output: string): void => {
        const bytes = Buffer.byteLength(output, "utf8");
        if (bytes > MAX_FORMATTER_CACHE_BYTES) return;

        cacheBytes -= cache.get(key)?.bytes ?? 0;
        cache.set(key, { output, bytes });
        cacheBytes += bytes;
        while (cache.size > MAX_FORMATTER_CACHE_ENTRIES || cacheBytes > MAX_FORMATTER_CACHE_BYTES) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;

            const removed = cache.get(oldest);
            cache.delete(oldest);
            cacheBytes = Math.max(0, cacheBytes - (removed?.bytes ?? 0));
        }
    };

    const profileFor = (language: string): ScriptFormatterProfile | undefined => {
        const configured = commands.get(language);
        if (configured !== undefined) return configured;
        if (language === "tsx") return commands.get("typescript");
        if (language === "jsx") return commands.get("javascript");
        return undefined;
    };

    const formatScriptBlock = async (
        input: ScriptBlockFormatterInput,
        options: ScriptBlockFormatterOptions,
    ): Promise<FormatAttempt> => {
        if (options.signal?.aborted === true) return { output: undefined, outcome: "cancelled" };

        const command = profileFor(input.language);
        if (command === undefined) {
            return { output: undefined, outcome: "no-profile" };
        }

        const targetWidth = input.targetWidth ?? options.targetWidth;
        const described = {
            profileKind: command.kind,
            ...(targetWidth !== undefined && { targetWidth }),
        };

        if (Buffer.byteLength(input.code, "utf8") > FORMATTER_MAX_INPUT_BYTES) {
            return { output: undefined, outcome: "input-limit", ...described };
        }

        const effectiveOptions: ScriptBlockFormatterOptions =
            targetWidth === undefined ? options : { ...options, targetWidth };

        const cacheKey = createHash("sha256")
            .update(input.language)
            .update("\0")
            .update(targetWidth === undefined ? "" : String(targetWidth))
            .update("\0")
            .update(String(input.firstLineOffset ?? 0))
            .update("\0")
            .update(input.code)
            .digest("hex");
        const cached = cache.get(cacheKey);
        if (cached !== undefined) return { output: cached.output, outcome: "cached", ...described };

        if (command.kind === "awk" || command.kind === "jq") {
            const [executable, ...baseArgs] = filterFormatterCommand(command);
            if (executable === undefined)
                return { output: undefined, outcome: "missing-executable", ...described };

            const result = await formatFilterProgram(
                input.code,
                command,
                { width: targetWidth ?? 88, firstLineOffset: input.firstLineOffset ?? 0 },
                async (args, stdin): Promise<FormatterRun> => {
                    const slot = await acquireFormatterSlot(effectiveOptions);
                    if (slot === undefined) {
                        if (effectiveOptions.signal?.aborted === true)
                            return { output: undefined, outcome: "cancelled" };

                        return { output: undefined, outcome: "queue-full" };
                    }

                    return runFormatterCommand(
                        executable,
                        [...baseArgs, ...args],
                        stdin,
                        effectiveOptions,
                        slot,
                        undefined,
                        (reason) => {
                            // Both formatters exit 1 for programs they cannot parse,
                            // such as mawk-only syntax; that is a declined preview.
                            if (reason !== "exited with status 1")
                                reportFailure(input.language, reason);
                        },
                    );
                },
            );

            if (effectiveOptions.signal?.aborted === true)
                return { ...result.run, ...described, output: undefined, outcome: "cancelled" };

            if (result.kind === "formatted") {
                remember(cacheKey, result.output);
                return { ...result.run, ...described, output: result.output, outcome: "formatted" };
            }

            if (result.kind === "unchanged") {
                return {
                    ...result.run,
                    ...described,
                    output: undefined,
                    outcome: "unchanged",
                    ...(result.detail !== undefined && { detail: result.detail }),
                };
            }

            if (result.kind === "declined")
                return {
                    ...result.run,
                    ...described,
                    output: undefined,
                    outcome: "declined",
                    detail: result.detail,
                };

            if (result.run.outcome === "failed" && result.run.exitCode === 1)
                return {
                    ...result.run,
                    ...described,
                    outcome: "declined",
                    detail: "formatter-rejected",
                };

            return { ...result.run, ...described };
        }

        const release = await acquireFormatterSlot(effectiveOptions);
        if (release === undefined) {
            if (effectiveOptions.signal?.aborted === true)
                return { output: undefined, outcome: "cancelled", ...described };

            return { output: undefined, outcome: "queue-full", ...described };
        }

        const completed = cache.get(cacheKey);
        if (completed !== undefined) {
            release();

            if (effectiveOptions.signal?.aborted === true)
                return { output: undefined, outcome: "cancelled", ...described };

            return { output: completed.output, outcome: "cached", ...described };
        }

        let prepared: PreparedFormatterCommand;
        try {
            prepared = await prepareFormatterCommand(command, effectiveOptions, input.language);
        } catch (cause: unknown) {
            release();

            recordRenderError("formatter.prepare", cause, options.diagnostics?.toolCallId);

            if (effectiveOptions.signal?.aborted !== true)
                reportFailure(input.language, "profile could not be prepared");

            return { output: undefined, outcome: "failed", ...described };
        }

        let resolveClosed = () => {};
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        const releaseClosed = (): void => {
            release();
            resolveClosed();
        };
        let run: FormatterRun;
        try {
            run = await runFormatterCommand(
                prepared.executable,
                prepared.args,
                input.code,
                effectiveOptions,
                releaseClosed,
                prepared.cwd,
                (reason) => reportFailure(input.language, reason),
            );
        } finally {
            if (prepared.dispose !== undefined) {
                await closed;
                await prepared.dispose();
            }
        }

        const output = run.output;
        if (output === undefined) {
            return { ...run, ...described };
        }

        let formatted = normalizeCode(output);
        if (formatted.trim().length === 0)
            return { ...run, ...described, output: undefined, outcome: "declined" };

        if (input.language === "python") {
            const compacted = await compactPythonStructuralBlankRows(formatted, {
                ...effectiveOptions,
                reportWarning,
            });
            if (compacted === undefined) {
                let outcome: ScriptFormatOutcome = "declined";
                if (effectiveOptions.signal?.aborted === true) outcome = "cancelled";

                return {
                    ...run,
                    ...described,
                    output: undefined,
                    outcome,
                    detail: "python blank-row compaction unavailable",
                };
            }

            formatted = compacted;
        }

        if (effectiveOptions.signal?.aborted === true)
            return { ...run, ...described, output: undefined, outcome: "cancelled" };

        remember(cacheKey, formatted);

        let outcome: ScriptFormatOutcome = "formatted";
        if (formatted === normalizeCode(input.code)) outcome = "unchanged";

        return { ...run, ...described, output: formatted, outcome };
    };

    const formatter: ScriptBlockFormatter = async (input, options = {}) => {
        if (!renderDiagnosticsEnabled()) return (await formatScriptBlock(input, options)).output;

        const started = performance.now();
        let attempt: FormatAttempt;
        try {
            attempt = await formatScriptBlock(input, options);
        } catch (cause: unknown) {
            recordScriptFormat(input, options, { output: undefined, outcome: "failed" }, started);
            throw cause;
        }

        recordScriptFormat(input, options, attempt, started);

        return attempt.output;
    };

    return Object.assign(formatter, { profileFor });
}

export async function formatScriptInvocation(
    invocation: ScriptInvocation,
    formatter: ScriptBlockFormatter | undefined,
    options: ScriptBlockFormatterOptions = {},
): Promise<ScriptInvocation> {
    let code: string | undefined;
    try {
        code = await formatter?.(
            {
                label: invocation.label,
                language: invocation.language,
                code: invocation.code,
            },
            options,
        );
    } catch (cause: unknown) {
        recordRenderError("formatter.invocation", cause, options.diagnostics?.toolCallId);
        return invocation;
    }

    if (code === undefined) {
        return invocation;
    }

    return { ...invocation, code };
}
