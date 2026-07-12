import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CodexCoreConfig } from "../config/config.ts";
import { defaultCodexRuntime, type CodexRuntime } from "../runtime.ts";
import type {
    AgentEndCompactionMessage,
    AutoCompactionSessionState,
    ScheduleCodexAutoCompactionOptions,
} from "./types.ts";

const autoCompactionBySession = new Map<string, AutoCompactionSessionState>();

export function scheduleCodexAutoCompaction(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    runtime: CodexRuntime = defaultCodexRuntime,
    options: ScheduleCodexAutoCompactionOptions = {},
): boolean {
    if (!config.compaction.enabled || !config.compaction.auto) return false;
    const sessionId = ctx.sessionManager.getSessionId();
    const latestEntryId = ctx.sessionManager.getBranch().at(-1)?.id;
    const state = autoCompactionBySession.get(sessionId);
    if (latestAssistantWasInterrupted(options.completedMessages)) {
        state?.timer?.cancel();
        autoCompactionBySession.set(sessionId, {
            lastTriggeredEntryId: state?.lastTriggeredEntryId,
            blockedEntryId: latestEntryId,
            inFlight: state?.inFlight ?? false,
        });
        return false;
    }
    if (state?.blockedEntryId === latestEntryId) return false;
    if (state?.timer || state?.inFlight) return false;

    const timer = runtime.scheduler.set(0, () => {
        const latestState = autoCompactionBySession.get(sessionId);
        if (latestState?.timer === timer) {
            autoCompactionBySession.set(sessionId, { ...latestState, timer: undefined });
        }
        try {
            maybeTriggerCodexAutoCompaction(ctx, config, runtime);
        } catch {
            clearAutoCompactionSessionState(sessionId);
        }
    });

    autoCompactionBySession.set(sessionId, {
        lastTriggeredEntryId: state?.lastTriggeredEntryId,
        blockedEntryId: state?.blockedEntryId,
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

function latestAssistantWasInterrupted(
    messages: readonly AgentEndCompactionMessage[] | undefined,
): boolean {
    if (messages === undefined) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === "assistant") {
            return message.stopReason === "error" || message.stopReason === "aborted";
        }
    }
    return false;
}

export function maybeTriggerCodexAutoCompaction(
    ctx: ExtensionContext,
    config: CodexCoreConfig,
    _runtime: CodexRuntime = defaultCodexRuntime,
): boolean {
    if (!config.compaction.enabled || !config.compaction.auto) return false;
    if (!ctx.isIdle()) return false;
    const usage = ctx.getContextUsage();
    if (!usage) return false;
    const usagePercent = usage.percent;
    if (usagePercent === null || usagePercent < config.compaction.thresholdPercent) return false;

    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    const latestEntry = branch.at(-1);
    if (latestEntry?.type === "compaction") return false;
    const latestEntryId = latestEntry?.id;
    const state = autoCompactionBySession.get(sessionId);
    if (state?.inFlight) return false;
    if (state?.blockedEntryId === latestEntryId) return false;
    if (state?.lastTriggeredEntryId === latestEntryId) return false;

    autoCompactionBySession.set(sessionId, {
        lastTriggeredEntryId: latestEntryId,
        blockedEntryId: state?.blockedEntryId,
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
