import type { StaticDecode } from "typebox";
import type { settingsSchema } from "./settings-input.ts";

export type TimestampFormat = StaticDecode<typeof settingsSchema>["format"];
export type TimestampValue = Date | number | string;

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function formatTime(date: Date): string {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(date: Date): string {
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).padStart(4, "0")} ${formatTime(date)}`;
}

function formatRelative(date: Date, now: Date): string {
    const difference = now.getTime() - date.getTime();
    let minutes = Math.floor(Math.abs(difference) / 60_000);
    if (minutes === 0) return "just now";

    const days = Math.floor(minutes / 1440);

    minutes %= 1440;

    const hours = Math.floor(minutes / 60);

    minutes %= 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    const duration = parts.slice(0, 2).join(" ");
    if (difference < 0) return `in ${duration}`;
    return `${duration} ago`;
}

/** Format a timestamp in the system's local time zone. Invalid dates produce no label. */
export function formatTimestamp(
    timestamp: TimestampValue,
    format: TimestampFormat = "auto",
    now: TimestampValue = Date.now(),
): string {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return "";

    if (format === "time-only") return formatTime(date);
    if (format === "date-time") return formatDateTime(date);

    const current = new Date(now);
    if (!Number.isFinite(current.getTime())) return "";
    if (format === "relative") return formatRelative(date, current);

    if (
        date.getFullYear() === current.getFullYear() &&
        date.getMonth() === current.getMonth() &&
        date.getDate() === current.getDate()
    ) {
        return formatTime(date);
    }

    return formatDateTime(date);
}
