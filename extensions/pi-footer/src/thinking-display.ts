const THINKING_FILL = new Map<string, number>([
    ["off", 0],
    ["minimal", 0],
    ["low", 1],
    ["medium", 2],
    ["high", 3],
    ["xhigh", 4],
    ["max", 5],
    ["auto", 0],
]);

/** Match OMP's five-square meter without breaking rendering for future host levels. */
export function thinkingDisplay(level: string): string {
    const filled = THINKING_FILL.get(level);
    if (filled === undefined) return level;
    return `${"■".repeat(filled)}${"□".repeat(5 - filled)} ${level}`;
}
