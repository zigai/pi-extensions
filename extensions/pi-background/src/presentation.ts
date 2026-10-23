import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

export class BackgroundView {
    private jobs: readonly CommandSnapshot[] = [];
    private readonly dismissed = new Set<string>();

    update(jobs: readonly CommandSnapshot[]): void {
        this.jobs = jobs;
    }

    dismiss(id: string): void {
        this.dismissed.add(id);
    }

    render(width: number, theme: Pick<Theme, "fg" | "bold">): string[] {
        const jobs = this.jobs.filter((job) => !this.dismissed.has(job.id));
        if (width <= 0 || jobs.length === 0) return [];

        const available = Math.max(1, width - 2);

        const lines = [
            truncateToWidth(
                `${theme.fg("accent", theme.bold("Background"))} ${theme.fg("dim", "· /background")}`,
                available,
            ),
        ];
        for (const job of jobs) {
            const status = commandStatus(job);
            const marker = theme.fg(status.tone, "●");
            const suffix = theme.fg(status.tone, status.text);
            const labelWidth = Math.max(0, available - visibleWidth(suffix) - 4);
            const label = truncateToWidth(commandLabel(job.command), labelWidth);
            const padding = " ".repeat(
                Math.max(1, available - visibleWidth(label) - visibleWidth(suffix) - 2),
            );
            lines.push(truncateToWidth(`${marker} ${label}${padding}${suffix}`, available));
        }

        return lines.map((line) => truncateToWidth(` ${line}`, width));
    }
}
