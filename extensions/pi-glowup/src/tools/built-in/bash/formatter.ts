import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import { createHash } from "node:crypto";
import type { ScriptInvocation } from "./invocation.ts";
import type { EmbeddedProgram } from "./embedded-programs.ts";
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
    utf8Bytes,
    type ScriptFormatDiagnostics,
} from "../../../diagnostics/render-events.ts";
import { filterFormatterCommand, formatFilterProgram } from "./filter-formatting.ts";
import {
    runFormatterCommand,
    type FormatterRun,
    type ScriptFormatOutcome,
} from "./formatter-process.ts";
import type { FormatterOutputKey, FormatterOutputStore } from "./formatter-store.ts";

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
    readonly programs?: readonly EmbeddedProgram[];
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

const MAX_CONCURRENT_FORMATTERS = 2;
const MAX_FORMATTER_CACHE_ENTRIES = 300;
const MAX_FORMATTER_CACHE_BYTES = 4 * 1024 * 1024;

type FormatAttempt = FormatterRun & {
    readonly profileKind?: string;
    readonly targetWidth?: number;
    readonly detail?: string;
};

type FormatterQueueEntry = {
    readonly signal: AbortSignal | undefined;
    readonly visible: boolean;
    readonly queuedAt: number;
    readonly resolve: (release: (() => void) | undefined) => void;
    abort: (() => void) | undefined;
};

let activeFormatterCount = 0;
const queuedFormatters: FormatterQueueEntry[] = [];

function cancelled(cause: unknown, signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError");
}

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

// Command profiles also receive the width through COLUMNS and line-length variables.
function usesTargetWidth(profile: ScriptFormatterProfile): boolean {
    return profile.kind !== "bash";
}

