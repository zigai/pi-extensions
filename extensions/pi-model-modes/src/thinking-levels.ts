import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

function defineThinkingLevels<const Levels extends readonly ThinkingLevel[]>(
    levels: Levels & ([ThinkingLevel] extends [Levels[number]] ? unknown : never),
): Levels {
    return levels;
}

export const ALL_THINKING_LEVELS = defineThinkingLevels([
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const);

export function isThinkingLevel(value: string): value is ThinkingLevel {
    return ALL_THINKING_LEVELS.some((level) => level === value);
}

export function normalizeThinkingLevel(
    level: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
    if (level !== undefined && isThinkingLevel(level)) return level;
    return undefined;
}
