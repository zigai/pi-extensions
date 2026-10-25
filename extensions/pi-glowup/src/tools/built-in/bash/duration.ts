/** Formats a finished call duration as `4.27s` below one minute and `1m 30s` or `1h 2m 5s` above. */
export function formatCallDuration(durationMs: number | undefined): string | undefined {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
        return undefined;
    }

    const preciseSeconds = (durationMs / 1000).toFixed(2);
    if (Number(preciseSeconds) < 60) return `${preciseSeconds}s`;

    // 59.996s rounds to 60.00s above, so it must not floor back to 59s here.
    const totalSeconds = Math.max(60, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;

    return `${minutes}m ${seconds}s`;
}
