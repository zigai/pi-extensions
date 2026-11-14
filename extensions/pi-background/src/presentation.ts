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
