import type {
    ExtensionAPI,
    ExtensionContext,
    MessageStartEvent,
    MessageUpdateEvent,
    MessageEndEvent,
    ExtensionEvent,
} from "@earendil-works/pi-coding-agent";

import { installLoaderPatch, setStatusBarRunTimer } from "./loader-patch.ts";
import { setRightMessagesConfig } from "./right-message.ts";
import {
    DEFAULT_RIGHT_MESSAGES_CONFIG,
    loadStatusBarSettings,
    type LoadedStatusBarConfig,
} from "./settings.ts";
import { setStatusBarBaseConfig, subscribeStatusBarUpdates } from "./status-bar-api.ts";
import { isProviderOutputEvent, TurnTokenThroughputTracker } from "./token-throughput.ts";
import {
    clearWorkedForWidget,
    formatDuration,
    getWorkedForStateFromBranch,
    resetWorkedForWidgetCache,
    setWorkedForWidget,
    WORKED_FOR_STATE_ENTRY,
    type WorkedForState,
    type WorkedForWidgetContext,
} from "./worked-for-widget.ts";

type StatusBarContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted" | "isIdle" | "hasUI"> &
    WorkedForWidgetContext & {
        readonly sessionManager: Parameters<
            typeof getWorkedForStateFromBranch
        >[0]["sessionManager"];

        readonly ui: WorkedForWidgetContext["ui"] & Pick<ExtensionContext["ui"], "notify">;
    };

type StatusBarMessage = Pick<MessageStartEvent["message"], "role">;

type StatusBarEndMessage =
    | (Pick<Extract<MessageEndEvent["message"], { role: "assistant" }>, "role"> & {
          readonly stopReason?: string;

          readonly usage: Pick<
              Extract<MessageEndEvent["message"], { role: "assistant" }>["usage"],
              "output" | "reasoning"
          >;
      })
    | { readonly role: Exclude<StatusBarMessage["role"], "assistant"> };

const reportedConfigErrors = new Set<string>();

function reportConfigErrors(ctx: StatusBarContext, loaded: LoadedStatusBarConfig): void {
    for (const error of loaded.errors) {
        if (reportedConfigErrors.has(error)) continue;
        reportedConfigErrors.add(error);
        ctx.ui.notify(`[pi-status-bar] ${error}`, "error");
    }
}

function applyStatusBarResolvedConfig(ctx: StatusBarContext): void {
    const loaded = loadStatusBarSettings(ctx.cwd, ctx.isProjectTrusted());
    setStatusBarBaseConfig(loaded.config.statusBar);
    setRightMessagesConfig(loaded.config.rightMessages);
    reportConfigErrors(ctx, loaded);
}

