import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { preparePickerPayload } from "./picker-request.ts";
import { loadAutonameSessionSettings, type ExtensionSettings } from "./settings.ts";
import {
    AUTONAME_STATE_ENTRY_TYPE,
    buildConversationContext,
    buildRepositoryContext,
    createSessionNamingState,
    getNamingRequest,
    measureSession,
    markSessionNamingComplete,
    normalizeSessionName,
    parseSessionNamingState,
    renderNamingPrompt,
    type SessionMetrics,
    type SessionNamingState,
} from "./session-naming.ts";

function resolvePickerModel(modelReference: string, ctx: ExtensionContext): Model<Api> | undefined {
    if (modelReference === "current") {
        if (ctx.model === undefined) {
            return undefined;
        }

        return ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
    }

    const separatorIndex = modelReference.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === modelReference.length - 1) {
        return undefined;
    }

    return ctx.modelRegistry.find(
        modelReference.slice(0, separatorIndex),
        modelReference.slice(separatorIndex + 1),
    );
}

function findStoredNamingState(entries: readonly SessionEntry[]): SessionNamingState | undefined {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.type !== "custom" || entry.customType !== AUTONAME_STATE_ENTRY_TYPE) {
            continue;
        }

        const state = parseSessionNamingState(entry.data);
        if (state !== undefined) {
            return state;
        }
    }

    return undefined;
}

function createZeroMetrics(): SessionMetrics {
    return {
        messages: 0,
        turns: 0,
        toolCalls: 0,
        tokens: 0,
    };
}

async function pickSessionName(
    settings: ExtensionSettings,
    phase: "initial" | "refresh",
    entries: readonly SessionEntry[],
    ctx: ExtensionContext,
    signal: AbortSignal,
    repositoryContext: string,
    reportDiagnostic: (message: string) => void,
): Promise<string | undefined> {
    const model = resolvePickerModel(settings.model, ctx);
    if (model === undefined) {
        reportDiagnostic(
            `Session naming skipped: picker model "${settings.model}" is not available.`,
        );
        return undefined;
    }

    let auth:
        | Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>
        | undefined;
    try {
        auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    } catch {
        reportDiagnostic(
            "Session naming skipped because picker model authentication could not be resolved.",
        );
        return undefined;
    }
    if (auth === undefined || !auth.ok || auth.apiKey === undefined) {
        reportDiagnostic(
            `Session naming skipped: picker model "${settings.model}" has no available authentication.`,
        );
        return undefined;
    }

    const prompt = renderNamingPrompt(
        settings.prompt,
        {
            repositoryContext,
            conversation: buildConversationContext(entries),
            currentName: ctx.sessionManager.getSessionName() ?? "(unnamed)",
            cwd: ctx.cwd,
            reason: phase,
        },
        settings.nameConstraints.minLength,
        settings.nameConstraints.maxLength,
    );

    try {
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
            {
                apiKey: auth.apiKey,
                ...(auth.headers === undefined ? {} : { headers: auth.headers }),
                ...(auth.env === undefined ? {} : { env: auth.env }),
                ...(settings.reasoningEffort === "off"
                    ? {}
                    : { reasoning: settings.reasoningEffort }),
                onPayload: (payload) => preparePickerPayload(model, payload),
                signal,
            },
        );

        if (response.stopReason === "aborted") {
            return undefined;
        }

        if (response.stopReason === "error") {
            const providerMessage = response.errorMessage?.replace(/\s+/g, " ").trim();
            reportDiagnostic(
                providerMessage === undefined || providerMessage.length === 0
                    ? "Session naming failed because the picker model could not complete its request."
                    : `Session naming failed: ${providerMessage.slice(0, 300)}`,
            );
            return undefined;
        }

        const rawName = response.content
            .filter((block): block is TextContent => block.type === "text")
            .map((block) => block.text)
            .join("\n");
        return normalizeSessionName(
            rawName,
            settings.nameConstraints.minLength,
            settings.nameConstraints.maxLength,
        );
    } catch {
        reportDiagnostic(
            "Session naming failed because the picker model request could not be completed.",
        );
        return undefined;
    }
}

