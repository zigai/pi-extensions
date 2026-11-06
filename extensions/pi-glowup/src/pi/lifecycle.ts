import { configureCompletedLineCache } from "../rendering/rendered-line-cache.ts";
import { setImmediate } from "node:timers/promises";
import { createStreamingPresentation } from "../rendering/streaming/content-presentation.ts";
import {
    presentGlowupContent,
    registerGlowupStreamingPolicy,
} from "../tools/protocol/streaming.ts";
import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import Type from "typebox";
import { Value } from "typebox/value";
import {
    isEditToolResult,
    isToolCallEventType,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    createDefaultGlowupConfig,
    getGlowupDiagnosticsDirectory,
    readGlowupConfig,
} from "../config/load.ts";
import { type GlowupConfig } from "../config/normalize.ts";
import {
    configureRetainedOutputDiagnostics,
    isRetainedOutputLoggingEnabled,
} from "../rendering/output.ts";
import { DebugFileLogger } from "../diagnostics/logger.ts";
import {
    configureRenderDiagnostics,
    resetRenderDiagnostics,
    type RenderDiagnosticSink,
} from "../diagnostics/render-events.ts";
import {
    configDiagnostics,
    createDiagnosticSnapshot,
    detailsDiagnostics,
    textByteLength,
    valueKind,
} from "../diagnostics/snapshot.ts";
import { jsonObjectParser, jsonValueParser } from "../json-value.ts";
import { getString } from "../tools/tool-values.ts";
import { configureRenderingAppearance, configureToolCallIndicator } from "../rendering/theme.ts";
import { clearQueuedDiffHighlights } from "../rendering/diff/pierre-renderer.ts";
import { type PierreDiffPayload } from "../rendering/diff/types.ts";
import {
    configureSyntaxBracketPairColoring,
    disposeSyntaxHighlighting,
} from "../rendering/syntax/highlighter.ts";
import { commandField, pathField, textOutput } from "../tools/built-in/arguments.ts";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommands,
    type ScriptBlockFormatter,
    type ScriptFormatterCommands,
} from "../tools/built-in/bash/formatter.ts";
import { createNativeBashFeature } from "../tools/built-in/bash/preview.ts";
import { createCodemodePreview } from "../tools/external/codemode.ts";
import { createNativeDeleteFeature } from "../tools/built-in/delete.ts";
import { createNativeEditFeature } from "../tools/built-in/edit.ts";
import { createExplorationFeature, isExplorationToolName } from "../tools/built-in/exploration.ts";
import { createNativeToolRenderers } from "../tools/built-in/renderers.ts";
import { parsePreservedThirdPartyToolNames } from "../tools/renderers.ts";
import { type ThirdPartyToolRenderingOptions } from "../tools/types.ts";
import {
    activateGlowupRendering,
    observeGlowupRendering,
    selectGlowupPresentation,
    selectedGlowupPresentation,
} from "../rendering/presentation-registry.ts";
import { clearProtocolRenderingState } from "../tools/protocol/renderer.ts";
import { emptyComponent } from "../rendering/component.ts";
import { diffDetailsParser } from "../unknown-values.ts";
import { configureAssistantSeparatorPatch } from "./patches/assistant-separator.ts";
import { configureAutocompleteCleanupPatch } from "./patches/autocomplete-cleanup.ts";
import { configureMarkdownSyntaxPatch } from "./patches/markdown-syntax.ts";
import { canonicalBuiltInToolName, compatBuiltInToolName } from "../tools/built-in/names.ts";
import {
    configureBuiltInToolRendererPatch,
    configureThirdPartyToolRendererPatch,
    thirdPartyRenderContext,
} from "./patches/tool-execution-patch.ts";
import { configureWorkingWidgetSpacingPatch } from "./patches/working-widget-spacing.ts";
import {
    clearToolRows,
    installExplorationSession,
    observeToolRow,
    refreshToolRows,
    restoreExplorationSession,
} from "./session.ts";
import { createSyntaxLifecycle } from "./syntax-lifecycle.ts";
import { createCodeStreamStore, type CodeStreamStore } from "../rendering/streaming/code-stream.ts";
import { installAssistantStreaming } from "../rendering/streaming/assistant-streaming.ts";
import type { CodePreview } from "../rendering/streaming/presentation.ts";

