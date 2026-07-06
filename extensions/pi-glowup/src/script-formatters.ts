import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { ScriptInvocation } from "./rendering.ts";

export type ScriptBlockFormatterInput = {
    readonly label: string;
    readonly language: string;
    readonly code: string;
};

export type ScriptBlockFormatterOptions = {
    readonly signal?: AbortSignal;
};

export type ScriptBlockFormatter = (
    input: ScriptBlockFormatterInput,
    options?: ScriptBlockFormatterOptions,
) => Promise<string | undefined>;

export type ScriptFormatterCommands = ReadonlyMap<string, readonly string[]>;

export type ScriptFormatterWarningReporter = (message: string) => void;

export type ScriptFormatterParseOptions = {
    readonly source?: string;
    readonly reportWarning?: ScriptFormatterWarningReporter;
};

const FORMATTER_TIMEOUT_MS = 1_000;
const FORMATTER_MAX_BUFFER = 1024 * 1024;
const FORMATTER_MAX_INPUT_BYTES = 64 * 1024;
const MAX_CONCURRENT_FORMATTERS = 2;
const MAX_QUEUED_FORMATTERS = 20;

type FormatterQueueEntry = {
    readonly signal: AbortSignal | undefined;
    readonly resolve: (release: (() => void) | undefined) => void;
    abort: (() => void) | undefined;
};

let activeFormatterCount = 0;
const queuedFormatters: FormatterQueueEntry[] = [];

function reportFormatterWarning(options: ScriptFormatterParseOptions, message: string): void {
    options.reportWarning?.(`[pi-codex-look] ${message}`);
}

function formatterSource(options: ScriptFormatterParseOptions): string {
    return options.source ?? "script formatter config";
}

function isSafeFormatterCommandPart(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isFormatterCommand(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.length > 0 && value.every(isSafeFormatterCommandPart);
}

function normalizeCode(code: string): string {
    return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/u, "");
}

export function parseScriptFormatterCommandsValue(
    value: unknown,
    options: ScriptFormatterParseOptions = {},
): ScriptFormatterCommands {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        reportFormatterWarning(
            options,
            `Ignoring invalid ${formatterSource(options)}: expected object`,
        );
        return new Map();
    }

    const commands = new Map<string, readonly string[]>();
    const invalidEntries: string[] = [];
    for (const [language, command] of Object.entries(value)) {
        if (language.trim().length === 0) {
            invalidEntries.push("<blank>");
            continue;
        }
        if (!isFormatterCommand(command)) {
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

function finishFormatterCommand(
    resolve: (value: string | undefined) => void,
    value: string | undefined,
    state: { settled: boolean },
    timeout: ReturnType<typeof setTimeout>,
): void {
    if (state.settled) {
        return;
    }
    state.settled = true;
    clearTimeout(timeout);
    resolve(value);
}

function runFormatterCommand(
    executable: string,
    args: readonly string[],
    input: string,
    options: ScriptBlockFormatterOptions,
): Promise<string | undefined> {
    if (options.signal?.aborted === true) {
        return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
        const state = { settled: false };
        let stdout = "";
        let stdoutBytes = 0;
        let child: ChildProcessByStdio<Writable, Readable, null>;
        try {
            child = spawn(executable, [...args], {
                shell: false,
                signal: options.signal,
                stdio: ["pipe", "pipe", "ignore"],
            });
        } catch {
            resolve(undefined);
            return;
        }
        const timeout = setTimeout(() => {
            child.kill();
            finishFormatterCommand(resolve, undefined, state, timeout);
        }, FORMATTER_TIMEOUT_MS);
        timeout.unref?.();

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdoutBytes += Buffer.byteLength(chunk, "utf8");
            if (stdoutBytes > FORMATTER_MAX_BUFFER) {
                child.kill();
                finishFormatterCommand(resolve, undefined, state, timeout);
                return;
            }
            stdout += chunk;
        });
        child.stdin.on("error", () => {
            finishFormatterCommand(resolve, undefined, state, timeout);
        });
        child.on("error", () => {
            finishFormatterCommand(resolve, undefined, state, timeout);
        });
        child.on("close", (code) => {
            finishFormatterCommand(resolve, code === 0 ? stdout : undefined, state, timeout);
        });
        child.stdin.end(input);
    });
}

function acquireFormatterSlot(
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

export function createCommandScriptFormatter(
    commands: ScriptFormatterCommands,
): ScriptBlockFormatter | undefined {
    if (commands.size === 0) {
        return undefined;
    }

    return async (input, options = {}) => {
        const command = commands.get(input.language);
        if (command === undefined) {
            return undefined;
        }
        if (Buffer.byteLength(input.code, "utf8") > FORMATTER_MAX_INPUT_BYTES) {
            return undefined;
        }

        const [executable, ...args] = command;
        if (executable === undefined) {
            return undefined;
        }

        const release = await acquireFormatterSlot(options);
        if (release === undefined) {
            return undefined;
        }

        let output: string | undefined;
        try {
            output = await runFormatterCommand(executable, args, input.code, options);
        } finally {
            release();
        }
        if (output === undefined) {
            return undefined;
        }

        const formatted = normalizeCode(output);
        return formatted.trim().length > 0 ? formatted : undefined;
    };
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
    } catch {
        return invocation;
    }

    if (code === undefined) {
        return invocation;
    }

    return { ...invocation, code };
}
