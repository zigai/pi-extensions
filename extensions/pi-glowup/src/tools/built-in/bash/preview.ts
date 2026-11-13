import { type Component } from "@earendil-works/pi-tui";
import { createSyntaxComponent } from "../../../rendering/syntax/component-owner.ts";
import { createEmbeddedProgramService, type EmbeddedProgramLookup } from "./embedded-service.ts";
import {
    extractEmbeddedPrograms,
    sourceCharacterAt,
    type EmbeddedProgram,
} from "./embedded-programs.ts";
import type { ShellLayout, ShellOperatorPosition, ShellOutputStyle } from "./command.ts";
import { type JsonValue } from "../../../json-value.ts";
import { makeComponent, fitToWidth } from "../../../rendering/component.ts";
import type { CodePreview } from "../../../rendering/streaming/presentation.ts";
import { scriptInvocationFromPrograms, type ScriptInvocation } from "./invocation.ts";
import { renderGlowupOutput, type GlowupOutputRenderOptions } from "../../../rendering/output.ts";
import { shouldDeferSimpleToolCall } from "../../../rendering/status-labels.ts";
import {
    detectStructuredOutputLanguage,
    renderSyntaxComponent,
} from "../../../rendering/syntax/code-component.ts";
import { commandField, textOutput } from "../arguments.ts";
import {
    trimOldestMapEntries,
    type BuiltInRenderContext,
    type BuiltInRenderTheme,
    type BuiltInResultOptions,
    type TextResult,
} from "../context.ts";
import {
    formatAndStoreScriptPreview,
    hasEmbeddedSource,
    rememberRawScriptPreview,
    scriptForPreview,
} from "./format-preview.ts";
import type {
    ScriptBlockFormatter,
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "./formatter.ts";
import { createScriptPreviewStore, MAX_SCRIPT_PREVIEW_ENTRIES } from "./preview-store.ts";
import { renderBashCommandCall, type BashCommandRenderOptions } from "./renderer.ts";
import {
    carryRawScriptSyntax,
    inheritPreparedScriptSyntax,
    prepareScriptCallSyntax,
} from "./prepared-syntax.ts";
import { StreamingScriptIdentityStore } from "./streaming-identity.ts";
import { renderExpandableSection, sectionContent } from "../../section-expansion.ts";
import {
    recordRenderError,
    renderDiagnosticsEnabled,
    type ScriptSegmentDiagnostic,
} from "../../../diagnostics/render-events.ts";
import { recordScriptAnalysis } from "./script-analysis.ts";

type ScriptPreviewSchedule = {
    readonly toolCallId: string;
    readonly command: string;
    readonly formatter: ScriptBlockFormatter | undefined;
    readonly signal: AbortSignal | undefined;
    readonly targetWidth?: number;
    readonly completed?: boolean;
    readonly awaitRenderWidth?: boolean;
    readonly isCurrent: () => boolean;
    readonly invalidate: () => void;
};

// Execution completion does not imply formatting readiness. In particular, a
// profiled preview waits for both, while an unprofiled preview may publish early.
type BashExecution = { readonly status: "active" } | { readonly status: "complete" };

type BashFormatting =
    | { readonly status: "unformatted" }
    | { readonly status: "unavailable" }
    | {
          readonly status: "ready";
          readonly width: number | undefined;
          readonly expandedScript: ScriptInvocation | undefined;
          readonly publication: "immediate" | "after-execution";
          notification: "pending" | "published";
      };

type BashRunningWorker = {
    readonly status: "running";
    controller: AbortController;
    completion: Promise<void>;
};

type BashWorker = { readonly status: "idle" } | BashRunningWorker;

type BashRawSyntax =
    | { readonly status: "idle" }
    | { readonly status: "preparing"; readonly previous: ScriptInvocation }
    | { readonly status: "ready"; readonly script: ScriptInvocation };

type ScheduledPreview = {
    options: ScriptPreviewSchedule;
    rawSyntax: BashRawSyntax;
    targetWidth: number | undefined;
    execution: BashExecution;
    formatting: BashFormatting;
    worker: BashWorker;
};

function retireBashWorker(scheduled: ScheduledPreview): void {
    if (scheduled.worker.status === "running") scheduled.worker.controller.abort();
}

async function bashPreviewCompletion(scheduled: ScheduledPreview): Promise<void> {
    if (scheduled.worker.status === "running") await scheduled.worker.completion;
}

type StreamingScriptRenderState = {
    readonly toolCallId: string;
    signal: AbortSignal | undefined;
    readonly invalidate: () => void;
    preview: Component | undefined;
    displayedInvocation?: ScriptInvocation;
    displayedSource?: string;
    displayedOriginal?: ScriptInvocation;
    sourcePrefix: string | undefined;
    pending: { source: string; programs: readonly EmbeddedProgram[] } | undefined;
};

const streamingScriptRenderStates = new WeakMap<Component, StreamingScriptRenderState>();

function renderStreamingScriptCall(
    invocation: ScriptInvocation,
    command: string,
    theme: BuiltInRenderTheme,
    context: BuiltInRenderContext,
    streamCode: CodePreview | undefined,
    signal: AbortSignal | undefined,
    identities: StreamingScriptIdentityStore,
    options: Omit<BashCommandRenderOptions, "expanded">,
    onlyScript = false,
    signalForLanguage?: (
        language: string,
        renderState: StreamingScriptRenderState,
        preservePrevious: boolean,
    ) => AbortSignal,
    onStreamHandoff?: () => void,
    onStreamReveal?: () => void,
) {
    const { toolCallId, argsComplete, isError } = context;
    let current = context.lastComponent;
    let activeSignal = signal;

    return renderExpandableSection(context, "call", (expanded) => {
        const rendered = createSyntaxComponent(
            current,
            options.invalidate,
            (invalidate, previous) => {
                let renderState: StreamingScriptRenderState = {
                    toolCallId,
                    signal,
                    preview: undefined,
                    sourcePrefix: undefined,
                    pending: undefined,
                    invalidate: () => {
                        if (renderState.signal?.aborted !== true) invalidate();
                    },
                };
                if (previous !== undefined) {
                    const retained = streamingScriptRenderStates.get(previous);
                    if (retained?.toolCallId === toolCallId) {
                        renderState = retained;
                        renderState.signal = signal;
                    }
                }

                const component = makeComponent((width) => {
                    if (activeSignal?.aborted === true) return [];

                    if (
                        renderState.sourcePrefix !== undefined &&
                        !command.startsWith(renderState.sourcePrefix)
                    ) {
                        identities.forget(toolCallId);

                        // Reject the old display until analysis is ready, but keep
                        // its syntax owner so unchanged embedded children can be reused.
                        renderState.sourcePrefix = undefined;
                    }

                    let currentInvocation = invocation;
                    let available = options.embeddedPrograms?.(command, renderState.invalidate);
                    if (available === undefined) {
                        if (
                            renderState.preview === undefined ||
                            renderState.sourcePrefix === undefined ||
                            !command.startsWith(renderState.sourcePrefix)
                        )
                            return [];

                        if (renderState.pending?.source !== command)
                            renderState.pending = {
                                source: command,
                                programs: extractEmbeddedPrograms(command),
                            };

                        available = renderState.pending.programs;
                    } else {
                        renderState.pending = undefined;
                    }

                    let detected;
                    if (argsComplete || isError)
                        detected = identities.finalize(
                            toolCallId,
                            scriptInvocationFromPrograms(available),
                        );
                    else detected = identities.resolve(toolCallId, command, available);

                    if (onlyScript && detected === undefined) return [];

                    currentInvocation = detected ?? invocation;

                    const original = renderState.displayedOriginal;
                    const preservePrevious =
                        currentInvocation.language === "bash" &&
                        original !== undefined &&
                        original.language !== "bash" &&
                        renderState.displayedSource !== undefined &&
                        command.startsWith(renderState.displayedSource) &&
                        available.some(
                            (item) =>
                                !item.expandable &&
                                item.language === original.language &&
                                item.code.replace(/\n$/u, "") === original.code.replace(/\n$/u, ""),
                        );
                    if (signalForLanguage !== undefined) {
                        activeSignal = signalForLanguage(
                            currentInvocation.language,
                            renderState,
                            preservePrevious,
                        );
                        renderState.signal = activeSignal;
                    }

                    const program = available.find(
                        (item) =>
                            item.standalone !== undefined &&
                            !item.expandable &&
                            item.language === currentInvocation.language,
                    );
                    let lastCharacter;
                    if (program?.characters !== undefined)
                        lastCharacter = sourceCharacterAt(
                            program.characters,
                            program.code.length - 1,
                        );

                    renderState.sourcePrefix = command;
                    if (lastCharacter !== undefined)
                        renderState.sourcePrefix = command.slice(0, lastCharacter.end);

                    let code = currentInvocation.code;
                    if (streamCode !== undefined) {
                        code = streamCode({
                            key: `tool:${toolCallId}:script:${currentInvocation.language}`,
                            source: currentInvocation.code,
                            language: currentInvocation.language,
                            complete: argsComplete || isError,
                            targetWidth: Math.max(1, width - 6),
                            invalidate: renderState.invalidate,
                            ...(activeSignal !== undefined && { signal: activeSignal }),
                            toolCallId,
                        });
                        onStreamHandoff?.();
                    }

                    // A new language namespace has no revealed rows yet. Keep the
                    // still-live standalone view until its compound replacement exists.
                    if (
                        preservePrevious &&
                        code.trim().length === 0 &&
                        renderState.preview !== undefined
                    )
                        return renderState.preview.render(width);

                    let displayedInvocation = { ...currentInvocation, code };
                    if (streamCode !== undefined && code.trim().length > 0) {
                        renderState.displayedInvocation = displayedInvocation;
                        renderState.displayedSource = command;
                        renderState.displayedOriginal = currentInvocation;
                    }

                    if (code.trim().length === 0 && currentInvocation.launcher === undefined) {
                        const firstLine = command.replace(/^[ \t\n]+/u, "").split("\n", 1)[0] ?? "";
                        if (firstLine.length > 0) {
                            displayedInvocation = {
                                label: "Bash",
                                language: "bash",
                                code: fitToWidth(`${firstLine} …`, Math.max(1, width - 2), "…"),
                            };
                        }
                    }

                    let previewOptions = options;

                    if (preservePrevious && code.trim().length > 0) {
                        // The new stream can normalize a boundary newline or format
                        // the body. Its exact display needs metadata before retiring
                        // the old standalone owner, not another cold lookup frame.
                        const programs = extractEmbeddedPrograms(code);
                        const lookup: EmbeddedProgramLookup = Object.assign(
                            (source: string, notify?: () => void) =>
                                source === code
                                    ? programs
                                    : options.embeddedPrograms?.(source, notify),
                            {
                                isCurrent: (source: string, found: readonly EmbeddedProgram[]) =>
                                    source === code
                                        ? found === programs
                                        : (options.embeddedPrograms?.isCurrent?.(source, found) ??
                                          true),
                            },
                        );

                        previewOptions = { ...options, embeddedPrograms: lookup };
                    }

                    const preview = renderBashCommandCall(theme, code, {
                        ...previewOptions,
                        expanded,
                        invalidate: renderState.invalidate,
                        pureScriptOverride: displayedInvocation,
                        lastComponent: renderState.preview,
                    });
                    renderState.preview = preview;

                    const lines = preview.render(width);

                    if (code.trim().length > 0) onStreamReveal?.();
                    return lines;
                });

                // Host invalidations rebuild this wrapper. Retain the child syntax owner
                // instead of flashing plain text and tokenizing the same script again.
                const observed: Component = {
                    render(width) {
                        return renderSyntaxComponent(component, invalidate, width);
                    },
                    invalidate() {
                        component.invalidate();
                    },
                };

                streamingScriptRenderStates.set(observed, renderState);

                return observed;
            },
            command,
        );

        // Expansion callbacks outlive this render. Replace their previous component
        // reference instead of retaining every historical host row through a closure.
        current = rendered;
        return rendered;
    });
}

export function createNativeBashFeature(
    formatterAccessor?: () => ScriptBlockFormatter | undefined,
    formatEmbedded?: (
        input: ScriptBlockFormatterInput,
        formatter: ScriptBlockFormatter,
        options: ScriptBlockFormatterOptions,
    ) => Promise<string>,
) {
    const scriptPreviews = createScriptPreviewStore();
    let sessionController = new AbortController();
    let sessionInvalidations = new WeakMap<() => void, () => void>();
    let embeddedService = createEmbeddedProgramService();
    const disposals = new Set<Promise<void>>();
    const embeddedPrograms: EmbeddedProgramLookup = Object.assign(
        (source: string, invalidate?: () => void) => embeddedService.get(source, invalidate),
        {
            isCurrent: (source: string, programs: readonly EmbeddedProgram[]) =>
                embeddedService.isCurrent(source, programs),
        },
    );
    const scheduledCommands = new Map<string, ScheduledPreview>();
    const renderWidths = new Map<string, { contentWidth: number; renderWidth: number }>();
    const streamingScriptIdentities = new StreamingScriptIdentityStore();
    const bashRenderInvalidations = new Map<string, () => void>();
    const MAX_BASH_RENDER_INVALIDATIONS = 300;
    const livePreviews = new Map<
        string,
        {
            readonly language: string;
            readonly controller: AbortController;
            previous?: AbortController;
            renderState?: WeakRef<StreamingScriptRenderState>;
        }
    >();

    function sessionInvalidate(host: () => void): () => void {
        let invalidate = sessionInvalidations.get(host);
        if (invalidate === undefined) {
            const signal = sessionController.signal;

            invalidate = () => {
                if (!signal.aborted) host();
            };
            sessionInvalidations.set(host, invalidate);
        }

        return invalidate;
    }

    function retireLivePreview(toolCallId: string): void {
        const live = livePreviews.get(toolCallId);
        livePreviews.delete(toolCallId);
        live?.controller.abort();
        live?.previous?.abort();
    }

    function livePreviewSignal(
        toolCallId: string,
        language: string,
        renderState?: StreamingScriptRenderState,
        preservePrevious = false,
    ): AbortSignal {
        let live = livePreviews.get(toolCallId);
        if (live === undefined || live.language !== language) {
            let previous: AbortController | undefined;
            if (preservePrevious && live !== undefined) {
                live.previous?.abort();
                previous = live.controller;
            } else retireLivePreview(toolCallId);

            live = {
                language,
                controller: new AbortController(),
                ...(previous !== undefined && { previous }),
            };
            livePreviews.set(toolCallId, live);

            while (livePreviews.size > MAX_BASH_RENDER_INVALIDATIONS) {
                const oldest = livePreviews.keys().next().value;
                if (oldest === undefined) break;

                retireLivePreview(oldest);
            }
        }

        if (!preservePrevious) {
            live.previous?.abort();
            delete live.previous;
        }

        if (renderState !== undefined && live.renderState?.deref() !== renderState)
            live.renderState = new WeakRef(renderState);

        return live.controller.signal;
    }

    function rememberBashRenderInvalidation(
        toolCallId: string,
        invalidate: (() => void) | undefined,
    ): void {
        if (invalidate === undefined) return;

        bashRenderInvalidations.delete(toolCallId);
        bashRenderInvalidations.set(toolCallId, invalidate);
        trimOldestMapEntries(bashRenderInvalidations, MAX_BASH_RENDER_INVALIDATIONS);
    }

    function renderBashCall(
        args: JsonValue | undefined,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        maxCodePreviewLines: () => number,
        showPrologueOmission: () => boolean,
        shellLayout: () => ShellLayout,
        shellOperatorPosition: () => ShellOperatorPosition,
        streamCode?: CodePreview,
    ) {
        const sessionSignal = sessionController.signal;
        const toolCallId = context.toolCallId;
        const invalidate = sessionInvalidate(context.invalidate);
        const renderContext = { ...context, invalidate };

        rememberBashRenderInvalidation(context.toolCallId, invalidate);

        const state = context.isError ? "error" : context.isPartial ? "running" : "success";
        const command = commandField(args) ?? "";
        const knownPrograms = embeddedPrograms(command, invalidate);
        const programs = knownPrograms ?? [];

        if (context.argsComplete && knownPrograms !== undefined && renderDiagnosticsEnabled()) {
            // The completed preview records analysis after embedded decisions are known.
            const formatter =
                formatterAccessor?.() ??
                scheduledCommands.get(context.toolCallId)?.options.formatter;
            if (
                formatter === undefined ||
                scriptForPreview(command, formatter, formatEmbedded !== undefined, programs) ===
                    undefined
            ) {
                recordScriptAnalysis({
                    toolName: "bash",
                    toolCallId: context.toolCallId,
                    command,
                    formatter,
                    programs,
                });
            }
        }

        if (
            streamCode !== undefined &&
            ((!context.argsComplete && !context.isError) || formatterAccessor?.() === undefined)
        ) {
            let script = streamingScriptIdentities.resolve(context.toolCallId, command, programs);
            if (context.argsComplete && knownPrograms !== undefined)
                script = streamingScriptIdentities.finalize(
                    context.toolCallId,
                    scriptInvocationFromPrograms(programs),
                );

            // Transfer the revealed prefix to the completed store entry first.
            // Aborting its old signal before get() would delete that prefix and
            // briefly replace the code with an empty launcher while block work runs.
            let onStreamHandoff: (() => void) | undefined;
            if (context.argsComplete || context.isError) {
                const live = livePreviews.get(toolCallId);
                if (live !== undefined)
                    onStreamHandoff = () => {
                        if (livePreviews.get(toolCallId) === live) retireLivePreview(toolCallId);
                    };
            }

            const invocation = script ?? { label: "Bash", language: "bash", code: command };
            const profile = formatterAccessor?.()?.profileFor?.(invocation.language);
            let signal: AbortSignal | undefined;
            let signalForLanguage:
                | ((
                      language: string,
                      renderState: StreamingScriptRenderState,
                      preservePrevious: boolean,
                  ) => AbortSignal)
                | undefined;
            if (!context.argsComplete && !context.isError) {
                signalForLanguage = (language, renderState, preservePrevious) =>
                    livePreviewSignal(toolCallId, language, renderState, preservePrevious);

                if (knownPrograms === undefined)
                    signal = livePreviews.get(context.toolCallId)?.controller.signal;
                else signal = livePreviewSignal(context.toolCallId, invocation.language);
            }

            return renderStreamingScriptCall(
                invocation,
                command,
                theme,
                renderContext,
                streamCode,
                signal,
                streamingScriptIdentities,
                {
                    state,
                    maxCodePreviewLines: maxCodePreviewLines(),
                    showPrologueOmission: showPrologueOmission(),
                    shellLayout: shellLayout(),
                    shellOperatorPosition: shellOperatorPosition(),
                    invalidate,
                    embeddedPrograms,
                    logicalSource: command,
                    signal: sessionSignal,
                    durationMs: context.durationMs,
                    background: context.shellCall?.background ?? false,
                    ...(profile !== undefined && { profile }),
                },
                false,
                signalForLanguage,
                onStreamHandoff,
                () => {
                    const live = livePreviews.get(toolCallId);
                    live?.previous?.abort();

                    if (live !== undefined) delete live.previous;
                },
            );
        }

        if (!context.argsComplete && !context.isError && streamCode === undefined)
            retireLivePreview(context.toolCallId);

        if (
            shouldDeferSimpleToolCall(context) &&
            scriptPreviews.get(context.toolCallId) === undefined
        ) {
            const partialScript = streamingScriptIdentities.resolve(
                context.toolCallId,
                command,
                programs,
            );
            const invocation = partialScript ?? { label: "Bash", language: "bash", code: command };

            return renderStreamingScriptCall(
                invocation,
                command,
                theme,
                { ...renderContext, expanded: false },
                undefined,
                undefined,
                streamingScriptIdentities,
                {
                    state,
                    maxCodePreviewLines: maxCodePreviewLines(),
                    showPrologueOmission: showPrologueOmission(),
                    shellLayout: shellLayout(),
                    shellOperatorPosition: shellOperatorPosition(),
                    invalidate,
                    embeddedPrograms,
                    logicalSource: command,
                    signal: sessionSignal,
                    durationMs: context.durationMs,
                    background: context.shellCall?.background ?? false,
                },
                true,
            );
        }

        // Declared shell tools do not receive native Bash's tool_call scheduling hook.
        // Rendering observes an existing source; only explicit schedule() requests
        // replace its formatter/signal revision. Accessors may return fresh wrappers.
        // Complete arguments do not imply that execution has produced its final result.
        const executionComplete = context.result !== undefined && !context.isPartial;
        if (
            (streamCode !== undefined || context.shellCall !== undefined) &&
            (context.argsComplete || context.isError)
        ) {
            if (scheduledCommands.get(context.toolCallId)?.options.command === command) {
                if (executionComplete) completePreview(context.toolCallId);
            } else {
                // Preserve eager display for render-discovered calls with no execution
                // schedule; never apply that policy to an existing execution-owned record.
                const formatter = formatterAccessor?.();
                if (formatter !== undefined)
                    schedule({
                        toolCallId: context.toolCallId,
                        command,
                        formatter,
                        signal: undefined,
                        completed: true,
                        awaitRenderWidth: true,
                        isCurrent: () => true,
                        invalidate,
                    });
            }
        }

        if (context.argsComplete || context.isError) retireLivePreview(context.toolCallId);

        const previousComponent = sectionContent(context.lastComponent);
        let previousStream: StreamingScriptRenderState | undefined;
        if (previousComponent !== undefined)
            previousStream = streamingScriptRenderStates.get(previousComponent);

        const scheduled = scheduledCommands.get(context.toolCallId);
        let heldScript: ScriptInvocation | undefined;
        if (
            scheduled?.options.command === command &&
            scheduled.rawSyntax.status === "preparing" &&
            previousStream?.displayedSource === command
        )
            heldScript = previousStream.displayedInvocation;

        if (
            heldScript === undefined &&
            knownPrograms === undefined &&
            (context.argsComplete || context.isError) &&
            previousStream?.toolCallId === context.toolCallId &&
            previousStream.preview !== undefined &&
            previousStream.sourcePrefix !== undefined &&
            command.startsWith(previousStream.sourcePrefix)
        ) {
            return renderStreamingScriptCall(
                { label: "Bash", language: "bash", code: command },
                command,
                theme,
                renderContext,
                undefined,
                undefined,
                streamingScriptIdentities,
                {
                    state,
                    maxCodePreviewLines: maxCodePreviewLines(),
                    showPrologueOmission: showPrologueOmission(),
                    shellLayout: shellLayout(),
                    shellOperatorPosition: shellOperatorPosition(),
                    invalidate,
                    embeddedPrograms,
                    logicalSource: command,
                    signal: sessionSignal,
                    durationMs: context.durationMs,
                    background: context.shellCall?.background ?? false,
                },
            );
        }

        const displayCommand = command;

        if (executionComplete) completePreview(context.toolCallId);

        const parsedScript = scriptForPreview(
            displayCommand,
            scheduled?.options.formatter,
            formatEmbedded !== undefined,
            programs,
        );
        const profile = scheduled?.options.formatter?.profileFor?.(parsedScript?.language ?? "");
        const profiled =
            profile !== undefined ||
            (formatEmbedded !== undefined &&
                parsedScript?.language === "bash" &&
                hasEmbeddedSource(programs, scheduled?.options.formatter));
        let script = scriptPreviews.get(context.toolCallId);
        if (profiled && scheduled?.execution.status !== "complete") {
            script = undefined;
            if (scheduled?.options.command === command && scheduled.rawSyntax.status === "ready")
                script = scheduled.rawSyntax.script;
        }

        if (heldScript !== undefined) script = heldScript;
        if (script === undefined && parsedScript !== undefined) script = parsedScript;

        let stableScript = script;
        if (context.argsComplete) {
            stableScript = streamingScriptIdentities.finalize(context.toolCallId, script) ?? script;
        }

        let bashOptions: BashCommandRenderOptions = {
            state,
            expanded: context.expanded,
            maxCodePreviewLines: maxCodePreviewLines(),
            showPrologueOmission: showPrologueOmission(),
            shellLayout: shellLayout(),
            shellOperatorPosition: shellOperatorPosition(),
            invalidate,
            embeddedPrograms,
            logicalSource: command,
            signal: sessionSignal,
            durationMs: context.durationMs,
            background: context.shellCall?.background ?? false,
        };
        if (stableScript !== undefined && context.argsComplete) {
            const { toolCallId } = context;

            bashOptions = {
                ...bashOptions,
                onContentWidth: (contentWidth, renderWidth) =>
                    rememberRenderWidth(toolCallId, contentWidth, renderWidth),
            };
        }

        if (stableScript !== undefined) {
            bashOptions = { ...bashOptions, pureScriptOverride: stableScript };
        }

        if (
            profile !== undefined &&
            scheduled?.execution.status === "complete" &&
            scheduled.formatting.status === "ready"
        ) {
            bashOptions = { ...bashOptions, profile };
        }

        // The expansion handler outlives this render. Reuse syntax ownership without
        // retaining a chain of previous transcript components through its closure.
        let previous = context.lastComponent;

        // The streaming wrapper owns a different syntax component from its actual
        // script preview. Hand that child off when completed arguments select the
        // formatter path, or large sources lose their owner-local colors for a frame.
        if (previousStream?.toolCallId === context.toolCallId)
            previous = previousStream.preview ?? previous;

        return renderExpandableSection(renderContext, "call", (expanded) => {
            let options = { ...bashOptions, expanded, lastComponent: previous };
            let expandedSource = heldScript ?? parsedScript;
            if (
                heldScript === undefined &&
                scheduled?.options.command === command &&
                scheduled.execution.status !== "complete" &&
                scheduled.rawSyntax.status === "ready"
            )
                expandedSource = scheduled.rawSyntax.script;

            if (
                expanded &&
                expandedSource !== undefined &&
                (profiled || scheduled?.formatting.status !== "ready")
            ) {
                let expandedScript = expandedSource;
                if (
                    scheduled?.execution.status === "complete" &&
                    scheduled.formatting.status === "ready" &&
                    scheduled.formatting.expandedScript !== undefined
                )
                    expandedScript = scheduled.formatting.expandedScript;

                if (script !== undefined) inheritPreparedScriptSyntax(expandedScript, script);

                options = {
                    ...options,
                    pureScriptOverride: expandedScript,
                    shellLayout: "preserve",
                };
            }

            const selected = options.pureScriptOverride;

            if (scheduled?.options.command === command) {
                options = {
                    ...options,
                    formatObservation: () => {
                        if (
                            scheduledCommands.get(toolCallId) !== scheduled ||
                            !scheduled.options.isCurrent() ||
                            scheduled.options.signal?.aborted === true
                        )
                            return undefined;

                        if (scheduled.worker.status === "running")
                            return { state: "pending", source: command };

                        if (
                            scheduled.execution.status === "complete" &&
                            scheduled.formatting.status === "ready" &&
                            scheduled.formatting.width === scheduled.targetWidth &&
                            selected !== undefined &&
                            (selected === scriptPreviews.get(toolCallId) ||
                                selected === scheduled.formatting.expandedScript)
                        )
                            return { state: "ready", source: command, output: selected.code };

                        return undefined;
                    },
                };
            } else if (formatterAccessor?.() === undefined)
                options = {
                    ...options,
                    formatObservation: () => ({ state: "not-required", source: command }),
                };

            const component = renderBashCommandCall(theme, displayCommand, options);
            previous = component;

            if (heldScript !== undefined && previousStream !== undefined) {
                previousStream.preview = component;
                streamingScriptRenderStates.set(component, previousStream);
            }

            return component;
        });
    }

    function renderBashResult(
        result: TextResult,
        options: BuiltInResultOptions,
        theme: BuiltInRenderTheme,
        context: BuiltInRenderContext,
        shellOutputStyle: () => ShellOutputStyle,
    ) {
        const invalidate = sessionInvalidate(context.invalidate);

        if (!options.isPartial) completePreview(context.toolCallId);

        const output = textOutput(result);
        const language = detectStructuredOutputLanguage(output);
        let prefix = "";
        if (shellOutputStyle() === "gutter") prefix = theme.fg("dim", "│ ");

        let outputOptions: GlowupOutputRenderOptions = {
            expanded: options.expanded,
            mode: "headTail",
            maxPreviewLines: 5,
            invalidate,
            prefixFirst: prefix,
            prefixRest: prefix,
        };
        if (language !== undefined) {
            outputOptions = { ...outputOptions, syntax: { language } };
        }

        return renderExpandableSection(
            { ...context, expanded: options.expanded, invalidate },
            "result",
            (expanded) => renderGlowupOutput(theme, output, { ...outputOptions, expanded }),
        );
    }

    function clear(): void {
        sessionController.abort();
        sessionController = new AbortController();
        sessionInvalidations = new WeakMap();

        const previousService = embeddedService;
        embeddedService = createEmbeddedProgramService();

        const disposal = previousService
            .dispose()
            .catch((cause: unknown) => recordRenderError("bash.embedded-dispose", cause));
        disposals.add(disposal);
        void disposal.then(() => disposals.delete(disposal));

        for (const toolCallId of livePreviews.keys()) retireLivePreview(toolCallId);
        scriptPreviews.clear();

        for (const scheduled of scheduledCommands.values()) retireBashWorker(scheduled);
        scheduledCommands.clear();
        renderWidths.clear();
        bashRenderInvalidations.clear();
        streamingScriptIdentities.clear();
    }

    function remember(toolCallId: string, command: string, formatter?: ScriptBlockFormatter): void {
        rememberRawScriptPreview(
            scriptPreviews,
            toolCallId,
            command,
            formatter,
            formatEmbedded !== undefined,
            embeddedPrograms(command) ?? [],
        );
    }

    function invalidatePreview(scheduled: ScheduledPreview): void {
        const rendered = bashRenderInvalidations.get(scheduled.options.toolCallId);
        rendered?.();

        if (scheduled.options.invalidate !== rendered) scheduled.options.invalidate();
    }

    function publishReady(scheduled: ScheduledPreview): void {
        const formatting = scheduled.formatting;
        if (
            formatting.status !== "ready" ||
            formatting.notification === "published" ||
            formatting.width !== scheduled.targetWidth ||
            (formatting.publication === "after-execution" &&
                scheduled.execution.status !== "complete") ||
            scheduledCommands.get(scheduled.options.toolCallId) !== scheduled ||
            !scheduled.options.isCurrent() ||
            scheduled.options.signal?.aborted === true
        )
            return;

        formatting.notification = "published";
        invalidatePreview(scheduled);
    }

    function completePreview(toolCallId: string): void {
        const scheduled = scheduledCommands.get(toolCallId);
        if (scheduled === undefined || scheduled.execution.status === "complete") return;

        scheduled.execution = { status: "complete" };
        if (scheduled.rawSyntax.status === "ready") scheduled.rawSyntax = { status: "idle" };

        if (scheduled.formatting.status === "ready") {
            // Completion also changes the host's format observation after an
            // unprofiled preview has already published its early output.
            scheduled.formatting.notification = "pending";
            queueMicrotask(() => publishReady(scheduled));
        }
    }

    async function formatPreview(
        scheduled: ScheduledPreview,
        worker: BashRunningWorker,
    ): Promise<void> {
        const controller = new AbortController();
        worker.controller = controller;

        const { options, targetWidth } = scheduled;
        let signal = controller.signal;
        if (options.signal !== undefined) signal = AbortSignal.any([signal, options.signal]);

        // Identical work may receive refreshed validity/invalidation callbacks.
        const currentPass = (): boolean =>
            !signal.aborted &&
            scheduled.options.isCurrent() &&
            scheduledCommands.get(options.toolCallId) === scheduled &&
            scheduled.worker === worker &&
            worker.controller === controller;

        const programs = await embeddedService.resolve(options.command, signal);
        if (programs === undefined || !currentPass()) return;

        // Statement previews may already be formatter-changed. Prepare the raw
        // execution-phase view before replacing those rows; unchanged streams need
        // no extra syntax job. This uses the existing cancellable formatter pass.
        if (scheduled.rawSyntax.status === "preparing") {
            const raw = scriptForPreview(
                options.command,
                options.formatter,
                formatEmbedded !== undefined,
                programs,
            );
            if (raw !== undefined) {
                const previous = scheduled.rawSyntax.previous;
                const changed = raw.language !== previous.language || raw.code !== previous.code;
                if (changed) {
                    try {
                        await prepareScriptCallSyntax(raw, signal, async (source) =>
                            embeddedService.resolve(source, signal),
                        );
                    } catch (cause: unknown) {
                        if (!signal.aborted)
                            recordRenderError("bash.raw-syntax", cause, options.toolCallId);
                    }
                }

                if (!currentPass()) return;

                scriptPreviews.set(options.toolCallId, raw);
                scheduled.rawSyntax = { status: "ready", script: raw };
                if (!changed || scheduled.execution.status === "complete")
                    scheduled.rawSyntax = { status: "idle" };

                invalidatePreview(scheduled);
            } else scheduled.rawSyntax = { status: "idle" };
        }

        let previewFormatter = options.formatter;
        let expandedScript: ScriptInvocation | undefined;
        const backend = options.formatter;
        if (backend !== undefined && formatEmbedded !== undefined) {
            previewFormatter = Object.assign(
                async (
                    input: ScriptBlockFormatterInput,
                    formatterOptions: ScriptBlockFormatterOptions = {},
                ) => {
                    let code = input.code;
                    if (input.language === "bash") {
                        let embeddedOptions = formatterOptions;
                        if (input.code === options.command)
                            embeddedOptions = { ...embeddedOptions, programs };

                        code = await formatEmbedded(input, backend, embeddedOptions);
                        if (code !== input.code)
                            expandedScript = { label: "Bash", language: "bash", code };
                    }

                    const formatted = await backend({ ...input, code }, formatterOptions);
                    if (formatted !== undefined) return formatted;
                    if (code !== input.code) return code;
                    return undefined;
                },
                { ...(backend.profileFor !== undefined && { profileFor: backend.profileFor }) },
            );
        }

        let embeddedDecisions: ScriptSegmentDiagnostic[] | undefined;
        let recordSegment: ((segment: ScriptSegmentDiagnostic) => void) | undefined;
        if (renderDiagnosticsEnabled()) {
            const recorded: ScriptSegmentDiagnostic[] = [];

            recordSegment = (segment) => {
                embeddedDecisions = recorded;
                recorded.push(segment);
            };
        }

        const formatted = await formatAndStoreScriptPreview({
            sink: scriptPreviews,
            toolCallId: options.toolCallId,
            command: options.command,
            formatter: previewFormatter,
            embeddedFormatting: formatEmbedded !== undefined,
            programs,
            signal,
            prepare: async (preview) => {
                await prepareScriptCallSyntax(preview, signal, async (source) =>
                    embeddedService.resolve(source, signal),
                );

                const prior = scriptPreviews.get(options.toolCallId);
                const raw = scriptForPreview(
                    options.command,
                    options.formatter,
                    formatEmbedded !== undefined,
                    programs,
                );
                if (prior !== undefined && raw !== undefined)
                    carryRawScriptSyntax(preview, prior, raw.code);
            },
            ...(targetWidth !== undefined && { targetWidth }),
            ...(recordSegment !== undefined && { recordSegment }),
            isCurrent: () => currentPass() && scheduled.targetWidth === targetWidth,
        }).catch((cause: unknown) => {
            if (!signal.aborted)
                recordRenderError("bash.format-preview", cause, options.toolCallId);

            return false;
        });

        if (!currentPass() || scheduled.targetWidth !== targetWidth) return;

        if (recordSegment !== undefined) {
            let embeddedSkipReason: string | undefined;
            if (formatEmbedded === undefined) embeddedSkipReason = "embedded-formatting-disabled";

            recordScriptAnalysis({
                toolName: "bash",
                toolCallId: options.toolCallId,
                command: options.command,
                formatter: options.formatter,
                programs,
                formatted,
                ...(embeddedDecisions !== undefined && { embeddedDecisions }),
                ...(embeddedSkipReason !== undefined && { embeddedSkipReason }),
                displayCode: scriptPreviews.get(options.toolCallId)?.code ?? options.command,
            });
        }

        if (!formatted) {
            if (scheduled.formatting.status !== "ready")
                scheduled.formatting = { status: "unavailable" };

            return;
        }

        const script = scriptPreviews.get(options.toolCallId);
        const profile = options.formatter?.profileFor?.(script?.language ?? "");
        let publication: "immediate" | "after-execution" = "immediate";
        if (profile !== undefined || expandedScript !== undefined) publication = "after-execution";

        scheduled.formatting = {
            status: "ready",
            width: targetWidth,
            expandedScript,
            publication,
            notification: "pending",
        };
    }

    function requestFormatting(scheduled: ScheduledPreview): void {
        if (scheduled.worker.status === "running") return;

        const worker: BashRunningWorker = {
            status: "running",
            controller: new AbortController(),
            completion: Promise.resolve(),
        };
        scheduled.worker = worker;
        worker.completion = (async () => {
            while (
                scheduledCommands.get(scheduled.options.toolCallId) === scheduled &&
                scheduled.options.isCurrent() &&
                scheduled.options.signal?.aborted !== true
            ) {
                const width = scheduled.targetWidth;
                await formatPreview(scheduled, worker);

                if (scheduled.targetWidth === width) return;
            }
        })().finally(() => {
            if (scheduled.worker === worker) {
                scheduled.worker = { status: "idle" };

                if (scheduled.rawSyntax.status === "preparing") {
                    scheduled.rawSyntax = { status: "idle" };

                    if (
                        scheduledCommands.get(scheduled.options.toolCallId) === scheduled &&
                        scheduled.options.isCurrent() &&
                        scheduled.options.signal?.aborted !== true
                    )
                        invalidatePreview(scheduled);
                }

                publishReady(scheduled);
            }
        });
    }

    function rememberRenderWidth(
        toolCallId: string,
        contentWidth: number,
        renderWidth: number,
    ): void {
        const previous = renderWidths.get(toolCallId);
        if (previous?.renderWidth === renderWidth) {
            contentWidth = Math.min(previous.contentWidth, contentWidth);
        }

        renderWidths.delete(toolCallId);
        renderWidths.set(toolCallId, { contentWidth, renderWidth });
        trimOldestMapEntries(renderWidths, MAX_BASH_RENDER_INVALIDATIONS);

        const scheduled = scheduledCommands.get(toolCallId);
        if (scheduled === undefined || scheduled.targetWidth === contentWidth) return;

        scheduled.targetWidth = contentWidth;
        queueMicrotask(() => {
            if (
                scheduledCommands.get(toolCallId) !== scheduled ||
                scheduled.targetWidth !== contentWidth ||
                !scheduled.options.isCurrent() ||
                scheduled.options.signal?.aborted === true
            )
                return;

            requestFormatting(scheduled);
        });
    }

    function schedule(options: ScriptPreviewSchedule): boolean {
        const previous = scheduledCommands.get(options.toolCallId);
        if (
            options.formatter !== undefined &&
            previous?.options.command === options.command &&
            previous.options.formatter === options.formatter &&
            previous.options.signal === options.signal
        ) {
            previous.options = options;

            if (options.completed === true) completePreview(options.toolCallId);
            return true;
        }

        if (previous !== undefined) retireBashWorker(previous);

        // An accessor may provide a fresh formatter wrapper on every render.
        // Replace its work identity, not a ready display of the identical source.
        // This also keeps profile/signal replacement atomic until the new result.
        const retainPreview =
            previous?.options.command === options.command &&
            options.formatter !== undefined &&
            scriptPreviews.get(options.toolCallId) !== undefined;
        if (!retainPreview) remember(options.toolCallId, options.command, options.formatter);
        scheduledCommands.delete(options.toolCallId);

        if (options.formatter === undefined) return false;

        let rawSyntax: BashRawSyntax = { status: "idle" };
        const revealed = livePreviews
            .get(options.toolCallId)
            ?.renderState?.deref()?.displayedInvocation;
        const raw = scriptPreviews.get(options.toolCallId);
        if (
            revealed !== undefined &&
            (raw === undefined || revealed.language !== raw.language || revealed.code !== raw.code)
        )
            rawSyntax = { status: "preparing", previous: revealed };

        const scheduled: ScheduledPreview = {
            options,
            rawSyntax,
            targetWidth: renderWidths.get(options.toolCallId)?.contentWidth ?? options.targetWidth,
            execution: { status: "active" },
            formatting: { status: "unformatted" },
            worker: { status: "idle" },
        };

        scheduledCommands.set(options.toolCallId, scheduled);

        if (options.completed === true) completePreview(options.toolCallId);

        while (scheduledCommands.size > MAX_BASH_RENDER_INVALIDATIONS) {
            const oldest = scheduledCommands.keys().next().value;
            if (oldest === undefined) break;

            const evicted = scheduledCommands.get(oldest);
            if (evicted !== undefined) retireBashWorker(evicted);
            scheduledCommands.delete(oldest);
        }

        if (options.awaitRenderWidth !== true || scheduled.targetWidth !== undefined)
            requestFormatting(scheduled);

        return true;
    }

    async function restore(options: {
        readonly calls: Iterable<{ readonly toolCallId: string; readonly command: string }>;
        readonly formatter: ScriptBlockFormatter | undefined;
        readonly signal: AbortSignal;
        readonly isCurrent: () => boolean;
        readonly invalidate: (toolCallId: string) => void;
    }): Promise<void> {
        if (options.formatter === undefined) return;

        let restored = 0;
        for (const call of options.calls) {
            if (options.signal.aborted || !options.isCurrent()) return;

            if (restored >= MAX_SCRIPT_PREVIEW_ENTRIES) return;

            restored += 1;
            schedule({
                toolCallId: call.toolCallId,
                command: call.command,
                completed: true,
                awaitRenderWidth: true,
                formatter: options.formatter,
                signal: options.signal,
                isCurrent: options.isCurrent,
                invalidate: () => options.invalidate(call.toolCallId),
            });

            const scheduled = scheduledCommands.get(call.toolCallId);
            if (scheduled !== undefined) await bashPreviewCompletion(scheduled);
        }
    }

    return {
        stats: () => scriptPreviews.stats(),
        scriptForSource: (command: string) => {
            const programs = embeddedPrograms(command);
            if (programs === undefined) return undefined;
            return (
                scriptInvocationFromPrograms(programs) ?? {
                    label: "Bash",
                    language: "bash",
                    code: command,
                }
            );
        },
        remember,
        schedule,
        restore,
        settled: async () => {
            await embeddedService.settled();
            await Promise.all([...scheduledCommands.values()].map(bashPreviewCompletion));

            while (disposals.size > 0) await Promise.all(disposals);
        },
        renderBashCall,
        renderBashResult,
        clear,
    };
}
