import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { CommandSnapshot } from "./commands.ts";

type Status = {
    readonly text: string;
    readonly tone: "accent" | "success" | "error" | "dim";
};

export function plainOutput(value: string): string {
    return stripTerminalSequences(value).replace(/\p{Cc}/gu, (character) => {
        if (character === "\n" || character === "\t") return character;
        return " ";
    });
}

export function commandLabel(command: string): string {
    return plainOutput(command).replace(/\s+/gu, " ").trim();
}

const SETUP_COMMAND = /^(?:set|export|cd|source|\.|unset|trap)(?:\s|$)/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

const LAUNCHERS = new Set([
    "python",
    "python3",
    "node",
    "bash",
    "sh",
    "uv",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "cargo",
    "go",
    "git",
    "just",
    "make",
]);

const SCRIPT_RUNNERS = new Set(["run", "exec", "x"]);

function baseName(word: string): string {
    return (
        word
            .replace(/^["']|["']$/gu, "")
            .split("/")
            .at(-1) ?? word
    );
}

/** Short job name: the program that does the work, without shell setup statements. */
export function commandName(command: string): string {
    const statements = plainOutput(command)
        .split(/\n|;|&&|\|\|/u)
        .map((statement) => {
            const words = statement.trim().split(/\s+/u);
            const start = words.findIndex((word) => !ASSIGNMENT.test(word));
            if (start < 0) return [];
            return words.slice(start).filter((word) => word.length > 0);
        })
        .filter((words) => words.length > 0);
    const main =
        statements.find((words) => !SETUP_COMMAND.test(words.join(" "))) ?? statements.at(0);
    if (main === undefined) return "command";

    const [first = "command", ...words] = main;
    const program = baseName(first);
    if (!LAUNCHERS.has(program)) return program;

    const targets = words.filter((word) => !word.startsWith("-"));
    const target = targets.at(0);
    const script = targets.at(1);

    if (target === undefined) return program;
    if (SCRIPT_RUNNERS.has(target) && script !== undefined)
        return `${program} ${target} ${baseName(script)}`;

    return `${program} ${baseName(target)}`;
}

export function commandStatus(job: Pick<CommandSnapshot, "state" | "exitCode">): Status {
    if (job.state === "running") return { text: "running", tone: "accent" };
    if (job.state === "stopped") return { text: "stopped", tone: "dim" };
    if (job.state === "timed_out") return { text: "timed out", tone: "error" };
    if (job.state === "failed") return { text: "failed", tone: "error" };
    if (job.exitCode === 0) return { text: "done", tone: "success" };

    return { text: `exit ${job.exitCode}`, tone: "error" };
}

export function runningShellStatus(jobs: readonly CommandSnapshot[]): string {
    const count = jobs.filter((job) => job.state === "running").length;
    if (count === 0) return "";
    if (count === 1) return "1 shell running";
    return `${count} shells running`;
}

export function formatDuration(milliseconds: number): string {
    const total = Math.max(0, Math.round(milliseconds / 1_000));
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;

    if (hours > 0) {
        if (minutes > 0) return `${hours}h ${minutes}m`;
        return `${hours}h`;
    }

    if (minutes > 0) {
        if (seconds > 0) return `${minutes}m ${seconds}s`;
        return `${minutes}m`;
    }

    return `${seconds}s`;
}

export function commandTiming(job: CommandSnapshot, now: number): string {
    if (job.state === "timed_out" && job.timeoutSeconds !== null)
        return `Stopped at its ${formatDuration(job.timeoutSeconds * 1_000)} timeout.`;
    if (job.endedAt !== null) return `Ran for ${formatDuration(job.endedAt - job.startedAt)}.`;

    let silence = "no output yet";
    if (job.lastOutputAt !== null)
        silence = `last output ${formatDuration(now - job.lastOutputAt)} ago`;

    let deadline = "runs until stopped";
    if (job.timeoutSeconds !== null) {
        const remaining = job.startedAt + job.timeoutSeconds * 1_000 - now;
        deadline = `stopped in ${formatDuration(remaining)} unless it finishes`;
    }

    return `Running for ${formatDuration(now - job.startedAt)}; ${silence}; ${deadline}.`;
}

/** Mark drawn before a job name, matching the status tone. */
export function statusMark(job: Pick<CommandSnapshot, "state" | "exitCode">): string {
    const { tone } = commandStatus(job);
    if (tone === "success") return "✓";
    if (tone === "error") return "✗";
    if (tone === "dim") return "■";
    return "▷";
}

/** Status shown after a job name, such as `exit 1 · 4s`. */
export function outcomeText(
    job: Pick<CommandSnapshot, "state" | "exitCode" | "startedAt" | "endedAt">,
): string {
    const { text } = commandStatus(job);
    if (job.endedAt === null) return text;
    return `${text} · ${formatDuration(job.endedAt - job.startedAt)}`;
}
