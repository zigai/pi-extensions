import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { preparePickerPayload } from "./picker-request.ts";
import {
    formatPickerModelReference,
    loadAutonameSessionSettings,
    type ExtensionSettings,
    type PickerModelReference,
} from "./settings.ts";
import {
    AUTONAME_STATE_ENTRY_TYPE,
    buildConversationContext,
    buildRepositoryContext,
    createSessionNamingState,
    getNamingRequest,
    hasReachedTrigger,
    isOpaqueNamingPrompt,
    markSessionNamingComplete,
    measureSession,
    normalizeSessionName,
    parseStoredSessionNamingState,
    renderNamingPrompt,
    type NamingPhase,
    type SessionMetrics,
    type SessionNamingState,
    type StoredSessionNamingStateResult,
} from "./session-naming.ts";

/** Outcome of a picker attempt, classified so the caller can apply policy. */
type PickSessionNameOutcome =
    | { readonly type: "picked"; readonly name: string }
    | { readonly type: "cancelled" }
    | { readonly type: "modelUnavailable"; readonly diagnostic: string }
    | { readonly type: "authenticationUnavailable"; readonly diagnostic: string }
    | { readonly type: "requestFailed"; readonly diagnostic: string }
    | { readonly type: "timeout"; readonly diagnostic: string }
    | { readonly type: "invalidOutput"; readonly diagnostic: string };

type ActiveNamingAttempt = {
    readonly controller: AbortController;
    readonly sessionGeneration: number;
    readonly nameRevision: number;
    readonly nameAtStart: string | undefined;
    readonly leafIdAtStart: string | null;
};

type PickSessionNameOptions = {
    readonly settings: ExtensionSettings;
    readonly phase: NamingPhase;
    readonly entries: readonly SessionEntry[];
    readonly pendingPrompt: string | undefined;
    readonly ctx: ExtensionContext;
    readonly signal: AbortSignal;
    readonly repositoryContext: string;
};

type NamingCheckpoint =
    | { readonly type: "prompt"; readonly prompt: string }
    | { readonly type: "settled" };

type AuthenticationResolution =
    | {
          readonly type: "resolved";

          readonly auth: Awaited<
              ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>
          >;
      }
    | { readonly type: "cancelled" }
    | { readonly type: "failed" };

type RestoredNamingState = {
    readonly state: SessionNamingState;
    readonly storedStateIssue: "invalid" | "unsupportedVersion" | undefined;
};

function resolvePickerModel(
    reference: PickerModelReference,
    ctx: ExtensionContext,
): Model<Api> | undefined {
    if (reference.type === "current") {
        if (ctx.model === undefined) {
            return undefined;
        }

        return ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
    }

    return ctx.modelRegistry.find(reference.provider, reference.id);
}

/**
 * Inspect the latest stored naming state on the active branch. The newest
 * matching entry owns recovery: invalid or future-version state is surfaced
 * instead of silently reviving an older baseline.
 */
function maybeFindStoredNamingState(
    entries: readonly SessionEntry[],
): StoredSessionNamingStateResult | { readonly type: "notFound" } {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== AUTONAME_STATE_ENTRY_TYPE) {
            continue;
        }

        return parseStoredSessionNamingState(entry.data);
    }

    return { type: "notFound" };
}

function createZeroMetrics(): SessionMetrics {
    return {
        messages: 0,
        turns: 0,
        toolCalls: 0,
        tokens: 0,
    };
}