const opaqueObjectSchema = Type.Object({});
const opaqueObjectParser = {
    parse(value: unknown): object | undefined {
        try {
            return Value.Parse(opaqueObjectSchema, value);
        } catch {
            return undefined;
        }
    },
};

const EXTENSION_LOADED_KEY = Symbol.for("zigai.pi-glowup.extension-loaded");
const PRESERVE_TOOLS_ENV = "PI_GLOWUP_PRESERVE_TOOLS";
const SCRIPT_FORMATTERS_ENV = "PI_GLOWUP_SCRIPT_FORMATTERS";

function thirdPartyToolRenderingOptions(
    config: GlowupConfig,
    codemodePreview: NonNullable<ThirdPartyToolRenderingOptions["codemodePreview"]>,
    streamCode: CodePreview,
    isStreamingCall: (toolCallId: string) => boolean,
): ThirdPartyToolRenderingOptions {
    const preservedFromEnv = process.env[PRESERVE_TOOLS_ENV];
    const options: ThirdPartyToolRenderingOptions = {
        isStreamingCall,
        labelMode: config.toolLabels.mode,
        mutationSettings: config.mutations,
        codemodePreview,
        preserveTools:
            preservedFromEnv === undefined
                ? config.preserveTools
                : parsePreservedThirdPartyToolNames(preservedFromEnv),
    };
    if (config.streaming.code === "token") return options;

    return { ...options, streamCode };
}

function scriptFormatterCommands(
    config: GlowupConfig,
    reportWarning: (message: string) => void,
): ScriptFormatterCommands {
    const formattersFromEnv = process.env[SCRIPT_FORMATTERS_ENV];
    return formattersFromEnv === undefined
        ? config.scriptFormatters
        : parseScriptFormatterCommands(formattersFromEnv, {
              source: SCRIPT_FORMATTERS_ENV,
              reportWarning,
          });
}

function scriptBlockFormatter(
    config: GlowupConfig,
    reportWarning: (message: string) => void,
): ScriptBlockFormatter | undefined {
    return createCommandScriptFormatter(
        scriptFormatterCommands(config, reportWarning),
        reportWarning,
    );
}

type SessionResources = {
    readonly phase: "owned";
    formatter: ScriptBlockFormatter | undefined;
    assistantStreaming: Awaited<ReturnType<typeof installAssistantStreaming>> | undefined;
    streamingPolicy: { dispose(): void } | undefined;
    restoreAbort: AbortController | undefined;
    stopObservingRendering: (() => void) | undefined;
};

type SessionOwner = {
    readonly generation: number;
    readonly controller: AbortController;
    readonly codeStreams: CodeStreamStore;

    resources:
        | SessionResources
        | { readonly phase: "retiring"; readonly completion: Promise<void> }
        | { readonly phase: "retired" };
};

type SessionLifecycle =
    | {
          readonly phase: "registered" | "resetting" | "activating" | "active";
          readonly owner: SessionOwner;
      }
    | {
          readonly phase: "shutting-down";
          readonly generation: number;
          readonly owner: SessionOwner;
          readonly completion: Promise<void>;
      }
    | {
          readonly phase: "stopped";
          readonly generation: number;
          readonly owner: SessionOwner;
      };

type SessionCleanup = {
    readonly completion: Promise<void>;
    readonly finish: (failures: ReadonlySet<unknown>) => void;
};

// Publish cleanup ownership before invoking extension/host callbacks. Completion
// reports all failures, while ordering barriers can independently remain usable.
function createSessionCleanup(message: string): SessionCleanup {
    let finish: SessionCleanup["finish"] = () => {
        throw new Error("Session cleanup completion was not initialized");
    };

    const completion = new Promise<void>((resolve, reject) => {
        finish = (failures) => {
            if (failures.size === 0) resolve();
            else reject(new AggregateError(failures, message));
        };
    });

    return { completion, finish };
}

function attemptSessionCleanup(action: () => void, failures: Set<unknown>): void {
    try {
        action();
    } catch (cause: unknown) {
        failures.add(cause);
    }
}

function createSessionOwner(generation: number): SessionOwner {
    return {
        generation,
        controller: new AbortController(),
        codeStreams: createCodeStreamStore(),
        resources: {
            phase: "owned",
            formatter: undefined,
            assistantStreaming: undefined,
            streamingPolicy: undefined,
            restoreAbort: undefined,
            stopObservingRendering: undefined,
        },
    };
}

