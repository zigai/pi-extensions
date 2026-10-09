import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

import { DEFAULT_RIGHT_MESSAGES_CONFIG, type RightMessagesConfig } from "./settings.ts";
import { getStatusBarSnapshot, type StatusBarSegmentSnapshot } from "./status-bar-api.ts";

const RIGHT_MESSAGES_CONFIG_KEY = Symbol.for("zigai.pi-status-bar.right-messages-config");

type RightMessageState = typeof globalThis & {
    [RIGHT_MESSAGES_CONFIG_KEY]?: RightMessagesConfig;
};

// SAFETY: This intersection only adds one optional symbol-keyed slot to the
// existing global object and does not change its runtime representation.
const rightMessageState = globalThis as RightMessageState;

type SelectedRightMessage = {
    readonly elapsedMs: number;
    readonly message: string;
};

export type RenderedRightMessage = {
    readonly text: string;
    readonly width: number;
};

function getRightMessagesConfig(): RightMessagesConfig {
    return rightMessageState[RIGHT_MESSAGES_CONFIG_KEY] ?? DEFAULT_RIGHT_MESSAGES_CONFIG;
}

export function setRightMessagesConfig(config: RightMessagesConfig): void {
    rightMessageState[RIGHT_MESSAGES_CONFIG_KEY] = config;
}

function getSafeRightMessageIntervalMs(config: RightMessagesConfig): number {
    if (Number.isFinite(config.intervalMs) && config.intervalMs > 0) return config.intervalMs;
    return DEFAULT_RIGHT_MESSAGES_CONFIG.intervalMs;
}

function getSafeScrollColumnIntervalMs(config: RightMessagesConfig): number {
    if (Number.isFinite(config.scrollColumnIntervalMs) && config.scrollColumnIntervalMs > 0) {
        return config.scrollColumnIntervalMs;
    }

    return DEFAULT_RIGHT_MESSAGES_CONFIG.scrollColumnIntervalMs;
}

function getSafeMinScrollCycles(config: RightMessagesConfig): number {
    if (Number.isFinite(config.minScrollCycles) && config.minScrollCycles > 0) {
        return config.minScrollCycles;
    }

    return DEFAULT_RIGHT_MESSAGES_CONFIG.minScrollCycles;
}

export function getRightMessageMinGap(): number {
    const config = getRightMessagesConfig();
    if (Number.isFinite(config.minGap) && config.minGap >= 0) return config.minGap;
    return DEFAULT_RIGHT_MESSAGES_CONFIG.minGap;
}

function getLongMessageCycleDurationMs(
    messageWidth: number,
    viewportWidth: number,
    config: RightMessagesConfig,
): number {
    return (Math.max(0, messageWidth - viewportWidth) + 1) * getSafeScrollColumnIntervalMs(config);
}

function getMessageDurationMs(
    message: string,
    viewportWidth: number,
    config: RightMessagesConfig,
): number {
    const intervalMs = getSafeRightMessageIntervalMs(config);
    const messageWidth = visibleWidth(message);
    if (messageWidth <= viewportWidth) return intervalMs;

    const cycleDurationMs = getLongMessageCycleDurationMs(messageWidth, viewportWidth, config);
    return (
        cycleDurationMs *
        Math.max(getSafeMinScrollCycles(config), Math.ceil(intervalMs / cycleDurationMs))
    );
}

function selectRightMessage(
    config: RightMessagesConfig,
    elapsedMs: number,
    viewportWidth: number,
): SelectedRightMessage | undefined {
    if (!config.enabled || config.messages.length === 0 || viewportWidth <= 0) {
        return undefined;
    }

    const durations = config.messages.map((message) =>
        getMessageDurationMs(message, viewportWidth, config),
    );
    const totalDurationMs = durations.reduce((total, duration) => total + duration, 0);
    if (totalDurationMs <= 0) return undefined;

    let elapsedInRotation = elapsedMs % totalDurationMs;
    for (let index = 0; index < config.messages.length; index += 1) {
        const duration = durations[index] ?? 0;
        const message = config.messages.at(index);
        if (message === undefined) continue;
        if (elapsedInRotation < duration) return { elapsedMs: elapsedInRotation, message };

        elapsedInRotation -= duration;
    }

    const message = config.messages.at(0);
    if (message === undefined) return undefined;

    return { elapsedMs: 0, message };
}

function applyRightMessageStyle(message: string, config: RightMessagesConfig): string {
    let styled = message;
    if (config.dimmed) styled = `\x1b[2m${styled}\x1b[22m`;
    if (config.italic) styled = `\x1b[3m${styled}\x1b[23m`;

    return styled;
}

function renderRightMessageSegment(
    selected: SelectedRightMessage,
    viewportWidth: number,
    config: RightMessagesConfig,
): string {
    const messageWidth = visibleWidth(selected.message);
    if (messageWidth <= viewportWidth) return selected.message;

    const cycleDurationMs = getLongMessageCycleDurationMs(messageWidth, viewportWidth, config);
    const elapsedInCycle = selected.elapsedMs % cycleDurationMs;
    const offset = Math.min(
        Math.max(0, messageWidth - viewportWidth),
        Math.floor(elapsedInCycle / getSafeScrollColumnIntervalMs(config)),
    );
    return sliceByColumn(selected.message, offset, viewportWidth);
}

function applySegmentStyle(segment: StatusBarSegmentSnapshot): string {
    let styled = segment.text;
    if (segment.dimmed) styled = `\x1b[2m${styled}\x1b[22m`;
    if (segment.italic) styled = `\x1b[3m${styled}\x1b[23m`;

    return styled;
}

function selectRightStatusSegment(): string | undefined {
    for (const segment of getStatusBarSnapshot().segments) {
        if (!segment.states.includes("active")) continue;
        return applySegmentStyle(segment);
    }

    return undefined;
}

export function renderRightMessage(
    elapsedMs: number,
    viewportWidth: number,
    color: (text: string) => string,
): RenderedRightMessage | undefined {
    const statusSegment = selectRightStatusSegment();
    if (statusSegment !== undefined) {
        const text = sliceByColumn(statusSegment, 0, viewportWidth);
        const width = visibleWidth(text);
        if (width === 0) return undefined;

        return { text: color(text), width };
    }

    const config = getRightMessagesConfig();
    const selected = selectRightMessage(config, elapsedMs, viewportWidth);
    if (selected === undefined) return undefined;

    const segment = renderRightMessageSegment(selected, viewportWidth, config);
    const width = visibleWidth(segment);
    if (width === 0) return undefined;

    return { text: color(applyRightMessageStyle(segment, config)), width };
}
