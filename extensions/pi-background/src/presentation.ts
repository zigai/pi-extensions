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

export function commandStatus(job: CommandSnapshot): Status {
    if (job.state === "running") return { text: "running", tone: "accent" };
    if (job.state === "stopped") return { text: "stopped", tone: "dim" };
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