export function installGlowup(pi: Pick<ExtensionAPI, "on">): void {
    // SAFETY: The symbol property is extension-private metadata on the concrete
    // ExtensionAPI object. It does not alter Pi's public API or handler semantics.
    const guardedPi = pi as Pick<ExtensionAPI, "on"> & {
        [key: symbol]: boolean | undefined;
    };
    if (guardedPi[EXTENSION_LOADED_KEY] === true) {
        return;
    }

    guardedPi[EXTENSION_LOADED_KEY] = true;

    let session: SessionLifecycle = { phase: "registered", owner: createSessionOwner(0) };

    // Assistant patch installation is serialized independently of session ownership.
    // A retired attempt may finish installing, but can only dispose its late handle.
    let assistantActivation: Promise<void> = Promise.resolve();
    let shutdownBarrier: Promise<void> = Promise.resolve();
    const retiringSessions = new Set<Promise<void>>();

    function sessionGeneration(): number {
        if (session.phase === "shutting-down" || session.phase === "stopped")
            return session.generation;

        return session.owner.generation;
    }

    function currentSessionResources(owner: SessionOwner): SessionResources | undefined {
        if (
            session.phase === "shutting-down" ||
            session.phase === "stopped" ||
            session.owner !== owner ||
            owner.controller.signal.aborted ||
            owner.resources.phase !== "owned"
        )
            return undefined;

        return owner.resources;
    }

    function isCurrentSession(owner: SessionOwner): boolean {
        return currentSessionResources(owner) !== undefined;
    }

    async function retireSession(owner: SessionOwner): Promise<void> {
        const resources = owner.resources;
        if (resources.phase === "retiring") return resources.completion;
        if (resources.phase === "retired") return;

        const retirement = createSessionCleanup("Session resource retirement failed");
        owner.resources = { phase: "retiring", completion: retirement.completion };
        retiringSessions.add(retirement.completion);

        const failures = new Set<unknown>();
        for (const release of [
            () => owner.controller.abort(),
            () => resources.stopObservingRendering?.(),
            () => resources.restoreAbort?.abort(),
            () => resources.streamingPolicy?.dispose(),
            () => resources.assistantStreaming?.dispose(),
            () => owner.codeStreams.clear(),
        ])
            attemptSessionCleanup(release, failures);

        const retired = (): void => {
            owner.resources = { phase: "retired" };
            retiringSessions.delete(retirement.completion);
            retirement.finish(failures);
        };

        // Even a synchronous disposer throw must not skip the remaining releases.
        let disposal = Promise.resolve();

        try {
            disposal = owner.codeStreams.dispose();
        } catch (cause: unknown) {
            failures.add(cause);
        }

        void disposal.then(retired, (cause: unknown) => {
            failures.add(cause);
            retired();
        });

        return retirement.completion;
    }

    const streamCode: CodePreview = (input) => presentGlowupContent({ ...input, kind: "code" });
    const streamingToolCallIds = new Set<string>();
    const isStreamingCall = (toolCallId: string): boolean => streamingToolCallIds.has(toolCallId);
    const finishToolArguments = (
        ctx: ExtensionContext,
        completed = [...streamingToolCallIds],
    ): void => {
        for (const toolCallId of completed) streamingToolCallIds.delete(toolCallId);
        for (const toolCallId of completed) refreshToolRows(ctx, toolCallId);
    };

    const edit = createNativeEditFeature();
    const bash = createNativeBashFeature(
        () => formatter,
        async (input, backend, options) =>
            session.owner.codeStreams.formatEmbedded(input, backend, options),
    );
    const codemode = createCodemodePreview(() => formatter);
    const deletion = createNativeDeleteFeature();
    const exploration = createExplorationFeature();
    const { captureNativeEditSnapshot, finishNativeEditSnapshot } = edit;
    const { captureNativeDeletePreview } = deletion;
    const { explorationGroups } = exploration;
    const {
        renderBuiltInToolCall,
        renderBuiltInToolResult,
        codeSource: nativeCodeSource,
    } = createNativeToolRenderers({
        edit,
        bash,
        deletion,
        exploration,
    });

    const { diagnosticSnapshot, recordBuiltInRender } = createDiagnosticSnapshot({
        edit,
        bash,
        exploration,
    });

    const clearSessionState = async (owner: SessionOwner): Promise<void> => {
        const retirement = retireSession(owner);
        const failures = new Set<unknown>();
        for (const clear of [
            () => configureRetainedOutputDiagnostics(undefined),
            () => syntax.cancel(),
            clearProtocolRenderingState,
            clearToolRows,
            () => streamingToolCallIds.clear(),
            () => edit.clear(),
            () => bash.clear(),
            () => codemode.clear(),
            () => deletion.clear(),
            () => exploration.clear(),
            clearQueuedDiffHighlights,
            resetRenderDiagnostics,
        ])
            attemptSessionCleanup(clear, failures);

        // Overlapping resets must drain all retired stores, even after one fails.
        const outcomes = await Promise.allSettled([
            retirement,
            ...retiringSessions,
            bash.settled(),
        ]);
        for (const outcome of outcomes)
            if (outcome.status === "rejected") failures.add(outcome.reason);

        if (failures.size > 0) throw new AggregateError(failures, "Session reset failed");
    };

    const reportWarning = (message: string): void => reportExtensionDiagnostic(message);
    let config = createDefaultGlowupConfig(reportWarning);
    const debugLogger = new DebugFileLogger({
        extensionDirectory: getGlowupDiagnosticsDirectory(),
        reportWarning,
    });
    const configureDebugLog = (nextConfig: GlowupConfig): void => {
        debugLogger.configure({
            ...nextConfig.debugLog,
            enabled: nextConfig.debugLog.enabled || isRetainedOutputLoggingEnabled(),
        });

        let renderSink: RenderDiagnosticSink | undefined;
        if (nextConfig.debugLog.enabled)
            renderSink = (event, fields) => debugLogger.record(event, fields);

        configureRenderDiagnostics(renderSink);
    };

    configureDebugLog(config);

    let formatter = scriptBlockFormatter(config, reportWarning);
    let extensionLoadedRecorded = false;

    const syntax = createSyntaxLifecycle({
        generation: sessionGeneration,
        debugLogger,
        diagnosticSnapshot,
        reportWarning,
    });
    const { startPendingSyntaxHighlighting, scheduleSyntaxHighlighting } = syntax;

    const applyConfig = (nextConfig: GlowupConfig): void => {
        config = nextConfig;
        activateGlowupRendering();
        configureRenderingAppearance(config.appearance);
        configureToolCallIndicator(config.toolCallIndicator);
        configureDebugLog(config);
        configureRetainedOutputDiagnostics((diagnostic) => {
            const owner = session.owner;

            queueMicrotask(() => {
                if (isCurrentSession(owner)) debugLogger.record("retained_output", diagnostic);
            });
        });
        formatter = scriptBlockFormatter(config, reportWarning);

        const resources = currentSessionResources(session.owner);
        if (resources !== undefined) resources.formatter = formatter;

        configureAssistantSeparatorPatch(config.patches.assistantSeparator);
        configureWorkingWidgetSpacingPatch(config.patches.workingWidgetSpacing);
        configureAutocompleteCleanupPatch(config.patches.autocompleteCleanup);
        configureSyntaxBracketPairColoring(config.syntax.bracketPairColoring);
        configureMarkdownSyntaxPatch(config.patches.markdownSyntax);
        configureCompletedLineCache(config.renderCache);

        configureThirdPartyToolRendererPatch(
            true,
            config.patches.thirdPartyToolRenderers
                ? thirdPartyToolRenderingOptions(config, codemode, streamCode, isStreamingCall)
                : { enabled: false },
        );

        const nativeCall = renderBuiltInToolCall({
            maxCodePreviewLines: () => config.scriptMaxCodePreviewLines,
            showPrologueOmission: () => config.scriptShowPrologueOmission,
            shellLayout: () => config.shellLayout,
            shellOperatorPosition: () => config.shellOperatorPosition,
            labelMode: config.toolLabels.mode,
            movingWriteViewport: config.writePreview.movingViewport,
            mutationSettings: config.mutations,
            recordRender: recordBuiltInRender,
            ...(config.streaming.code !== "token" && { streamCode }),
        });
        const nativeResult = renderBuiltInToolResult({
            shellOutputStyle: () => config.shellOutputStyle,
            mutationSettings: config.mutations,
            recordRender: recordBuiltInRender,
        });
        const renderingOptions = thirdPartyToolRenderingOptions(
            config,
            codemode,
            streamCode,
            isStreamingCall,
        );

        configureBuiltInToolRendererPatch(true, {
            isStreamingCall,
            observeRow: (row, toolCallId, toolName) => {
                observeToolRow(row);

                // Boundaries must follow completed argument order, not constructor order.
                // Still retain incomplete rows so message/turn end can release held previews.
                if (
                    row.argsComplete === true ||
                    row.executionStarted === true ||
                    row.result !== undefined ||
                    !isStreamingCall(toolCallId)
                ) {
                    explorationGroups.observeRow(row, toolCallId, isExplorationToolName(toolName));
                }
            },
            renderCall(toolName, args, theme, context) {
                const renderer = selectedGlowupPresentation().createRenderer(
                    toolName,
                    {
                        codeSource: (value, renderContext) =>
                            nativeCodeSource(toolName, value, renderContext),
                        renderCall: () =>
                            nativeCall(toolName, args, theme, context) ?? emptyComponent(),
                        renderResult: (result, options) =>
                            nativeResult(toolName, result, options, theme, context) ??
                            emptyComponent(),
                    },
                    renderingOptions,
                );

                return renderer.renderCall(
                    jsonValueParser.parse(args),
                    theme,
                    thirdPartyRenderContext(toolName, context),
                );
            },
            renderResult(toolName, result, options, theme, context) {
                const rendered = nativeResult(toolName, result, options, theme, context);
                if (rendered === undefined) return undefined;

                const renderer = selectedGlowupPresentation().createRenderer(
                    toolName,
                    {
                        codeSource: (value, renderContext) =>
                            nativeCodeSource(toolName, value, renderContext),
                        renderCall: () =>
                            nativeCall(toolName, context.args, theme, context) ?? emptyComponent(),
                        renderResult: () => rendered,
                    },
                    renderingOptions,
                );

                return renderer.renderResult(
                    result,
                    options,
                    theme,
                    thirdPartyRenderContext(toolName, context),
                );
            },
        });

        debugLogger.record("config_applied", () => ({
            ...configDiagnostics(config),
            ...diagnosticSnapshot(),
        }));
    };

    const restoreBashPreviews = (ctx: ExtensionContext, owner: SessionOwner): void => {
        const resources = currentSessionResources(owner);
        if (resources === undefined || formatter === undefined || config.streaming.code !== "token")
            return;

        function* calls(): IterableIterator<{ toolCallId: string; command: string }> {
            const branch = ctx.sessionManager.getBranch();
            for (let index = branch.length - 1; index >= 0; index -= 1) {
                const entry = branch[index];
                if (entry?.type !== "message" || entry.message.role !== "assistant") continue;

                for (
                    let blockIndex = entry.message.content.length - 1;
                    blockIndex >= 0;
                    blockIndex -= 1
                ) {
                    const block = entry.message.content[blockIndex];
                    if (
                        block?.type !== "toolCall" ||
                        (block.name !== "bash" && compatBuiltInToolName(block.name) !== "bash")
                    ) {
                        continue;
                    }

                    const command = commandField(block.arguments);
                    if (command !== undefined) yield { toolCallId: block.id, command };
                }
            }
        }

        const controller = new AbortController();

        resources.restoreAbort?.abort();
        resources.restoreAbort = controller;

        void bash.restore({
            calls: calls(),
            formatter,
            signal: controller.signal,
            isCurrent: () => isCurrentSession(owner) && !controller.signal.aborted,
            invalidate: (toolCallId) => refreshToolRows(ctx, toolCallId),
        });
    };

    debugLogger.record("extension_loaded", diagnosticSnapshot);
    extensionLoadedRecorded = config.debugLog.enabled;

    installExplorationSession(pi, exploration);

    // Extension message events arrive before Pi creates/updates their tool rows.
    pi.on("message_start", (event, ctx) => {
        if (event.message.role !== "assistant") return;

        finishToolArguments(ctx);

        for (const block of event.message.content) {
            if (block.type === "toolCall") streamingToolCallIds.add(block.id);
        }
    });

    pi.on("message_update", (event) => {
        if (event.message.role !== "assistant") return;

        for (const block of event.message.content) {
            if (block.type === "toolCall") streamingToolCallIds.add(block.id);
        }
    });

    pi.on("message_end", (event, ctx) => {
        if (event.message.role === "assistant") finishToolArguments(ctx);
    });

    pi.on("agent_end", async (_event, ctx) => {
        const owner = session.owner;
        const completed = [...streamingToolCallIds];

        // Final publication may still be queued from the last argument render.
        // Rebuild after that microtask batch, not inside its pending completion.
        await setImmediate();

        if (isCurrentSession(owner)) finishToolArguments(ctx, completed);
    });

    // Only mutation calls wait for asynchronous preimage capture.
    pi.on("tool_call", (event, ctx): Promise<void> | undefined => {
        const owner = session.owner;
        if (!isCurrentSession(owner)) return undefined;

        startPendingSyntaxHighlighting();

        const command = commandField(event.input);
        const builtInToolName = canonicalBuiltInToolName(event.toolName);
        const preimageCapture =
            builtInToolName === "edit"
                ? captureNativeEditSnapshot(
                      event.toolCallId,
                      ctx.cwd,
                      pathField(event.input),
                      config.mutations,
                  )
                : builtInToolName === "delete"
                  ? captureNativeDeletePreview(
                        event.toolCallId,
                        ctx.cwd,
                        pathField(event.input),
                        config.mutations,
                    )
                  : undefined;

        debugLogger.record("tool_call", () => ({
            toolName: event.toolName,
            builtInToolName: canonicalBuiltInToolName(event.toolName),
            toolCallId: event.toolCallId,
            inputKind: valueKind(jsonValueParser.parse(event.input)),
            commandBytes: textByteLength(command),
            ...diagnosticSnapshot(),
        }));

        if (event.toolName === "codemode" && config.streaming.code === "token") {
            const input = jsonValueParser.parse(event.input);
            const record = jsonObjectParser.parse(input);
            const code = record === undefined ? undefined : getString(record, "code");
            if (code !== undefined) {
                codemode.schedule({
                    toolCallId: event.toolCallId,
                    code,
                    formatter,
                    isCurrent: () => isCurrentSession(owner),
                    invalidate: () => refreshToolRows(ctx, event.toolCallId),
                });
            }
        }

        if (
            !isToolCallEventType("bash", event) &&
            compatBuiltInToolName(event.toolName) !== "bash"
        ) {
            return preimageCapture;
        }

        if (command !== undefined && config.streaming.code === "token") {
            bash.schedule({
                toolCallId: event.toolCallId,
                command,
                formatter,
                signal: ctx.signal,
                isCurrent: () => isCurrentSession(owner),
                invalidate: () => refreshToolRows(ctx, event.toolCallId),
            });

            debugLogger.record("script_preview_remembered", () => ({
                toolCallId: event.toolCallId,
                commandBytes: textByteLength(command),
                ...diagnosticSnapshot(),
            }));
        }

        return preimageCapture;
    });

    pi.on("tool_result", async (event, ctx) => {
        const owner = session.owner;
        if (!isCurrentSession(owner)) return undefined;

        let scheduledFormattedPreview = false;
        let storedEditPreview = false;
        let persistedEditPierrePayload: PierreDiffPayload | undefined;

        if (event.toolName === "codemode" && config.streaming.code === "token") {
            const input = jsonValueParser.parse(event.input);
            const record = jsonObjectParser.parse(input);
            const code = record === undefined ? undefined : getString(record, "code");
            if (code !== undefined) {
                codemode.schedule({
                    toolCallId: event.toolCallId,
                    code,
                    formatter,
                    completed: true,
                    isCurrent: () => isCurrentSession(owner),
                    invalidate: () => refreshToolRows(ctx, event.toolCallId),
                });
            }
        }

        if (
            config.streaming.code === "token" &&
            (event.toolName === "bash" || compatBuiltInToolName(event.toolName) === "bash")
        ) {
            const command = commandField(event.input);
            if (command !== undefined) {
                scheduledFormattedPreview = bash.schedule({
                    toolCallId: event.toolCallId,
                    command,
                    formatter,
                    signal: ctx.signal,
                    isCurrent: () => isCurrentSession(owner),
                    invalidate: () => refreshToolRows(ctx, event.toolCallId),
                });
            }
        }

        const rendersAsEdit =
            isEditToolResult(event) || compatBuiltInToolName(event.toolName) === "edit";
        if (rendersAsEdit) {
            persistedEditPierrePayload = await finishNativeEditSnapshot(
                event.toolCallId,
                event.isError,
                config.mutations,
                diffDetailsParser.parse(event.details),
            );

            if (!isCurrentSession(owner)) return undefined;
        }

        const completedDiff =
            rendersAsEdit && !event.isError ? diffDetailsParser.parse(event.details) : undefined;
        if (completedDiff !== undefined) {
            edit.rememberCompletedPreview(event.toolCallId, {
                path: pathField(event.input) ?? "",
                diff: completedDiff.diff,
            });
            storedEditPreview = true;
        }

        const output = textOutput(event);

        debugLogger.record("tool_result", () => ({
            toolName: event.toolName,
            builtInToolName: canonicalBuiltInToolName(event.toolName),
            toolCallId: event.toolCallId,
            isError: event.isError,
            outputTextBytes: textByteLength(output),
            scheduledFormattedPreview,
            storedEditPreview,
            ...detailsDiagnostics(event.details),
            ...diagnosticSnapshot(),
        }));

        if (persistedEditPierrePayload !== undefined) {
            const details = {
                ...opaqueObjectParser.parse(event.details),
                pierreDiff: persistedEditPierrePayload,
            };
            return { details };
        }

        return undefined;
    });

    pi.on("session_start", async (_event, ctx) => {
        const predecessor = session.owner;
        const owner = createSessionOwner(sessionGeneration() + 1);
        session = { phase: "resetting", owner };

        const nextConfig = readGlowupConfig(
            { cwd: ctx.cwd, reportWarning },
            { includeProjectConfig: ctx.isProjectTrusted() },
        );
        configureDebugLog(nextConfig);

        if (!extensionLoadedRecorded) {
            debugLogger.record("extension_loaded", diagnosticSnapshot);
            extensionLoadedRecorded = true;
        }

        debugLogger.startMemorySampling(diagnosticSnapshot);
        debugLogger.record("session_start", () => ({
            phase: "before_reset",
            ...diagnosticSnapshot(),
        }));

        await clearSessionState(predecessor);

        if (!isCurrentSession(owner)) return;

        // A new activation must not race a prior shutdown's global syntax disposal.
        await shutdownBarrier;

        if (!isCurrentSession(owner)) return;

        session = { phase: "activating", owner };
        restoreExplorationSession(exploration, ctx.sessionManager);
        debugLogger.record("session_start", () => ({
            phase: "after_reset",
            ...diagnosticSnapshot(),
        }));

        try {
            selectGlowupPresentation(nextConfig.presentation);
        } catch {
            reportWarning("[pi-glowup] Selected tool presentation is unavailable.");
            selectGlowupPresentation("compact");
        }

        // Presentation listeners may synchronously reset or shut down the session.
        if (!isCurrentSession(owner)) return;

        applyConfig(nextConfig);

        const resources = currentSessionResources(owner);
        if (resources === undefined) return;

        const presentation = createStreamingPresentation(() => ({
            prose: nextConfig.streaming.prose,
            code: nextConfig.streaming.code,
            streams: owner.codeStreams,
            formatter: resources.formatter,
        }));
        if (ctx.hasUI) resources.streamingPolicy = registerGlowupStreamingPolicy(presentation);

        assistantActivation = assistantActivation
            .then(async () => {
                if (!isCurrentSession(owner) || !ctx.hasUI) return;

                if (nextConfig.streaming.prose === "token" && nextConfig.streaming.code === "token")
                    return;

                const handle = await installAssistantStreaming({
                    presentation: { present: presentGlowupContent },
                    prose: nextConfig.streaming.prose,
                    code: nextConfig.streaming.code,
                    streams: owner.codeStreams,
                    ...(resources.formatter !== undefined && { formatter: resources.formatter }),
                    invalidate: () => {
                        if (isCurrentSession(owner))
                            ctx.ui.setStatus("glowup-streaming", undefined);
                    },
                });
                const current = currentSessionResources(owner);
                if (current === undefined) {
                    handle.dispose();
                    return;
                }

                current.assistantStreaming = handle;
            })
            .catch(() => {
                if (isCurrentSession(owner))
                    reportWarning("[pi-glowup] Assistant streaming activation failed.");
            });
        await assistantActivation;

        // Every post-await publication belongs to this attempt, not just the patch handle.
        if (!isCurrentSession(owner)) return;

        session = { phase: "active", owner };

        if (ctx.hasUI)
            resources.stopObservingRendering = observeGlowupRendering(() => {
                if (!isCurrentSession(owner)) return;

                applyConfig(nextConfig);
                refreshToolRows(ctx);
            });

        restoreBashPreviews(ctx, owner);
        refreshToolRows(ctx);

        scheduleSyntaxHighlighting({ config: nextConfig, cwd: ctx.cwd, reportWarning }, ctx);
        debugLogger.record("session_start", () => ({
            phase: "syntax_scheduled",
            ...diagnosticSnapshot(),
        }));
    });

    pi.on("session_tree", (_event, ctx) => {
        const owner = session.owner;
        const resources = currentSessionResources(owner);
        if (resources === undefined) return;

        owner.codeStreams.clear();
        finishToolArguments(ctx);
        resources.restoreAbort?.abort();
        restoreBashPreviews(ctx, owner);
    });

    pi.on("agent_start", () => {
        startPendingSyntaxHighlighting();
        explorationGroups.closeActiveGroup();
    });

    pi.on("turn_start", () => {
        debugLogger.record("turn_start", diagnosticSnapshot);
    });

    pi.on("turn_end", (_event, ctx) => {
        finishToolArguments(ctx);
        debugLogger.record("turn_end", diagnosticSnapshot);
    });

    function finishSessionShutdown(
        owner: SessionOwner,
        generation: number,
        failures: Set<unknown>,
    ): void {
        if (
            session.phase !== "shutting-down" ||
            session.owner !== owner ||
            session.generation !== generation
        )
            return;

        const stopping = session;

        attemptSessionCleanup(
            () =>
                debugLogger.record("session_shutdown", () => ({
                    phase: "after_reset",
                    ...diagnosticSnapshot(),
                })),
            failures,
        );

        if (session !== stopping) return;

        attemptSessionCleanup(() => configureRenderDiagnostics(undefined), failures);

        if (session !== stopping) return;

        guardedPi[EXTENSION_LOADED_KEY] = false;
        session = { phase: "stopped", generation, owner };
    }

    pi.on("session_shutdown", async () => {
        if (session.phase === "shutting-down") return session.completion;
        if (session.phase === "stopped") return;

        const owner = session.owner;
        const generation = sessionGeneration() + 1;
        const previousShutdown = shutdownBarrier;
        const shutdown = createSessionCleanup("Session shutdown failed");
        session = { phase: "shutting-down", generation, owner, completion: shutdown.completion };

        // Callers still receive cleanup failures, but later activations wait on a
        // non-rejecting ordering barrier rather than inheriting an old failure.
        shutdownBarrier = shutdown.completion.then(
            () => {},
            () => {},
        );

        const failures = new Set<unknown>();

        attemptSessionCleanup(() => debugLogger.stopMemorySampling(), failures);
        attemptSessionCleanup(
            () =>
                debugLogger.record("session_shutdown", () => ({
                    phase: "before_reset",
                    ...diagnosticSnapshot(),
                })),
            failures,
        );

        const cleanup = clearSessionState(owner);

        for (const disable of [
            () => configureAssistantSeparatorPatch(false),
            () => configureWorkingWidgetSpacingPatch(false),
            () => configureAutocompleteCleanupPatch(false),
            () => configureMarkdownSyntaxPatch(false),
            () => configureBuiltInToolRendererPatch(false),
            () => configureThirdPartyToolRendererPatch(false),
        ])
            attemptSessionCleanup(disable, failures);

        const drain = async (): Promise<void> => {
            for (const settle of [
                async () => cleanup,
                async () => syntax.settle(),
                async () => assistantActivation,
                async () => previousShutdown,
                disposeSyntaxHighlighting,
            ]) {
                try {
                    await settle();
                } catch (cause: unknown) {
                    failures.add(cause);
                }
            }

            // A replacement waits on this barrier but owns its own diagnostics.
            finishSessionShutdown(owner, generation, failures);
            shutdown.finish(failures);
        };

        void drain().catch((cause: unknown) => {
            failures.add(cause);
            shutdown.finish(failures);
        });

        return shutdown.completion;
    });
}
