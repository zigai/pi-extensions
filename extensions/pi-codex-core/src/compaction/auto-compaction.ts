import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { codexModelRequestProfile } from "../codex/models.ts";
import type { CodexCoreConfig } from "../config/config.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../runtime.ts";
import type {
    AgentEndCompactionMessage,
    AutoCompactionSessionState,
    ScheduleCodexAutoCompactionOptions,
} from "./types.ts";

const AUTO_COMPACTION_MIN_INTERVAL_MS = 30_000;

const autoCompactionBySession = new Map<string, AutoCompactionSessionState>();

export function scheduleCodexAutoCompaction(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    runtime: CodexRuntime = defaultCodexRuntime,
    options: ScheduleCodexAutoCompactionOptions = {},
): boolean {
    if (!config.compaction.enabled || !config.compaction.auto) return false;
    if (latestAssistantEndedWithError(options.completedMessages)) return false;
    const sessionId = ctx.sessionManager.getSessionId();
    const state = autoCompactionBySession.get(sessionId);
    if (state?.timer || state?.inFlight) return false;

    const timer = runtime.scheduler.set(0, () => {
        const latestState = autoCompactionBySession.get(sessionId);
        if (latestState?.timer === timer) {
            autoCompactionBySession.set(sessionId, { ...latestState, timer: undefined });
        }
        maybeTriggerCodexAutoCompaction(ctx, config, runtime);
    });

    autoCompactionBySession.set(sessionId, {
        lastTriggeredEntryId: state?.lastTriggeredEntryId,
        lastTriggeredAt: state?.lastTriggeredAt ?? 0,
        inFlight: state?.inFlight ?? false,
        timer,
    });
    return true;
}

export function cancelAutoCompactionState(): void {
    for (const state of autoCompactionBySession.values()) {
        if (state.timer) state.timer.cancel();
    }
    autoCompactionBySession.clear();
}

export function clearAutoCompactionSessionState(sessionId: string): void {
    const state = autoCompactionBySession.get(sessionId);
    state?.timer?.cancel();
    autoCompactionBySession.delete(sessionId);
}

function latestAssistantEndedWithError(
    messages: readonly AgentEndCompactionMessage[] | undefined,
): boolean {
    if (messages === undefined) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "assistant") return message.stopReason === "error";
    }
    return false;
}

export function maybeTriggerCodexAutoCompaction(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    runtime: CodexRuntime = defaultCodexRuntime,
): boolean {
    if (!config.compaction.enabled || !config.compaction.auto) return false;
    if (!ctx.isIdle()) return false;
    const usage = ctx.getContextUsage();
    if (!usage) return false;
    const effectiveContextWindow = codexModelRequestProfile(ctx.model?.id)?.effectiveContextWindow;
    const usagePercent =
        effectiveContextWindow && usage.tokens !== null
            ? (usage.tokens / effectiveContextWindow) * 100
            : usage.percent;
    if (usagePercent === null || usagePercent < config.compaction.thresholdPercent) return false;

    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const latestEntryId = branch.at(-1)?.id;
    const state = autoCompactionBySession.get(sessionId);
    const now = runtime.clock.nowMs();
    if (state?.inFlight) return false;
    if (state?.lastTriggeredEntryId === latestEntryId) return false;
    if (state && now - state.lastTriggeredAt < AUTO_COMPACTION_MIN_INTERVAL_MS) return false;

    autoCompactionBySession.set(sessionId, {
        lastTriggeredEntryId: latestEntryId,
        lastTriggeredAt: now,
        inFlight: true,
        timer: state?.timer,
    });
    try {
        ctx.compact({
            onComplete: () => finishAutoCompaction(sessionId),
            onError: () => finishAutoCompaction(sessionId),
        });
        return true;
    } catch {
        finishAutoCompaction(sessionId);
        return false;
    }
}

function finishAutoCompaction(sessionId: string): void {
    const state = autoCompactionBySession.get(sessionId);
    if (!state) return;
    autoCompactionBySession.set(sessionId, { ...state, inFlight: false });
}
