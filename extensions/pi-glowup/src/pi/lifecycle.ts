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
import { DebugFileLogger } from "../diagnostics/logger.ts";
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
import { type ScriptPreviewHeaderLayout } from "../tools/built-in/bash/script-renderer.ts";
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
import { parseScriptPreviewHeaderLayout } from "../tools/built-in/bash/settings.ts";
import { createNativeBashFeature } from "../tools/built-in/bash/preview.ts";
import { createCodemodePreview } from "../tools/external/codemode.ts";
import { createNativeDeleteFeature } from "../tools/built-in/delete.ts";
import { createNativeEditFeature } from "../tools/built-in/edit.ts";
import { createExplorationFeature, isExplorationToolName } from "../tools/built-in/exploration.ts";
import { createNativeToolRenderers } from "../tools/built-in/renderers.ts";
import { parsePreservedThirdPartyToolNames } from "../tools/renderers.ts";
import { type ThirdPartyToolRenderingOptions } from "../tools/types.ts";
import { diffDetailsParser } from "../unknown-values.ts";
import { configureAssistantSeparatorPatch } from "./patches/assistant-separator.ts";
import { configureAutocompleteCleanupPatch } from "./patches/autocomplete-cleanup.ts";
import { configureMarkdownSyntaxPatch } from "./patches/markdown-syntax.ts";
import { canonicalBuiltInToolName, compatBuiltInToolName } from "../tools/built-in/names.ts";
import {
    configureBuiltInToolRendererPatch,
    configureCompletedLineCache,
    configureThirdPartyToolRendererPatch,
} from "./patches/tool-execution-patch.ts";
import { configureWorkingWidgetSpacingPatch } from "./patches/working-widget-spacing.ts";
import {
    installExplorationSession,
    refreshToolRows,
    restoreExplorationSession,
} from "./session.ts";
import { createSyntaxLifecycle } from "./syntax-lifecycle.ts";

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
const SCRIPT_HEADER_LAYOUT_ENV = "PI_GLOWUP_SCRIPT_HEADER_LAYOUT";

function thirdPartyToolRenderingOptions(
    config: GlowupConfig,
    codemodePreview: NonNullable<ThirdPartyToolRenderingOptions["codemodePreview"]>,
): ThirdPartyToolRenderingOptions {
    const preservedFromEnv = process.env[PRESERVE_TOOLS_ENV];
    return {
        labelMode: config.toolLabels.mode,
        mutationSettings: config.mutations,
        codemodePreview,
        preserveTools:
            preservedFromEnv === undefined
                ? config.preserveTools
                : parsePreservedThirdPartyToolNames(preservedFromEnv),
    };
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
    return createCommandScriptFormatter(scriptFormatterCommands(config, reportWarning));
}