export function createStatusBarLifecycle(appendState: (state: WorkedForState) => void) {
    const deactivateLoaderPatch = installLoaderPatch();
    let runStartedAt: number | undefined;
    const throughput = new TurnTokenThroughputTracker();
    let idleWidgetContext: StatusBarContext | undefined;
    let idleWorkedForText: string | undefined;
    let idleTokensPerSecond: number | undefined;
    let agentRunning = false;

    function restoreWorkedForState(ctx: StatusBarContext): void {
        const state = getWorkedForStateFromBranch(ctx);
        if (state === undefined) {
            idleWorkedForText = undefined;
            idleTokensPerSecond = undefined;
            return;
        }

        idleWorkedForText = formatDuration(state.durationMs);
        idleTokensPerSecond = state.tokensPerSecond;
    }

    const unsubscribeStatusBarUpdates = subscribeStatusBarUpdates(() => {
        if (agentRunning || idleWidgetContext === undefined) return;

        setWorkedForWidget(idleWidgetContext, idleWorkedForText, idleTokensPerSecond);
    });

    async function session_start(_event: Pick<ExtensionEvent, "type">, ctx: StatusBarContext) {
        applyStatusBarResolvedConfig(ctx);
        runStartedAt = undefined;
        setStatusBarRunTimer(undefined);
        throughput.reset();
        agentRunning = false;
        idleWidgetContext = ctx;
        resetWorkedForWidgetCache();
        restoreWorkedForState(ctx);
        setWorkedForWidget(ctx, idleWorkedForText, idleTokensPerSecond);
    }

    async function session_tree(_event: Pick<ExtensionEvent, "type">, ctx: StatusBarContext) {
        if (agentRunning) return;

        idleWidgetContext = ctx;
        restoreWorkedForState(ctx);
        setWorkedForWidget(ctx, idleWorkedForText, idleTokensPerSecond);
    }

    async function agent_start(_event: Pick<ExtensionEvent, "type">, ctx: StatusBarContext) {
        if (runStartedAt === undefined) {
            runStartedAt = performance.now();
            setStatusBarRunTimer(Date.now());
            throughput.reset();
            idleWorkedForText = undefined;
            idleTokensPerSecond = undefined;
        }

        agentRunning = true;
        idleWidgetContext = ctx;
        clearWorkedForWidget(ctx);
    }

    async function message_start(event: { readonly message: StatusBarMessage }) {
        if (event.message.role === "user") {
            throughput.reset();
            return;
        }

        if (event.message.role === "assistant") {
            throughput.startStep(performance.now());
        }
    }

    async function message_update(event: {
        readonly message: StatusBarMessage;
        readonly assistantMessageEvent: Pick<MessageUpdateEvent["assistantMessageEvent"], "type">;
    }) {
        if (event.message.role !== "assistant") return;
        if (!isProviderOutputEvent(event.assistantMessageEvent.type)) return;

        throughput.markOutput(performance.now());
    }

    async function message_end(event: { readonly message: StatusBarEndMessage }) {
        if (event.message.role !== "assistant") return;

        throughput.finishStep(performance.now(), event.message.usage, event.message.stopReason);
    }

    async function agent_settled(_event: Pick<ExtensionEvent, "type">, ctx: StatusBarContext) {
        if (runStartedAt === undefined || !ctx.isIdle()) return;

        const duration = Math.max(0, performance.now() - runStartedAt);
        const throughputResult = throughput.result();
        let tokensPerSecond: number | undefined;
        if (throughputResult.status === "available") {
            tokensPerSecond = throughputResult.measurement.tokensPerSecond;
        }

        runStartedAt = undefined;
        setStatusBarRunTimer(undefined);
        agentRunning = false;
        idleWidgetContext = ctx;
        idleWorkedForText = formatDuration(duration);
        idleTokensPerSecond = tokensPerSecond;

        const workedForState: WorkedForState = { durationMs: duration, tokensPerSecond };
        appendState(workedForState);
        setWorkedForWidget(ctx, idleWorkedForText, idleTokensPerSecond);
    }

    async function session_shutdown(_event: Pick<ExtensionEvent, "type">, ctx: StatusBarContext) {
        runStartedAt = undefined;
        setStatusBarRunTimer(undefined);
        throughput.reset();
        agentRunning = false;
        idleWidgetContext = undefined;
        idleWorkedForText = undefined;
        idleTokensPerSecond = undefined;
        setRightMessagesConfig(DEFAULT_RIGHT_MESSAGES_CONFIG);
        clearWorkedForWidget(ctx);
        unsubscribeStatusBarUpdates();
        deactivateLoaderPatch();
    }

    return {
        session_start,
        session_tree,
        agent_start,
        message_start,
        message_update,
        message_end,
        agent_settled,
        session_shutdown,
    };
}

export default function statusBarExtension(pi: Pick<ExtensionAPI, "on" | "appendEntry">): void {
    const handlers = createStatusBarLifecycle((state) =>
        pi.appendEntry(WORKED_FOR_STATE_ENTRY, state),
    );
    pi.on("session_start", handlers.session_start);
    pi.on("session_tree", handlers.session_tree);
    pi.on("agent_start", handlers.agent_start);
    pi.on("message_start", handlers.message_start);
    pi.on("message_update", handlers.message_update);
    pi.on("message_end", handlers.message_end);
    pi.on("agent_settled", handlers.agent_settled);
    pi.on("session_shutdown", handlers.session_shutdown);
}
