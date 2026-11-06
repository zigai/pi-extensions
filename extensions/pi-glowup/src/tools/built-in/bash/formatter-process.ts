import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
    recordRenderError,
    renderDiagnosticsEnabled,
    type ScriptFormatDiagnostics,
} from "../../../diagnostics/render-events.ts";

const FORMATTER_TIMEOUT_MS = 5_000;
const FORMATTER_TERMINATION_GRACE_MS = 250;
const FORMATTER_MAX_BUFFER = 1024 * 1024;
const MAX_DIAGNOSTIC_STDERR_CHARS = 600;

export type FormatterProcessOptions = {
    readonly signal?: AbortSignal;
    readonly targetWidth?: number;
    readonly diagnostics?: ScriptFormatDiagnostics;
};

/** The subprocess boundary used by both Node and deterministic lifecycle tests. */
export type FormatterProcess = {
    readonly stdin: Writable;
    readonly stdout: Readable;
    readonly stderr: Readable | null;
    on(event: "error", listener: (cause: unknown) => void): FormatterProcess;

    once(
        event: "close",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ): FormatterProcess;

    kill(signal?: NodeJS.Signals): boolean;
};

type FormatterSpawnOptions = {
    readonly signal: AbortSignal | undefined;
    readonly cwd: string | undefined;
    readonly env: NodeJS.ProcessEnv;
    readonly captureStderr: boolean;
};

export type FormatterProcessSpawner = (
    executable: string,
    args: readonly string[],
    options: FormatterSpawnOptions,
) => FormatterProcess;

function spawnFormatterProcess(
    executable: string,
    args: readonly string[],
    options: FormatterSpawnOptions,
): FormatterProcess {
    const spawnOptions = {
        shell: false,
        signal: options.signal,
        cwd: options.cwd,
        env: options.env,
    } as const;
    if (options.captureStderr)
        return spawn(executable, [...args], { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });

    return spawn(executable, [...args], { ...spawnOptions, stdio: ["pipe", "pipe", "ignore"] });
}

export type ScriptFormatOutcome =
    | "formatted"
    | "unchanged"
    | "cached"
    | "declined"
    | "failed"
    | "timeout"
    | "output-limit"
    | "missing-executable"
    | "cancelled"
    | "no-profile";

export type FormatterRun = {
    readonly output: string | undefined;
    readonly outcome: ScriptFormatOutcome;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly stderr?: string;
};

type FormatterResultState =
    | { readonly phase: "pending"; stdout: string; stdoutBytes: number }
    | { readonly phase: "settled" };

type FormatterChildState =
    | { readonly phase: "running" }
    | {
          readonly phase: "terminating";
          readonly escalation: ReturnType<typeof setTimeout>;
      }
    | { readonly phase: "closed" };

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

// Result completion is deliberately independent of permit ownership: a failed preview
// returns promptly, but the child owns its permit until Node confirms stdio closure.
export async function runFormatterCommand(
    executable: string,
    args: readonly string[],
    input: string,
    options: FormatterProcessOptions,
    release: () => void,
    cwd: string | undefined,
    reportFailure: (message: string) => void,
    spawnProcess: FormatterProcessSpawner = spawnFormatterProcess,
): Promise<FormatterRun> {
    if (options.signal?.aborted === true) {
        release();
        return Promise.resolve({ output: undefined, outcome: "cancelled" });
    }

    const targetWidth = options.targetWidth;
    const finalArgs = substituteWidthPlaceholders(args, targetWidth);
    const env = { ...process.env };
    if (targetWidth !== undefined) {
        env.TUFF_LINE_LENGTH = String(targetWidth);
        env.RUFF_LINE_LENGTH = String(targetWidth);
        env.COLUMNS = String(targetWidth);
    }

    const inputBytes = Buffer.byteLength(input, "utf8");
    const timeoutMs = FORMATTER_TIMEOUT_MS + Math.ceil(inputBytes / 1024) * 100;
    const outputBudget = Math.max(FORMATTER_MAX_BUFFER, inputBytes * 64);

    // Formatter stderr is read only for the private debug log; otherwise it stays ignored.
    const captureStderr = renderDiagnosticsEnabled();

    return new Promise((resolve) => {
        let result: FormatterResultState = { phase: "pending", stdout: "", stdoutBytes: 0 };
        let childState: FormatterChildState = { phase: "running" };
        let stderr = "";
        let child: FormatterProcess;
        try {
            child = spawnProcess(executable, finalArgs, {
                signal: options.signal,
                cwd,
                env,
                captureStderr,
            });
        } catch (cause: unknown) {
            release();

            if (
                options.signal?.aborted === true ||
                (cause instanceof Error && cause.name === "AbortError")
            ) {
                resolve({ output: undefined, outcome: "cancelled" });
                return;
            }

            recordRenderError("formatter.spawn", cause, options.diagnostics?.toolCallId);
            reportFailure("could not start");
            resolve({ output: undefined, outcome: "failed" });

            return;
        }

        const finish = (run: FormatterRun): void => {
            if (result.phase === "settled") return;

            result = { phase: "settled" };
            clearTimeout(timeout);
            resolve(run);
        };

        const capturedStderr = (): string | undefined => {
            if (!captureStderr || stderr.length === 0) return undefined;
            return stderr;
        };

        const terminate = (): void => {
            if (childState.phase !== "running") return;

            // Arm and own escalation before sending TERM: even a synchronous close
            // must be able to retire the timer without a late callback rearming it.
            const escalation = setTimeout(() => {
                if (childState.phase !== "terminating" || childState.escalation !== escalation)
                    return;

                child.kill("SIGKILL");
            }, FORMATTER_TERMINATION_GRACE_MS);
            escalation.unref();
            childState = { phase: "terminating", escalation };
            child.kill();
        };

        const fail = (reason?: string, outcome: ScriptFormatOutcome = "failed"): void => {
            if (childState.phase === "closed") return;

            if (
                reason !== undefined &&
                options.signal?.aborted !== true &&
                result.phase === "pending"
            )
                reportFailure(reason);

            let resolvedOutcome = outcome;
            if (options.signal?.aborted === true) resolvedOutcome = "cancelled";
            finish({ output: undefined, outcome: resolvedOutcome });

            // Result settlement never releases child/stdio capacity.
            terminate();
        };

        const timeout = setTimeout(
            () => fail(`timed out after ${timeoutMs} ms`, "timeout"),
            timeoutMs,
        );
        timeout.unref();

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            if (result.phase !== "pending") return;

            result.stdoutBytes += Buffer.byteLength(chunk, "utf8");
            if (result.stdoutBytes > outputBudget) {
                fail(`output exceeded ${outputBudget} bytes`, "output-limit");
                return;
            }

            result.stdout += chunk;
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
            if (childState.phase === "closed") return;

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
            if (childState.phase === "closed") return;
            if (childState.phase === "terminating") clearTimeout(childState.escalation);
            childState = { phase: "closed" };
            options.signal?.removeEventListener("abort", abort);

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
            if (code === 0 && result.phase === "pending")
                finish({ output: result.stdout, outcome: "formatted", ...diagnostics });
            else if (options.signal?.aborted === true)
                finish({ output: undefined, outcome: "cancelled", ...diagnostics });
            else finish({ output: undefined, outcome: "failed", ...diagnostics });

            release();
        });

        child.stdin.end(input);
    });
}