function timeoutDiagnostic(timeoutMs: number): string {
    const seconds = timeoutMs / 1000;
    return `Session naming timed out after ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

function restoreNamingState(
    entries: readonly SessionEntry[],
    currentName: string | undefined,
    missingStateBaseline: "current" | "zero",
    nowMs: number,
): RestoredNamingState {
    const currentMetrics = measureSession(entries);
    const stored = maybeFindStoredNamingState(entries);
    if (stored.type === "found") {
        if (stored.state.initialNameSet === (currentName !== undefined)) {
            return { state: stored.state, storedStateIssue: undefined };
        }

        return {
            state: createSessionNamingState({
                initialNameSet: currentName !== undefined,
                baseline: currentMetrics,
                baselineAtMs: nowMs,
            }),
            storedStateIssue: undefined,
        };
    }

    const baseline =
        currentName !== undefined || missingStateBaseline === "current"
            ? currentMetrics
            : createZeroMetrics();

    return {
        state: createSessionNamingState({
            initialNameSet: currentName !== undefined,
            baseline,
            baselineAtMs: nowMs,
        }),
        storedStateIssue:
            stored.type === "invalid" || stored.type === "unsupportedVersion"
                ? stored.type
                : undefined,
    };
}

/**
 * Wait for Pi's non-cancellable authentication lookup within the caller's
 * cancellation lifetime. The late dependency promise remains observed so a
 * post-cancellation rejection cannot become unhandled.
 */
async function resolveAuthentication(
    ctx: ExtensionContext,
    model: Model<Api>,
    signal: AbortSignal,
): Promise<AuthenticationResolution> {
    if (signal.aborted) {
        return { type: "cancelled" };
    }

    return new Promise((resolve) => {
        let completed = false;
        const handleAbort = (): void => {
            if (completed) {
                return;
            }

            completed = true;
            resolve({ type: "cancelled" });
        };

        const finish = (resolution: AuthenticationResolution): void => {
            if (completed) {
                return;
            }

            completed = true;
            signal.removeEventListener("abort", handleAbort);
            resolve(resolution);
        };

        signal.addEventListener("abort", handleAbort, { once: true });

        let authenticationPromise: ReturnType<
            ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]
        >;

        try {
            authenticationPromise = ctx.modelRegistry.getApiKeyAndHeaders(model);
        } catch {
            finish({ type: "failed" });
            return;
        }

        void authenticationPromise.then(
            (auth) => finish({ type: "resolved", auth }),
            () => finish({ type: "failed" }),
        );
    });
}

async function pickSessionName(options: PickSessionNameOptions): Promise<PickSessionNameOutcome> {
    const { settings, phase, entries, pendingPrompt, ctx, signal, repositoryContext } = options;
    const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
    const operationSignal = AbortSignal.any([signal, timeoutSignal]);
    const model = resolvePickerModel(settings.model, ctx);
    if (model === undefined) {
        return {
            type: "modelUnavailable",
            diagnostic: `Session naming skipped: picker model "${formatPickerModelReference(settings.model)}" is not available.`,
        };
    }

    const authentication = await resolveAuthentication(ctx, model, operationSignal);
    if (authentication.type === "cancelled") {
        return timeoutSignal.aborted
            ? { type: "timeout", diagnostic: timeoutDiagnostic(settings.timeoutMs) }
            : { type: "cancelled" };
    }

    if (authentication.type === "failed") {
        return {
            type: "authenticationUnavailable",
            diagnostic:
                "Session naming skipped because picker model authentication could not be resolved.",
        };
    }

    const { auth } = authentication;

    if (operationSignal.aborted) {
        return timeoutSignal.aborted
            ? { type: "timeout", diagnostic: timeoutDiagnostic(settings.timeoutMs) }
            : { type: "cancelled" };
    }

    if (!auth.ok) {
        return {
            type: "authenticationUnavailable",
            diagnostic: `Session naming skipped: picker model "${formatPickerModelReference(settings.model)}" has no available authentication.`,
        };
    }

    // auth.ok may legitimately carry only headers, or no credentials at all
    // (header-only and credential-free local providers); apiKey is optional
    // in the model registry contract.

    const prompt = renderNamingPrompt(
        settings.prompt,
        {
            repositoryContext,
            conversation: buildConversationContext(entries, {
                phase,
                scope: settings.conversationScope,
                pendingPrompt,
            }),
            currentName: ctx.sessionManager.getSessionName() ?? "(unnamed)",
            cwd: ctx.cwd,
            reason: phase,
        },
        settings.nameConstraints.minLength,
        settings.nameConstraints.maxLength,
    );

    try {
        const streamOptions: SimpleStreamOptions = {};
        if (auth.apiKey !== undefined) {
            streamOptions.apiKey = auth.apiKey;
        }

        if (auth.headers !== undefined) {
            streamOptions.headers = auth.headers;
        }

        if (auth.env !== undefined) {
            streamOptions.env = auth.env;
        }

        if (settings.reasoningEffort !== "off") {
            streamOptions.reasoning = settings.reasoningEffort;
        }

        // Request headers decide whether the picker model requires the
        // Responses Lite payload shape, so the resolved auth headers must
        // accompany every payload inspection.
        streamOptions.onPayload = (payload) => preparePickerPayload(model, payload, auth.headers);
        streamOptions.signal = operationSignal;

        const response = await completeSimple(
            model,
            {
                messages: [
                    {
                        role: "user",
                        content: [{ type: "text", text: prompt }],
                        timestamp: Date.now(),
                    },
                ],
            },
            streamOptions,
        );

        if (response.stopReason === "aborted") {
            if (timeoutSignal.aborted) {
                return { type: "timeout", diagnostic: timeoutDiagnostic(settings.timeoutMs) };
            }

            return { type: "cancelled" };
        }

        if (response.stopReason === "error") {
            return {
                type: "requestFailed",
                diagnostic:
                    "Session naming failed because the picker model could not complete its request.",
            };
        }

        const rawName = response.content
            .filter((block): block is TextContent => block.type === "text")
            .map((block) => block.text)
            .join("\n");
        const name = normalizeSessionName(
            rawName,
            settings.nameConstraints.minLength,
            settings.nameConstraints.maxLength,
        );
        if (name === undefined) {
            return {
                type: "invalidOutput",
                diagnostic:
                    "Session naming skipped because the picker model returned an unusable name.",
            };
        }

        return { type: "picked", name };
    } catch {
        if (timeoutSignal.aborted) {
            return { type: "timeout", diagnostic: timeoutDiagnostic(settings.timeoutMs) };
        }

        if (signal.aborted) {
            return { type: "cancelled" };
        }

        return {
            type: "requestFailed",
            diagnostic:
                "Session naming failed because the picker model request could not be completed.",
        };
    }
}

/** Register the Pi Autoname Session Pi extension. */
export default function extension(pi: ExtensionAPI): void {
    let settings: ExtensionSettings | undefined;
    let namingState: SessionNamingState | undefined;
    let sessionGeneration = 0;
    let nameRevision = 0;
    let sessionAbortController: AbortController | undefined;
    let activeAttempt: ActiveNamingAttempt | undefined;
    let pickerDiagnosticShown = false;
    let storedStateDiagnosticShown = false;
    let pendingAutoName: string | undefined;
    let namingBlockedReason: "modelUnavailable" | undefined;
    let lastFailedAttempt: { readonly metrics: SessionMetrics; readonly atMs: number } | undefined;
    const backgroundNamingTasks = new Set<Promise<void>>();

    const invalidateActiveAttempt = (): void => {
        activeAttempt?.controller.abort();
        activeAttempt = undefined;
    };

    pi.on("session_start", (_event, ctx) => {
        sessionAbortController?.abort();
        sessionAbortController = new AbortController();
        invalidateActiveAttempt();
        sessionGeneration += 1;
        nameRevision = 0;
        pickerDiagnosticShown = false;
        storedStateDiagnosticShown = false;
        pendingAutoName = undefined;
        namingBlockedReason = undefined;
        lastFailedAttempt = undefined;

        const loaded = loadAutonameSessionSettings(ctx);
        settings = loaded.settings;

        for (const diagnostic of loaded.diagnostics) {
            ctx.ui.notify(diagnostic.message, diagnostic.severity);
        }

        const restored = restoreNamingState(
            ctx.sessionManager.getBranch(),
            ctx.sessionManager.getSessionName(),
            "zero",
            Date.now(),
        );
        namingState = restored.state;

        if (restored.storedStateIssue !== undefined && ctx.hasUI) {
            storedStateDiagnosticShown = true;
            ctx.ui.notify(
                restored.storedStateIssue === "unsupportedVersion"
                    ? "Session naming state was written by an unsupported version and was ignored."
                    : "Invalid session naming state was ignored.",
                "warning",
            );
        }
    });

    pi.on("session_info_changed", (event, ctx) => {
        if (pendingAutoName !== undefined && event.name === pendingAutoName) {
            pendingAutoName = undefined;
            return;
        }

        pendingAutoName = undefined;

        // A user-initiated rename invalidates any in-flight naming attempt:
        // the picked name was computed against the previous name state, and
        // applying it would overwrite the user's change.
        nameRevision += 1;
        invalidateActiveAttempt();

        const currentMetrics = measureSession(ctx.sessionManager.getBranch());
        namingState = createSessionNamingState({
            initialNameSet: event.name !== undefined,
            baseline: currentMetrics,
            baselineAtMs: Date.now(),
        });
        pi.appendEntry(AUTONAME_STATE_ENTRY_TYPE, namingState);
    });

    pi.on("session_tree", (_event, ctx) => {
        // Branch navigation moves to a different conversation: invalidate any
        // in-flight attempt (its name would apply to a branch it never
        // inspected), then restore state from the newly active branch. A
        // branch without usable state is rebased onto its current activity.
        invalidateActiveAttempt();
        lastFailedAttempt = undefined;

        const restored = restoreNamingState(
            ctx.sessionManager.getBranch(),
            ctx.sessionManager.getSessionName(),
            "current",
            Date.now(),
        );
        namingState = restored.state;

        if (restored.storedStateIssue !== undefined && !storedStateDiagnosticShown && ctx.hasUI) {
            storedStateDiagnosticShown = true;
            ctx.ui.notify(
                restored.storedStateIssue === "unsupportedVersion"
                    ? "Session naming state was written by an unsupported version and was ignored."
                    : "Invalid session naming state was ignored.",
                "warning",
            );
        }

        pi.appendEntry(AUTONAME_STATE_ENTRY_TYPE, namingState);
    });

    pi.on("model_select", () => {
        // A model change may make a previously unavailable picker model usable.
        namingBlockedReason = undefined;
    });

    const maybeNameSession = async (
        ctx: ExtensionContext,
        checkpoint: NamingCheckpoint,
    ): Promise<void> => {
        if (
            settings === undefined ||
            namingState === undefined ||
            !settings.enabled ||
            activeAttempt !== undefined
        ) {
            return;
        }

        if (namingBlockedReason !== undefined) {
            return;
        }

        const nowMs = Date.now();
        const measuredMetrics = measureSession(ctx.sessionManager.getBranch());
        const currentMetrics =
            checkpoint.type === "prompt"
                ? { ...measuredMetrics, messages: measuredMetrics.messages + 1 }
                : measuredMetrics;
        const request = getNamingRequest(settings, namingState, currentMetrics, nowMs);
        if (
            request === undefined ||
            sessionAbortController === undefined ||
            (checkpoint.type === "prompt" &&
                (request.phase !== "initial" || settings.initialNaming.timing !== "prompt"))
        ) {
            return;
        }

        // After a failed attempt, retry only when the trigger is reached again
        // relative to the failed attempt (fresh activity or elapsed minutes).
        // This bounds repeated paid picker requests after persistent failures.
        if (lastFailedAttempt !== undefined) {
            const threshold =
                request.phase === "initial"
                    ? settings.initialNaming.threshold
                    : settings.refreshNaming.threshold;
            if (
                !hasReachedTrigger(
                    request.trigger,
                    threshold,
                    currentMetrics,
                    lastFailedAttempt.metrics,
                    lastFailedAttempt.atMs,
                    nowMs,
                )
            ) {
                return;
            }
        }

        const sessionAbort = sessionAbortController;
        const attempt: ActiveNamingAttempt = {
            controller: new AbortController(),
            sessionGeneration,
            nameRevision,
            nameAtStart: pi.getSessionName(),
            leafIdAtStart: ctx.sessionManager.getLeafId(),
        };

        activeAttempt = attempt;

        const entries = ctx.sessionManager.buildContextEntries();
        const operationSignal = AbortSignal.any([sessionAbort.signal, attempt.controller.signal]);
        let repositoryContext = buildRepositoryContext(ctx.cwd);
        const visibleInitialPrompt =
            checkpoint.type === "prompt"
                ? checkpoint.prompt
                : buildConversationContext(entries, {
                      phase: "initial",
                      scope: "minimized",
                  }).replace(/^USER:\n/u, "");
        if (request.phase === "initial" && isOpaqueNamingPrompt(visibleInitialPrompt)) {
            try {
                const gitStatus = await pi.exec(
                    "git",
                    ["status", "--short", "--branch", "--untracked-files=normal"],
                    { cwd: ctx.cwd, signal: operationSignal, timeout: 2_000 },
                );
                if (gitStatus.code === 0) {
                    repositoryContext = buildRepositoryContext(ctx.cwd, gitStatus.stdout);
                }
            } catch {
                // Workspace metadata is optional. Naming continues with the
                // repository identity when git is absent, slow, or cancelled.
            }
        }

        try {
            const outcome = await pickSessionName({
                settings,
                phase: request.phase,
                entries,
                pendingPrompt: checkpoint.type === "prompt" ? checkpoint.prompt : undefined,
                ctx,
                signal: operationSignal,
                repositoryContext,
            });

            const branchStillContainsAttempt =
                attempt.leafIdAtStart === null ||
                ctx.sessionManager.getBranch().some((entry) => entry.id === attempt.leafIdAtStart);
            const attemptIsCurrent =
                activeAttempt === attempt &&
                attempt.sessionGeneration === sessionGeneration &&
                attempt.nameRevision === nameRevision &&
                attempt.nameAtStart === pi.getSessionName() &&
                branchStillContainsAttempt &&
                !attempt.controller.signal.aborted &&
                !sessionAbort.signal.aborted;
            if (!attemptIsCurrent) {
                return;
            }

            if ("diagnostic" in outcome && !pickerDiagnosticShown && ctx.hasUI) {
                pickerDiagnosticShown = true;
                ctx.ui.notify(outcome.diagnostic, "warning");
            }

            if (outcome.type === "picked") {
                if (outcome.name !== pi.getSessionName()) {
                    pendingAutoName = outcome.name;

                    try {
                        pi.setSessionName(outcome.name);
                    } catch (cause: unknown) {
                        pendingAutoName = undefined;
                        throw cause;
                    }
                }

                namingState = markSessionNamingComplete(currentMetrics, Date.now());
                pi.appendEntry(AUTONAME_STATE_ENTRY_TYPE, namingState);
                lastFailedAttempt = undefined;
                return;
            }

            switch (outcome.type) {
                case "cancelled":
                    break;
                case "modelUnavailable":
                    // Deterministic within a session: settings and the model
                    // registry did not change. Suppress further attempts until
                    // a model or settings change (model_select or session_start).
                    namingBlockedReason = outcome.type;
                    lastFailedAttempt = undefined;
                    break;
                case "authenticationUnavailable":
                case "requestFailed":
                case "timeout":
                case "invalidOutput":
                    lastFailedAttempt = { metrics: currentMetrics, atMs: Date.now() };
                    break;
            }
        } finally {
            if (activeAttempt === attempt) {
                activeAttempt = undefined;
            }
        }
    };

    const startBackgroundNaming = (ctx: ExtensionContext, checkpoint: NamingCheckpoint): void => {
        const taskGeneration = sessionGeneration;
        const task = maybeNameSession(ctx, checkpoint);
        backgroundNamingTasks.add(task);
        void task
            .catch(() => {
                if (
                    taskGeneration === sessionGeneration &&
                    sessionAbortController?.signal.aborted === false &&
                    !pickerDiagnosticShown &&
                    ctx.hasUI
                ) {
                    pickerDiagnosticShown = true;
                    ctx.ui.notify("Session naming failed unexpectedly.", "warning");
                }
            })
            .finally(() => {
                backgroundNamingTasks.delete(task);
            });
    };

    pi.on("before_agent_start", (event, ctx) => {
        const imageSummary =
            event.images === undefined || event.images.length === 0
                ? ""
                : `\n[${event.images.length} image${event.images.length === 1 ? "" : "s"} attached]`;

        startBackgroundNaming(ctx, {
            type: "prompt",
            prompt: event.prompt + imageSummary,
        });
    });

    pi.on("agent_settled", async (_event, ctx) => {
        await maybeNameSession(ctx, { type: "settled" });
    });

    pi.on("session_shutdown", async () => {
        sessionAbortController?.abort();
        sessionAbortController = undefined;
        invalidateActiveAttempt();
        namingState = undefined;
        settings = undefined;
        sessionGeneration += 1;
        pendingAutoName = undefined;
        namingBlockedReason = undefined;
        lastFailedAttempt = undefined;
        await Promise.allSettled(backgroundNamingTasks);
        backgroundNamingTasks.clear();
    });
}
