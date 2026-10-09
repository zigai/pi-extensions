import type { MessageUpdateEvent } from "@earendil-works/pi-coding-agent";

type OutputTokenUsage = {
    readonly output: number;
    readonly reasoning?: number;
};

export type TokenThroughputMeasurement = {
    readonly tokensPerSecond: number;
    readonly visibleOutputTokens: number;
    readonly streamDurationMs: number;
    readonly stepCount: number;
};

export type TokenThroughputUnavailableReason =
    | "no-steps"
    | "incomplete-step"
    | "no-visible-output"
    | "zero-duration";

export type TokenThroughputResult =
    | {
          readonly status: "available";
          readonly measurement: TokenThroughputMeasurement;
      }
    | {
          readonly status: "unavailable";
          readonly reason: TokenThroughputUnavailableReason;
      };

type StepState =
    | { readonly status: "idle" }
    | { readonly status: "active"; readonly startedAtMs?: number; firstOutputAtMs?: number };

type StepSample = {
    readonly visibleOutputTokens: number;
    readonly streamDurationMs: number;
};

function nonNegativeFinite(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

/** Convert Pi's inclusive output count to OpenCode's visible-output token bucket. */
export function getVisibleOutputTokens(usage: OutputTokenUsage): number {
    return Math.max(0, nonNegativeFinite(usage.output) - nonNegativeFinite(usage.reasoning));
}

/** Whether a Pi assistant stream event establishes the first provider-output boundary. */
export function isProviderOutputEvent(
    type: MessageUpdateEvent["assistantMessageEvent"]["type"],
): boolean {
    return (
        type === "text_start" ||
        type === "text_delta" ||
        type === "text_end" ||
        type === "thinking_start" ||
        type === "thinking_delta" ||
        type === "thinking_end" ||
        type === "toolcall_start" ||
        type === "toolcall_delta" ||
        type === "toolcall_end"
    );
}

/**
 * Measures visible provider output for one user turn. Tool gaps are excluded by
 * accumulating each assistant stream independently.
 */
export class TurnTokenThroughputTracker {
    private step: StepState = { status: "idle" };
    private readonly samples: StepSample[] = [];
    private hasIncompleteStep = false;

    reset(): void {
        this.step = { status: "idle" };
        this.samples.length = 0;
        this.hasIncompleteStep = false;
    }

    startStep(atMs?: number): void {
        if (this.step.status === "active") {
            this.hasIncompleteStep = true;
        }

        let startedAtMs: number | undefined;
        if (atMs !== undefined && Number.isFinite(atMs)) {
            startedAtMs = atMs;
        }

        this.step = { status: "active", startedAtMs };
    }

    markOutput(atMs: number): void {
        if (this.step.status !== "active") {
            this.hasIncompleteStep = true;
            return;
        }

        if (this.step.firstOutputAtMs !== undefined) return;

        if (!Number.isFinite(atMs)) {
            this.hasIncompleteStep = true;
            return;
        }

        this.step.firstOutputAtMs = atMs;
    }

    finishStep(endedAtMs: number, usage: OutputTokenUsage, stopReason?: string): void {
        const visibleOutputTokens = getVisibleOutputTokens(usage);
        if (this.step.status !== "active" || stopReason === "error" || stopReason === "aborted") {
            if (visibleOutputTokens > 0) {
                this.hasIncompleteStep = true;
            }

            this.samples.push({ visibleOutputTokens, streamDurationMs: 0 });

            return;
        }

        let streamDurationMs = 0;
        const stepStartMs = this.step.startedAtMs ?? this.step.firstOutputAtMs;
        if (stepStartMs === undefined) {
            if (visibleOutputTokens > 0) {
                this.hasIncompleteStep = true;
            }
        } else if (!Number.isFinite(endedAtMs) || endedAtMs < stepStartMs) {
            this.hasIncompleteStep = true;
        } else {
            streamDurationMs = endedAtMs - stepStartMs;
        }

        this.samples.push({ visibleOutputTokens, streamDurationMs });
        this.step = { status: "idle" };
    }

    result(): TokenThroughputResult {
        if (this.samples.length === 0) {
            return { status: "unavailable", reason: "no-steps" };
        }

        if (this.step.status === "active" || this.hasIncompleteStep) {
            return { status: "unavailable", reason: "incomplete-step" };
        }

        let visibleOutputTokens = 0;
        let streamDurationMs = 0;
        for (const sample of this.samples) {
            visibleOutputTokens += sample.visibleOutputTokens;
            streamDurationMs += sample.streamDurationMs;
        }

        if (visibleOutputTokens <= 0) {
            return { status: "unavailable", reason: "no-visible-output" };
        }

        if (streamDurationMs <= 0) {
            return { status: "unavailable", reason: "zero-duration" };
        }

        return {
            status: "available",
            measurement: {
                tokensPerSecond: visibleOutputTokens / (streamDurationMs / 1000),
                visibleOutputTokens,
                streamDurationMs,
                stepCount: this.samples.length,
            },
        };
    }
}