/** Register the Pi Autoname Session Pi extension. */
export default function extension(pi: ExtensionAPI): void {
    let settings: ExtensionSettings | undefined;
    let namingState: SessionNamingState | undefined;
    let repositoryContext = "";
    let sessionGeneration = 0;
    let sessionAbortController: AbortController | undefined;
    let namingInFlight = false;
    let pickerDiagnosticShown = false;
    let autoNameBeingApplied: string | undefined;

    pi.on("session_start", (_event, ctx) => {
        sessionAbortController?.abort();
        sessionAbortController = new AbortController();
        sessionGeneration += 1;
        namingInFlight = false;
        pickerDiagnosticShown = false;
        repositoryContext = buildRepositoryContext(ctx.cwd, undefined);

        const loaded = loadAutonameSessionSettings(ctx);
        settings = loaded.settings;
        for (const diagnostic of loaded.diagnostics) {
            ctx.ui.notify(diagnostic.message, diagnostic.severity);
        }

        const currentMetrics = measureSession(ctx.sessionManager.getBranch());
        const storedState = findStoredNamingState(ctx.sessionManager.getEntries());
        const currentName = ctx.sessionManager.getSessionName();

        if (storedState !== undefined) {
            namingState = storedState;
            if (currentName === undefined && storedState.initialNameSet) {
                namingState = createSessionNamingState(false, currentMetrics, Date.now());
            }
        } else {
            const initialNameSet = currentName !== undefined;
            const baseline = initialNameSet ? currentMetrics : createZeroMetrics();
            namingState = createSessionNamingState(initialNameSet, baseline, Date.now());
        }

        if (settings.nameConstraints.minLength > settings.nameConstraints.maxLength && ctx.hasUI) {
            ctx.ui.notify(
                "Session naming is disabled because nameConstraints.minLength is greater than maxLength.",
                "error",
            );
        }
    });

    pi.on("before_agent_start", (event) => {
        repositoryContext = buildRepositoryContext(
            event.systemPromptOptions.cwd,
            event.systemPromptOptions.contextFiles,
        );
    });

    pi.on("session_info_changed", (event, ctx) => {
        if (autoNameBeingApplied !== undefined) {
            return;
        }

        const currentMetrics = measureSession(ctx.sessionManager.getBranch());
        namingState = createSessionNamingState(
            event.name !== undefined,
            currentMetrics,
            Date.now(),
        );
        pi.appendEntry(AUTONAME_STATE_ENTRY_TYPE, namingState);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        if (
            settings === undefined ||
            namingState === undefined ||
            !settings.enabled ||
            namingInFlight
        ) {
            return;
        }

        if (settings.nameConstraints.minLength > settings.nameConstraints.maxLength) {
            return;
        }

        const currentMetrics = measureSession(ctx.sessionManager.getBranch());
        const request = getNamingRequest(settings, namingState, currentMetrics, Date.now());
        if (request === undefined || sessionAbortController === undefined) {
            return;
        }

        const abortController = sessionAbortController;
        const generation = sessionGeneration;
        const entries = ctx.sessionManager.getBranch();
        namingInFlight = true;
        try {
            const pickedName = await pickSessionName(
                settings,
                request.phase,
                entries,
                ctx,
                abortController.signal,
                repositoryContext,
                (message) => {
                    if (!pickerDiagnosticShown && ctx.hasUI) {
                        pickerDiagnosticShown = true;
                        ctx.ui.notify(message, "warning");
                    }
                },
            );

            if (
                pickedName === undefined ||
                generation !== sessionGeneration ||
                abortController.signal.aborted
            ) {
                return;
            }

            if (pickedName !== pi.getSessionName()) {
                autoNameBeingApplied = pickedName;
                try {
                    pi.setSessionName(pickedName);
                } finally {
                    autoNameBeingApplied = undefined;
                }
            }

            namingState = markSessionNamingComplete(currentMetrics, Date.now());
            pi.appendEntry(AUTONAME_STATE_ENTRY_TYPE, namingState);
        } finally {
            namingInFlight = false;
        }
    });

    pi.on("session_shutdown", () => {
        sessionAbortController?.abort();
        sessionAbortController = undefined;
        namingState = undefined;
        settings = undefined;
        repositoryContext = "";
        sessionGeneration += 1;
    });
}