function normalizeCode(code: string): string {
    return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "");
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
        return Promise.resolve(createFormatterSlotRelease());
    }

    return new Promise((resolve) => {
        const entry: FormatterQueueEntry = {
            signal: options.signal,
            visible: options.targetWidth !== undefined,
            queuedAt: performance.now(),
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

function createFormatterSlotRelease(): () => void {
    let ownership: "held" | "released" = "held";
    return () => {
        if (ownership === "released") return;

        ownership = "released";
        activeFormatterCount -= 1;
        startQueuedFormatters();
    };
}

function startQueuedFormatters(): void {
    while (activeFormatterCount < MAX_CONCURRENT_FORMATTERS) {
        // Prefer the newest measured (visible) preview, but age queued history so
        // a steady stream of viewport changes cannot starve older work.
        let index = 0;
        if (performance.now() - (queuedFormatters[0]?.queuedAt ?? 0) < 1_000) {
            for (let candidate = queuedFormatters.length - 1; candidate >= 0; candidate -= 1) {
                if (queuedFormatters[candidate]?.visible === true) {
                    index = candidate;
                    break;
                }
            }
        }

        const [entry] = queuedFormatters.splice(index, 1);
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
        entry.resolve(createFormatterSlotRelease());
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

function formatterOutputKey(
    profile: ScriptFormatterProfile,
    input: ScriptBlockFormatterInput,
    width: number | undefined,
): FormatterOutputKey | undefined {
    let executable = profile.command?.[0];
    if (profile.kind === "awk" || profile.kind === "jq")
        executable = filterFormatterCommand(profile)[0];

    if (executable === undefined) return undefined;

    return {
        executable,
        input: JSON.stringify([
            profile,
            input.language,
            width ?? null,
            input.firstLineOffset ?? 0,
            input.code,
        ]),
    };
}

export function createCommandScriptFormatter(
    commands: ScriptFormatterCommands,
    reportWarning: ScriptFormatterWarningReporter = reportExtensionDiagnostic,
    store?: FormatterOutputStore,
): ScriptBlockFormatter | undefined {
    if (commands.size === 0) {
        return undefined;
    }

    const cache = new Map<string, { readonly output: string; readonly bytes: number }>();
    let cacheBytes = 0;
    const rejected = new Map<string, FormatAttempt>();
    const rememberRejection = (key: string, attempt: FormatAttempt): void => {
        rejected.delete(key);
        rejected.set(key, attempt);

        if (rejected.size <= MAX_FORMATTER_CACHE_ENTRIES) return;

        const oldest = rejected.keys().next().value;
        if (oldest !== undefined) rejected.delete(oldest);
    };

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

    const runScriptBlock = async (
        input: ScriptBlockFormatterInput,
        options: ScriptBlockFormatterOptions,
    ): Promise<FormatAttempt> => {
        if (options.signal?.aborted === true) return { output: undefined, outcome: "cancelled" };

        const command = profileFor(input.language);
        if (command === undefined) {
            return { output: undefined, outcome: "no-profile" };
        }

        const targetWidth = input.targetWidth ?? options.targetWidth;
        const keyWidth = usesTargetWidth(command) ? targetWidth : undefined;
        const described = {
            profileKind: command.kind,
            ...(targetWidth !== undefined && { targetWidth }),
        };

        const effectiveOptions: ScriptBlockFormatterOptions =
            targetWidth === undefined ? options : { ...options, targetWidth };

        const cacheKey = createHash("sha256")
            .update(input.language)
            .update("\0")
            .update(keyWidth === undefined ? "" : String(keyWidth))
            .update("\0")
            .update(String(input.firstLineOffset ?? 0))
            .update("\0")
            .update(input.code)
            .digest("hex");
        const cached = cache.get(cacheKey);
        if (cached !== undefined) return { output: cached.output, outcome: "cached", ...described };

        const knownRejection = rejected.get(cacheKey);
        if (knownRejection !== undefined) return knownRejection;

        const storedKey = formatterOutputKey(command, input, keyWidth);
        let stored: string | undefined;
        if (store !== undefined && storedKey !== undefined) stored = await store.read(storedKey);

        if (stored !== undefined) {
            remember(cacheKey, stored);
            return { output: stored, outcome: "cached", ...described };
        }

        const keep = (output: string): void => {
            remember(cacheKey, output);

            if (storedKey !== undefined) store?.write(storedKey, output);
        };

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
                        return { output: undefined, outcome: "cancelled" };
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
                keep(result.output);
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
            return { output: undefined, outcome: "cancelled", ...described };
        }

        const completed = cache.get(cacheKey);
        if (completed !== undefined) {
            release();

            if (effectiveOptions.signal?.aborted === true)
                return { output: undefined, outcome: "cancelled", ...described };

            return { output: completed.output, outcome: "cached", ...described };
        }

        const completedRejection = rejected.get(cacheKey);
        if (completedRejection !== undefined) {
            release();
            return completedRejection;
        }

        let prepared: PreparedFormatterCommand;
        try {
            prepared = await prepareFormatterCommand(command, effectiveOptions, input.language);
        } catch (cause: unknown) {
            release();

            if (cancelled(cause, effectiveOptions.signal))
                return { output: undefined, outcome: "cancelled", ...described };

            recordRenderError("formatter.prepare", cause, options.diagnostics?.toolCallId);
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
            // A formatter that exits with an error status rejects this exact input.
            if (run.outcome === "failed" && run.exitCode !== undefined && run.signal === undefined)
                rememberRejection(cacheKey, { ...run, ...described });

            return { ...run, ...described };
        }

        let formatted = normalizeCode(output);
        if (formatted.trim().length === 0) {
            const declined: FormatAttempt = {
                ...run,
                ...described,
                output: undefined,
                outcome: "declined",
            };
            rememberRejection(cacheKey, declined);
            return declined;
        }

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

        keep(formatted);

        let outcome: ScriptFormatOutcome = "formatted";
        if (formatted === normalizeCode(input.code)) outcome = "unchanged";

        return { ...run, ...described, output: formatted, outcome };
    };

    // Consumers own their cancellation independently; shared work stops only when
    // no renderer still needs it. Each consumer still records its own diagnostics.
    const pending = new Map<
        string,
        {
            readonly controller: AbortController;
            readonly result: Promise<FormatAttempt>;
            consumers: number;
        }
    >();
    const formatScriptBlock = async (
        input: ScriptBlockFormatterInput,
        options: ScriptBlockFormatterOptions,
    ): Promise<FormatAttempt> => {
        if (options.signal?.aborted === true)
            return Promise.resolve({ output: undefined, outcome: "cancelled" });

        const profile = profileFor(input.language);
        let keyWidth = input.targetWidth ?? options.targetWidth;
        if (profile !== undefined && !usesTargetWidth(profile)) keyWidth = undefined;

        const key = JSON.stringify([
            input.language,
            keyWidth,
            input.firstLineOffset ?? 0,
            input.code,
        ]);
        let work = pending.get(key);
        if (work === undefined) {
            const controller = new AbortController();
            work = {
                controller,
                result: runScriptBlock(input, { ...options, signal: controller.signal }),
                consumers: 0,
            };
            pending.set(key, work);

            const owner = work;
            const forget = (): void => {
                if (pending.get(key) === owner) pending.delete(key);
            };

            void work.result.then(forget, forget);
        }

        const owner = work;
        owner.consumers += 1;

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (): boolean => {
                if (settled) return false;

                settled = true;
                options.signal?.removeEventListener("abort", abort);
                owner.consumers -= 1;
                if (owner.consumers === 0) {
                    owner.controller.abort();

                    if (pending.get(key) === owner) pending.delete(key);
                }

                return true;
            };

            const abort = (): void => {
                if (finish()) resolve({ output: undefined, outcome: "cancelled" });
            };

            options.signal?.addEventListener("abort", abort, { once: true });
            void owner.result.then(
                (result) => {
                    if (finish()) resolve(result);
                },
                (cause: unknown) => {
                    if (finish()) reject(cause instanceof Error ? cause : new Error(String(cause)));
                },
            );
        });
    };

    const formatter: ScriptBlockFormatter = async (input, options = {}) => {
        const started = performance.now();
        let attempt: FormatAttempt;
        try {
            attempt = await formatScriptBlock(input, options);
        } catch (cause: unknown) {
            if (cancelled(cause, options.signal))
                attempt = { output: undefined, outcome: "cancelled" };
            else {
                recordScriptFormat(
                    input,
                    options,
                    { output: undefined, outcome: "failed" },
                    started,
                );
                throw cause;
            }
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
        if (cancelled(cause, options.signal)) return invocation;

        recordRenderError("formatter.invocation", cause, options.diagnostics?.toolCallId);

        return invocation;
    }

    if (code === undefined) {
        return invocation;
    }

    return { ...invocation, code };
}