function scriptPreviewHeaderLayout(config: GlowupConfig): ScriptPreviewHeaderLayout {
    const headerLayoutFromEnv = process.env[SCRIPT_HEADER_LAYOUT_ENV];
    return headerLayoutFromEnv === undefined
        ? config.scriptHeaderLayout
        : parseScriptPreviewHeaderLayout(headerLayoutFromEnv);
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

    const edit = createNativeEditFeature();
    const bash = createNativeBashFeature();
    const codemode = createCodemodePreview();
    const deletion = createNativeDeleteFeature();
    const exploration = createExplorationFeature();
    const { captureNativeEditSnapshot, finishNativeEditSnapshot } = edit;
    const { captureNativeDeletePreview } = deletion;
    const { explorationGroups } = exploration;
    const { renderBuiltInToolCall, renderBuiltInToolResult } = createNativeToolRenderers({
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

    let restoreAbort: AbortController | undefined;
    const clearSessionState = (): void => {
        restoreAbort?.abort();
        restoreAbort = undefined;
        edit.clear();
        bash.clear();
        codemode.clear();
        deletion.clear();
        exploration.clear();
        clearQueuedDiffHighlights();
    };

    const reportWarning = (message: string): void => console.warn(message);
    let config = createDefaultGlowupConfig(reportWarning);
    const debugLogger = new DebugFileLogger({
        extensionDirectory: getGlowupDiagnosticsDirectory(),
        reportWarning,
    });
    debugLogger.configure(config.debugLog);

    let formatter = scriptBlockFormatter(config, reportWarning);
    let headerLayout = scriptPreviewHeaderLayout(config);
    let sessionGeneration = 0;
    let extensionLoadedRecorded = false;

    const syntax = createSyntaxLifecycle({
        generation: () => sessionGeneration,
        debugLogger,
        diagnosticSnapshot,
        reportWarning,
    });
    const { startPendingSyntaxHighlighting, scheduleSyntaxHighlighting } = syntax;

    const applyConfig = (nextConfig: GlowupConfig): void => {
        config = nextConfig;
        configureRenderingAppearance(config.appearance);
        configureToolCallIndicator(config.toolCallIndicator);
        debugLogger.configure(config.debugLog);
        formatter = scriptBlockFormatter(config, reportWarning);
        headerLayout = scriptPreviewHeaderLayout(config);

        configureAssistantSeparatorPatch(config.patches.assistantSeparator);
        configureWorkingWidgetSpacingPatch(config.patches.workingWidgetSpacing);
        configureAutocompleteCleanupPatch(config.patches.autocompleteCleanup);
        configureSyntaxBracketPairColoring(config.syntax.bracketPairColoring);
        configureMarkdownSyntaxPatch(config.patches.markdownSyntax);
        configureCompletedLineCache(config.renderCache);

        configureThirdPartyToolRendererPatch(
            true,
            config.patches.thirdPartyToolRenderers
                ? thirdPartyToolRenderingOptions(config, codemode)
                : { enabled: false },
        );

        configureBuiltInToolRendererPatch(true, {
            observeRow: (row, toolCallId, toolName) => {
                explorationGroups.observeRow(row, toolCallId, isExplorationToolName(toolName));
            },
            renderCall: renderBuiltInToolCall({
                headerLayout: () => headerLayout,
                maxCodePreviewLines: () => config.scriptMaxCodePreviewLines,
                showPrologueOmission: () => config.scriptShowPrologueOmission,
                shellLayout: () => config.shellLayout,
                shellOperatorPosition: () => config.shellOperatorPosition,
                labelMode: config.toolLabels.mode,
                movingWriteViewport: config.writePreview.movingViewport,
                mutationSettings: config.mutations,
                recordRender: recordBuiltInRender,
            }),
            renderResult: renderBuiltInToolResult({
                headerLayout: () => headerLayout,
                mutationSettings: config.mutations,
                recordRender: recordBuiltInRender,
            }),
        });

        debugLogger.record("config_applied", () => ({
            ...configDiagnostics(config),
            ...diagnosticSnapshot(),
        }));
    };

    const restoreBashPreviews = (ctx: ExtensionContext): void => {
        if (formatter === undefined) return;

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
        restoreAbort = controller;

        const generation = sessionGeneration;

        void bash.restore({
            calls: calls(),
            formatter,
            signal: controller.signal,
            isCurrent: () => sessionGeneration === generation && !controller.signal.aborted,
            invalidate: () => refreshToolRows(ctx),
        });
    };

    applyConfig(config);
    debugLogger.record("extension_loaded", diagnosticSnapshot);
    extensionLoadedRecorded = config.debugLog.enabled;

    installExplorationSession(pi, exploration);

    // Only mutation calls wait for asynchronous preimage capture.
    pi.on("tool_call", (event, ctx): Promise<void> | undefined => {
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

        if (event.toolName === "codemode") {
            const input = jsonValueParser.parse(event.input);
            const record = jsonObjectParser.parse(input);
            const code = record === undefined ? undefined : getString(record, "code");
            if (code !== undefined) {
                const formatterGeneration = sessionGeneration;

                codemode.schedule({
                    toolCallId: event.toolCallId,
                    code,
                    formatter,
                    isCurrent: () => sessionGeneration === formatterGeneration,
                    invalidate: () => refreshToolRows(ctx),
                });
            }
        }

        if (
            !isToolCallEventType("bash", event) &&
            compatBuiltInToolName(event.toolName) !== "bash"
        ) {
            return preimageCapture;
        }

        if (command !== undefined) {
            const formatterGeneration = sessionGeneration;

            bash.schedule({
                toolCallId: event.toolCallId,
                command,
                formatter,
                signal: ctx.signal,
                isCurrent: () => sessionGeneration === formatterGeneration,
                invalidate: () => refreshToolRows(ctx),
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
        let scheduledFormattedPreview = false;
        let storedEditPreview = false;
        let persistedEditPierrePayload: PierreDiffPayload | undefined;

        if (event.toolName === "codemode") {
            const input = jsonValueParser.parse(event.input);
            const record = jsonObjectParser.parse(input);
            const code = record === undefined ? undefined : getString(record, "code");
            if (code !== undefined) {
                const formatterGeneration = sessionGeneration;

                codemode.schedule({
                    toolCallId: event.toolCallId,
                    code,
                    formatter,
                    isCurrent: () => sessionGeneration === formatterGeneration,
                    invalidate: () => refreshToolRows(ctx),
                });
            }
        }

        if (event.toolName === "bash" || compatBuiltInToolName(event.toolName) === "bash") {
            const command = commandField(event.input);
            if (command !== undefined) {
                const formatterGeneration = sessionGeneration;

                scheduledFormattedPreview = bash.schedule({
                    toolCallId: event.toolCallId,
                    command,
                    formatter,
                    signal: ctx.signal,
                    isCurrent: () => sessionGeneration === formatterGeneration,
                    invalidate: () => refreshToolRows(ctx),
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
            );
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
        sessionGeneration += 1;

        const nextConfig = readGlowupConfig(
            { cwd: ctx.cwd, reportWarning },
            { includeProjectConfig: ctx.isProjectTrusted() },
        );
        debugLogger.configure(nextConfig.debugLog);

        if (!extensionLoadedRecorded) {
            debugLogger.record("extension_loaded", diagnosticSnapshot);
            extensionLoadedRecorded = true;
        }

        debugLogger.startMemorySampling(diagnosticSnapshot);
        debugLogger.record("session_start", () => ({
            phase: "before_reset",
            ...diagnosticSnapshot(),
        }));

        clearSessionState();
        restoreExplorationSession(exploration, ctx.sessionManager);
        debugLogger.record("session_start", () => ({
            phase: "after_reset",
            ...diagnosticSnapshot(),
        }));

        applyConfig(nextConfig);
        restoreBashPreviews(ctx);
        refreshToolRows(ctx);

        scheduleSyntaxHighlighting({ config: nextConfig, cwd: ctx.cwd, reportWarning }, ctx);
        debugLogger.record("session_start", () => ({
            phase: "syntax_scheduled",
            ...diagnosticSnapshot(),
        }));
    });

    pi.on("session_tree", (_event, ctx) => {
        restoreAbort?.abort();
        restoreBashPreviews(ctx);
    });

    pi.on("agent_start", () => {
        startPendingSyntaxHighlighting();
        explorationGroups.closeActiveGroup();
    });

    pi.on("turn_start", () => {
        debugLogger.record("turn_start", diagnosticSnapshot);
    });

    pi.on("turn_end", () => {
        debugLogger.record("turn_end", diagnosticSnapshot);
    });

    pi.on("session_shutdown", async (event) => {
        sessionGeneration += 1;
        debugLogger.stopMemorySampling();
        debugLogger.record("session_shutdown", () => ({
            phase: "before_reset",
            ...diagnosticSnapshot(),
        }));

        clearSessionState();
        syntax.cancel();
        configureAssistantSeparatorPatch(false);
        configureWorkingWidgetSpacingPatch(false);
        configureAutocompleteCleanupPatch(false);
        configureMarkdownSyntaxPatch(false);
        configureThirdPartyToolRendererPatch(false);
        configureBuiltInToolRendererPatch(false);
        await syntax.settle();

        if (event.reason === "quit") {
            await disposeSyntaxHighlighting();
        }

        debugLogger.record("session_shutdown", () => ({
            phase: "after_reset",
            ...diagnosticSnapshot(),
        }));
        guardedPi[EXTENSION_LOADED_KEY] = false;
    });
}
