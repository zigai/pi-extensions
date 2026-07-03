import { spawn } from "node:child_process";
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

function reportFormatterWarning(options: ScriptFormatterParseOptions, message: string): void {
  options.reportWarning?.(`[pi-codex-look] ${message}`);
}

function formatterSource(options: ScriptFormatterParseOptions): string {
  return options.source ?? "script formatter config";
}

function isFormatterCommand(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
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
    const child = spawn(executable, [...args], {
      shell: false,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill();
      finishFormatterCommand(resolve, undefined, state, timeout);
    }, FORMATTER_TIMEOUT_MS);

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

    const [executable, ...args] = command;
    if (executable === undefined) {
      return undefined;
    }

    const output = await runFormatterCommand(executable, args, input.code, options);
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
  const code = await formatter?.(
    {
      label: invocation.label,
      language: invocation.language,
      code: invocation.code,
    },
    options,
  );

  if (code === undefined) {
    return invocation;
  }

  return { ...invocation, code };
}
