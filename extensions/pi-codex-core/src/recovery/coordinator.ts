import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { defaultCodexRuntime, type Scheduler, type ScheduledTask } from "../runtime.ts";
import { compileSchema } from "../schema-parsing.ts";
import type { CodexCoreConfig } from "../config/config.ts";

export const CODEX_RECOVERY_ENTRY_TYPE = "pi-codex-core.recovery";

const RECOVERY_STATE_VERSION = 1;
const TERMINAL_ERROR_PATTERN =
    /aborted|cancel(?:led)?|context (?:length|window)|prompt (?:is )?too long|usage limit|quota|billing|insufficient[_ ]quota|authentication|unauthori[sz]ed|forbidden|invalid api key/i;
const TRANSIENT_ERROR_PATTERN =
    /websocket|network|socket|connection|timeout|timed out|overload|rate.?limit|server|service.?unavailable|upstream|bad gateway|gateway timeout|(?:http )?5\d\d/i;

const RecoveryStateSchema = compileSchema(
    Type.Object(
        {
            version: Type.Literal(RECOVERY_STATE_VERSION),
            pendingFollowUps: Type.Array(Type.String()),
            recoveryAttempt: Type.Integer({ minimum: 0 }),
            resumeAtMs: Type.Optional(Type.Number({ minimum: 0 })),
            errorMessage: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
);

type RecoveryState = ReturnType<(typeof RecoveryStateSchema)["Parse"]>;

type RecoveryCoordinatorOptions = {
    readonly getConfig: () => CodexCoreConfig;
    readonly scheduler?: Scheduler;
    readonly nowMs?: () => number;
};

/**
 * Session-scoped recovery for failures that happen after Pi exhausts its own provider retries.
 *
 * Pi does not expose queue cancellation to extensions. Holding text follow-ups before they enter
 * Pi's queue prevents one provider outage from turning every queued line into another retry cycle.
 */
export class CodexRecoveryCoordinator {
    private readonly getConfig: () => CodexCoreConfig;
    private readonly scheduler: Scheduler;
    private readonly nowMs: () => number;
    private pendingFollowUps: string[] = [];
    private recoveryAttempt = 0;
    private resumeAtMs: number | undefined;
    private errorMessage: string | undefined;
    private latestAssistant: AssistantMessage | undefined;
    private scheduledTask: ScheduledTask | undefined;
    private started = false;

    constructor(options: RecoveryCoordinatorOptions) {
        this.getConfig = options.getConfig;
        this.scheduler = options.scheduler ?? defaultCodexRuntime.scheduler;
        this.nowMs = options.nowMs ?? defaultCodexRuntime.clock.nowMs;
    }

    start(pi: ExtensionAPI, ctx: ExtensionContext): void {
        this.cancelScheduledTask();
        this.restore(ctx.sessionManager.getBranch());
        this.started = true;
        if (
            this.resumeAtMs !== undefined &&
            this.getConfig().recovery.enabled &&
            supportsInteractiveRecovery(ctx)
        ) {
            this.schedule(pi, ctx, Math.max(0, this.resumeAtMs - this.nowMs()), true);
        }
    }

    stop(): void {
        this.cancelScheduledTask();
        this.started = false;
        this.latestAssistant = undefined;
    }

    applyConfig(pi: ExtensionAPI): void {
        if (this.getConfig().recovery.enabled) return;
        this.cancelScheduledTask();
        this.resumeAtMs = undefined;
        this.errorMessage = undefined;
        this.persist(pi);
    }

    observeAssistant(message: AssistantMessage): void {
        this.latestAssistant = message;
    }

    queueFollowUp(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
        const normalized = text.trim();
        if (normalized.length === 0) return;
        this.pendingFollowUps.push(normalized);
        this.persist(pi);
        notify(
            ctx,
            `Held Codex follow-up ${this.pendingFollowUps.length}; it will be delivered with the next settled turn.`,
            "info",
        );
    }

    mergePendingIntoManualInput(pi: ExtensionAPI, text: string): string | undefined {
        if (this.pendingFollowUps.length === 0 && this.scheduledTask === undefined)
            return undefined;
        this.cancelScheduledTask();
        const pending = this.takePendingFollowUps();
        this.resetRecovery();
        this.persist(pi);
        if (pending.length === 0) return undefined;
        return formatQueuedUpdate(text, pending);
    }

    settle(pi: ExtensionAPI, ctx: ExtensionContext): void {
        const assistant = this.latestAssistant;
        this.latestAssistant = undefined;
        if (!assistant || !this.started || !this.getConfig().recovery.enabled) return;

        if (assistant.stopReason !== "error") {
            this.resetRecovery();
            if (this.pendingFollowUps.length > 0) this.schedule(pi, ctx, 0, false);
            else this.persist(pi);
            return;
        }

        if (!isTransientCodexFailure(assistant)) {
            this.cancelScheduledTask();
            this.resumeAtMs = undefined;
            this.errorMessage = undefined;
            this.persist(pi);
            if (this.pendingFollowUps.length > 0) {
                notify(
                    ctx,
                    "Codex follow-ups remain held after a non-retryable failure; your next message will include them.",
                    "warning",
                );
            }
            return;
        }

        const recovery = this.getConfig().recovery;
        if (this.recoveryAttempt >= recovery.maxAttempts) {
            this.cancelScheduledTask();
            this.resumeAtMs = undefined;
            this.errorMessage = assistant.errorMessage;
            this.persist(pi);
            notify(
                ctx,
                `Codex automatic recovery stopped after ${this.recoveryAttempt} attempt${this.recoveryAttempt === 1 ? "" : "s"}; send a message to resume with held follow-ups.`,
                "warning",
            );
            return;
        }

        this.recoveryAttempt += 1;
        this.errorMessage = assistant.errorMessage;
        const delayMs = Math.min(
            recovery.baseDelayMs * 2 ** (this.recoveryAttempt - 1),
            recovery.maxDelayMs,
        );
        notify(
            ctx,
            `Codex remains unavailable; recovery ${this.recoveryAttempt}/${recovery.maxAttempts} will resume in ${formatDelay(delayMs)}.`,
            "warning",
        );
        this.schedule(pi, ctx, delayMs, true);
    }

    private schedule(
        pi: ExtensionAPI,
        ctx: ExtensionContext,
        delayMs: number,
        interrupted: boolean,
    ): void {
        this.cancelScheduledTask();
        this.resumeAtMs = this.nowMs() + delayMs;
        this.persist(pi);
        this.scheduledTask = this.scheduler.set(delayMs, () => {
            this.scheduledTask = undefined;
            this.resumeAtMs = undefined;
            if (!ctx.isIdle()) {
                this.persist(pi);
                return;
            }
            const pending = [...this.pendingFollowUps];
            const message = interrupted
                ? formatRecoveryPrompt(pending)
                : formatQueuedFollowUps(pending);
            pi.sendUserMessage(message);
            this.pendingFollowUps.splice(0, pending.length);
            this.persist(pi);
        });
    }

    private restore(entries: readonly SessionEntry[]): void {
        this.pendingFollowUps = [];
        this.recoveryAttempt = 0;
        this.resumeAtMs = undefined;
        this.errorMessage = undefined;
        for (const entry of entries) {
            if (entry.type !== "custom" || entry.customType !== CODEX_RECOVERY_ENTRY_TYPE) continue;
            const state = RecoveryStateSchema.decode(entry.data);
            if (!state) continue;
            this.pendingFollowUps = [...state.pendingFollowUps];
            this.recoveryAttempt = state.recoveryAttempt;
            this.resumeAtMs = state.resumeAtMs;
            this.errorMessage = state.errorMessage;
        }
    }

    private persist(pi: ExtensionAPI): void {
        const state: RecoveryState = {
            version: RECOVERY_STATE_VERSION,
            pendingFollowUps: [...this.pendingFollowUps],
            recoveryAttempt: this.recoveryAttempt,
        };
        if (this.resumeAtMs !== undefined) state.resumeAtMs = this.resumeAtMs;
        if (this.errorMessage !== undefined) state.errorMessage = this.errorMessage;
        pi.appendEntry(CODEX_RECOVERY_ENTRY_TYPE, state);
    }

    private takePendingFollowUps(): string[] {
        const pending = this.pendingFollowUps;
        this.pendingFollowUps = [];
        return pending;
    }

    private resetRecovery(): void {
        this.cancelScheduledTask();
        this.recoveryAttempt = 0;
        this.resumeAtMs = undefined;
        this.errorMessage = undefined;
    }

    private cancelScheduledTask(): void {
        this.scheduledTask?.cancel();
        this.scheduledTask = undefined;
    }
}

export function isTransientCodexFailure(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) return false;
    if (TERMINAL_ERROR_PATTERN.test(message.errorMessage)) return false;
    return TRANSIENT_ERROR_PATTERN.test(message.errorMessage);
}

function formatRecoveryPrompt(pending: readonly string[]): string {
    const prefix =
        "Continue the interrupted task from the current session and filesystem state. Do not repeat completed work. Verify partial work before changing it.";
    return pending.length === 0
        ? prefix
        : `${prefix}\n\nApply these queued user updates together, in order:\n\n${formatPending(pending)}`;
}

function formatQueuedFollowUps(pending: readonly string[]): string {
    return `Address these queued user follow-ups together, in order:\n\n${formatPending(pending)}`;
}

function formatQueuedUpdate(current: string, pending: readonly string[]): string {
    return `Apply these previously queued updates together, in order:\n\n${formatPending(pending)}\n\nLatest user message:\n\n${current}`;
}

function formatPending(pending: readonly string[]): string {
    return pending.map((text, index) => `${index + 1}. ${text}`).join("\n\n");
}

function formatDelay(delayMs: number): string {
    if (delayMs < 1000) return `${delayMs}ms`;
    const seconds = Math.ceil(delayMs / 1000);
    return `${seconds}s`;
}

export function supportsInteractiveRecovery(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" || ctx.mode === "rpc";
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
}
