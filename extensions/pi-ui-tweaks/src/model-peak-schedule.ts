// All confirmed schedules use UTC (or a fixed UTC+8), not local civil time.
export type PeakSchedule =
    | "deepseek-direct"
    | "deepseek-reseller"
    | "command"
    | "glm"
    | "qwen"
    | "ali-qwen"
    | "ali-deepseek"
    | "mimo";

export type ChinesePublicHoliday = (utcDate: string) => boolean | undefined;

function isPeak(
    schedule: PeakSchedule,
    timestamp: number,
    holiday?: ChinesePublicHoliday,
): boolean | undefined {
    const date = new Date(timestamp);
    const day = date.getUTCDay();
    const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
    if (schedule === "qwen" || schedule === "ali-qwen" || schedule === "ali-deepseek")
        return minute < 14 * 60;
    if (schedule === "mimo") return minute < 16 * 60;
    if (day === 0 || day === 6) return false;
    if (schedule === "glm") return minute >= 6 * 60 && minute < 10 * 60;

    const peakWindow = (minute >= 60 && minute < 4 * 60) || (minute >= 6 * 60 && minute < 10 * 60);
    if (!peakWindow || schedule === "deepseek-reseller" || schedule === "command")
        return peakWindow;

    const isHoliday = holiday?.(date.toISOString().slice(0, 10));
    if (isHoliday === undefined) return undefined;
    return !isHoliday;
}

/** Return no claim if the next state depends on an unknown holiday. */
export function peakCountdown(
    schedule: PeakSchedule,
    now: Date,
    holiday?: ChinesePublicHoliday,
): string | undefined {
    const timestamp = now.getTime();
    if (!Number.isFinite(timestamp)) return undefined;

    const peak = isPeak(schedule, timestamp, holiday);
    if (peak === undefined) return undefined;

    const startMinute = Math.floor(timestamp / 60_000) * 60_000;

    // Every known schedule has a transition within a week unless unknown holidays
    // intervene; a finite scan also avoids inventing a transition for bad inputs.
    for (let minute = 1; minute <= 8 * 24 * 60; minute += 1) {
        const next = startMinute + minute * 60_000;
        const nextPeak = isPeak(schedule, next, holiday);
        if (nextPeak === undefined) return undefined;
        if (nextPeak === peak) continue;

        const remaining = Math.ceil((next - timestamp) / 60_000);
        const hours = Math.floor(remaining / 60);
        const minutes = remaining % 60;
        let duration = `${minutes}m`;
        if (hours > 0) {
            duration = `${hours}h`;
            if (minutes > 0) duration += ` ${minutes}m`;
        }

        if (peak) return `peak · off-peak starts in ${duration}`;
        return `off-peak · ends in ${duration}`;
    }

    return undefined;
}
