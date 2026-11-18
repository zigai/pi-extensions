import { stripTerminalSequences } from "@earendil-works/pi-tui";

export const BATCH_WINDOW_MS = 200;
export const MAX_LINE_LENGTH = 500;
export const MAX_EVENT_LENGTH = 3_000;
export const MAX_BUFFERED_LENGTH = 1024 * 1024;
export const EVENT_BURST = 10;
export const EVENT_REFILL_MS = 2_000;
export const FLOOD_STOP_MS = 30_000;
export const FLOOD_QUIET_MS = 3 * EVENT_REFILL_MS;

export type EventStreamOptions = {
    /** Receives one rate-limited event: the lines that arrived within one batch window. */
    readonly onEvent: (text: string) => void;

    /** Called once when output stays over the rate limit long enough to stop the source. */
    readonly onFlood: (notice: string) => void;
};

function normalizeLine(line: string): string | undefined {
    const plain = stripTerminalSequences(line)
        .replace(/\p{Cc}/gu, (character) => {
            if (character === "\t") return character;
            return "";
        })
        .trim();
    if (plain.length === 0) return undefined;
    if (plain.length <= MAX_LINE_LENGTH) return plain;
    return `${plain.slice(0, MAX_LINE_LENGTH)}...(truncated)`;
}

function joinLines(lines: readonly string[]): string {
    const text = lines.join("\n");
    if (text.length <= MAX_EVENT_LENGTH) return text;
    return `${text.slice(0, MAX_EVENT_LENGTH)}\n...(truncated)`;
}

function seconds(milliseconds: number): number {
    return Math.round(milliseconds / 1_000);
}

/**
 * Turns a text stream into events. Lines that arrive within one window after the first form one
 * event. Events spend tokens from a bucket; events without a token are dropped and counted, and a
 * source that keeps overflowing is reported as a flood.
 */
export class EventStream {
    private readonly onEvent: (text: string) => void;
    private readonly onFlood: (notice: string) => void;
    private partial = "";
    private pending: string[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private tokens = EVENT_BURST;
    private refilledAt: number;
    private suppressed = 0;
    private floodStartedAt: number | undefined;
    private floodSuppressed = 0;
    private lastBatchAt: number | undefined;
    private delivered = 0;
    private lines = 0;
    private closed = false;

    constructor(options: EventStreamOptions) {
        this.onEvent = options.onEvent;
        this.onFlood = options.onFlood;
        this.refilledAt = Date.now();
    }

    get eventCount(): number {
        return this.delivered;
    }

    /** Non-blank lines received so far, delivered or not. */
    get lineCount(): number {
        return this.lines;
    }

    push(chunk: string): void {
        if (this.closed) return;

        let text = this.partial + chunk;
        const lines = text.split("\n");
        text = lines.pop() ?? "";
        if (text.length > MAX_BUFFERED_LENGTH) text = text.slice(-MAX_BUFFERED_LENGTH);
        this.partial = text;

        for (const line of lines) this.add(line);
    }

    /** Pushes one message as its own lines, ending any partial line before it. */
    pushMessage(message: string): void {
        this.push(`\n${message}\n`);
    }

    /** Stops batching and returns lines that have not been delivered, including a partial line. */
    drain(): string {
        if (this.closed) return "";

        this.closed = true;
        clearTimeout(this.timer);
        this.timer = undefined;

        const last = normalizeLine(this.partial);

        this.partial = "";
        if (last !== undefined) {
            this.lines += 1;
            this.pending.push(last);
        }

        const lines = this.pending;
        this.pending = [];

        if (lines.length === 0) return "";
        return joinLines(lines);
    }

    private add(line: string): void {
        const normalized = normalizeLine(line);
        if (normalized === undefined) return;

        this.lines += 1;
        this.pending.push(normalized);

        if (this.timer !== undefined) return;

        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, BATCH_WINDOW_MS);
    }

    private flush(): void {
        if (this.closed || this.pending.length === 0) return;

        const text = joinLines(this.pending);

        this.pending = [];

        const now = Date.now();
        this.refill(now);

        // A flood ends only after a quiet gap or a full bucket, so the single events that
        // refills let through do not hide a source that stays over the rate.
        const quiet = this.lastBatchAt === undefined || now - this.lastBatchAt > FLOOD_QUIET_MS;
        if (quiet || this.tokens === EVENT_BURST) {
            this.floodStartedAt = undefined;
            this.floodSuppressed = 0;
        }
        this.lastBatchAt = now;

        if (this.tokens >= 1) {
            this.tokens -= 1;
            this.delivered += 1;

            let event = text;
            if (this.suppressed > 0) {
                event = `[${this.suppressed} events suppressed: output rate too high. Consider stopping this monitor and restarting it with a more selective filter.]\n${text}`;
            }

            this.suppressed = 0;
            this.onEvent(event);

            return;
        }

        this.suppressed += 1;
        this.floodSuppressed += 1;
        this.floodStartedAt ??= now;

        const duration = now - this.floodStartedAt;
        if (duration < FLOOD_STOP_MS) return;

        this.closed = true;
        this.partial = "";
        this.onFlood(
            `[Monitor stopped: too much output (${this.floodSuppressed} events suppressed over ${seconds(duration)}s). Restart it with a more selective source.]`,
        );
    }

    private refill(now: number): void {
        const earned = Math.floor((now - this.refilledAt) / EVENT_REFILL_MS);
        if (earned <= 0) return;

        this.tokens = Math.min(EVENT_BURST, this.tokens + earned);
        this.refilledAt += earned * EVENT_REFILL_MS;
        if (this.tokens === EVENT_BURST) this.refilledAt = now;
    }
}
