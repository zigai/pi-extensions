import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { formatDuration, type MonitorNotification, type MonitorSnapshot } from "./monitors.ts";

export type Tone = "accent" | "success" | "error" | "dim";

export type MonitorStatus = {
    readonly text: string;
    readonly tone: Tone;
};

function escapeXml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
    return escapeXml(value).replaceAll('"', "&quot;");
}

export function plainText(value: string): string {
    return stripTerminalSequences(value).replace(/\p{Cc}/gu, (character) => {
        if (character === "\n" || character === "\t") return character;
        return " ";
    });
}

export function sourceLabel(monitor: Pick<MonitorSnapshot, "source">): string {
    if (monitor.source.kind === "websocket") return monitor.source.url;
    return plainText(monitor.source.command).replace(/\s+/gu, " ").trim();
}

export function monitorStatus(monitor: Pick<MonitorSnapshot, "state" | "exitCode">): MonitorStatus {
    if (monitor.state === "running") return { text: "watching", tone: "accent" };
    if (monitor.state === "ended") return { text: "ended", tone: "success" };
    if (monitor.state === "stopped") return { text: "stopped", tone: "dim" };
    if (monitor.state === "expired") return { text: "expired", tone: "dim" };
    if (monitor.state === "flooded") return { text: "stopped: too much output", tone: "error" };
    if (monitor.exitCode !== null)
        return { text: `failed (exit ${monitor.exitCode})`, tone: "error" };

    return { text: "failed", tone: "error" };
}

export function runningMonitorsStatus(monitors: readonly MonitorSnapshot[]): string {
    const count = monitors.filter((monitor) => monitor.state === "running").length;
    if (count === 0) return "";
    if (count === 1) return "1 monitor";
    return `${count} monitors`;
}

/** Text the agent reads for an event or end notice; tags separate source output from instructions. */
export function notificationContent(notification: MonitorNotification): string {
    const { monitor } = notification;

    const lines = [
        `<monitor-notification id="${escapeAttribute(monitor.id)}" status="${monitor.state}">`,
        `<summary>${escapeXml(notification.summary)}</summary>`,
    ];
    if (notification.kind === "end")
        lines.push(`<output-file>${escapeXml(monitor.outputPath)}</output-file>`);

    if (notification.text.length > 0) lines.push(`<event>${escapeXml(notification.text)}</event>`);
    lines.push("</monitor-notification>");

    return lines.join("\n");
}

export function describeMonitor(monitor: MonitorSnapshot, now: number): string {
    const lines = [
        `Monitor ${monitor.id} ("${monitor.description}"): ${monitorStatus(monitor).text}`,
    ];
    if (monitor.source.kind === "command") {
        lines.push(`Command: ${sourceLabel(monitor)}`, `Directory: ${monitor.source.cwd}`);
    } else {
        lines.push(`WebSocket: ${monitor.source.url}`);
    }

    lines.push(`Events delivered: ${monitor.eventCount}`);

    if (monitor.state === "running") {
        const remaining = monitor.startedAt + monitor.timeoutSeconds * 1_000 - now;
        lines.push(
            `Running for ${formatDuration(now - monitor.startedAt)}; expires in ${formatDuration(remaining)}.`,
        );
    } else if (monitor.endedAt !== null) {
        lines.push(`Ran for ${formatDuration(monitor.endedAt - monitor.startedAt)}.`);
    }

    lines.push(`Output: ${monitor.outputPath}`);

    return lines.join("\n");
}

export function startedText(monitor: MonitorSnapshot): string {
    return [
        `Monitor started (${monitor.id}, expires in ${formatDuration(monitor.timeoutSeconds * 1_000)} unless the source ends first; you get one notice at expiry. Start it again if you still need the watch).`,
        "Each event arrives as a message. Keep working; do not poll or sleep. If only waiting is left, end your turn: the next event starts a new one.",
        "Events can arrive while you wait for the user. An event is not the user's reply.",
        `Output file (stdout and stderr): ${monitor.outputPath}`,
    ].join("\n");
}
