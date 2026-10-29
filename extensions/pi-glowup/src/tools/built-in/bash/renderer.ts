import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { makeComponent } from "../../../rendering/component.ts";
import { createSyntaxComponent } from "../../../rendering/syntax/component-owner.ts";
import { renderSyntaxComponent } from "../../../rendering/syntax/code-component.ts";
import {
    observeComponentFormat,
    type ComponentFormat,
} from "../../../diagnostics/highlight-requests.ts";
import { renderScriptCall, type ScriptCallRenderOptions } from "./script-renderer.ts";
import { type GlowupCallState, type GlowupRenderTheme } from "../../../rendering/theme.ts";
import { type ScriptInvocation } from "./invocation.ts";
import type { EmbeddedProgramLookup } from "./embedded-service.ts";
import {
    analyzeBashCommand,
    type BashCommandAnalysis,
    type ShellLayout,
    type ShellOperatorPosition,
} from "./command.ts";
import { graphemes } from "../../../text-boundaries.ts";

function truncatePlainTextToWidth(text: string, maxWidth: number): string {
    const width = Math.max(1, Math.floor(maxWidth));
    if (visibleWidth(text) <= width) return text;

    const suffix = "…";
    const contentBudget = Math.max(0, width - visibleWidth(suffix));
    let content = "";
    let contentWidth = 0;
    for (const grapheme of graphemes(text)) {
        const graphemeWidth = visibleWidth(grapheme);
        if (contentWidth + graphemeWidth > contentBudget) break;

        content += grapheme;
        contentWidth += graphemeWidth;
    }

    return `${content}${suffix}`;
}

function scriptCallRenderOptions(options: BashCommandRenderOptions): ScriptCallRenderOptions {
    let renderOptions: ScriptCallRenderOptions = {
        state: options.state,
        expanded: options.expanded,
        maxCodePreviewLines: options.maxCodePreviewLines,
        showPrologueOmission: options.showPrologueOmission,
        durationMs: options.durationMs,
        lastComponent: options.lastComponent,
    };
    if (options.invalidate !== undefined) {
        renderOptions = { ...renderOptions, invalidate: options.invalidate };
    }

    if (options.onContentWidth !== undefined) {
        renderOptions = { ...renderOptions, onContentWidth: options.onContentWidth };
    }

    if (options.logicalSource !== undefined)
        renderOptions = { ...renderOptions, logicalSource: options.logicalSource };

    if (options.signal !== undefined) renderOptions = { ...renderOptions, signal: options.signal };
    if (options.profile !== undefined)
        renderOptions = { ...renderOptions, profile: options.profile };

    if (options.embeddedPrograms !== undefined)
        renderOptions = { ...renderOptions, embeddedPrograms: options.embeddedPrograms };

    return renderOptions;
}

type ShellRenderState = {
    unsplit: Component | undefined;
    split: Component | undefined;
};

const shellRenderStates = new WeakMap<Component, ShellRenderState>();

function renderFullShellCommand(
    theme: GlowupRenderTheme,
    command: string,
    launcher: string | undefined,
    analysis: BashCommandAnalysis,
    { lastComponent, ...options }: BashCommandRenderOptions,
): Component {
    return createSyntaxComponent(
        lastComponent,
        options.invalidate,
        (invalidate, previous) => {
            let state: ShellRenderState = { unsplit: undefined, split: undefined };
            if (previous !== undefined) state = shellRenderStates.get(previous) ?? state;

            const renderOptions = { ...options, invalidate };
            const renderInvocation = (code: string, previous: Component | undefined): Component =>
                renderScriptCall(
                    theme,
                    {
                        label: "Bash",
                        language: "bash",
                        code,
                        ...(launcher !== undefined && { launcher }),
                    },
                    { ...scriptCallRenderOptions(renderOptions), lastComponent: previous },
                );
            const unsplit = renderInvocation(command, state.unsplit);
            state.unsplit = unsplit;

            const unsplitBaselineLines = launcher === undefined ? 1 : 2;
            let splitWidth: number | undefined;
            let renderedUnsplit = true;
            const component = makeComponent((width) => {
                const unsplitLines = unsplit.render(width);
                const canReflow = analysis.reflowedCommand !== undefined;
                const shouldReflow =
                    canReflow &&
                    (options.shellLayout === "always" ||
                        (options.shellLayout === "auto" &&
                            (analysis.structurallyComplex ||
                                unsplitLines.length > unsplitBaselineLines)));
                renderedUnsplit = !shouldReflow;

                if (!shouldReflow) return unsplitLines;

                if (state.split === undefined || splitWidth !== width) {
                    const reflowedCode = options.expanded
                        ? analysis.reflowedCommand
                        : analysis.reflowedCommand
                              .split("\n")
                              .map((line) =>
                                  truncatePlainTextToWidth(line, Math.max(1, (width - 6) * 2)),
                              )
                              .join("\n");

                    state.split = renderInvocation(reflowedCode, state.split);
                    splitWidth = width;
                }

                return state.split.render(width);
            });
            const observed: Component = {
                render(width) {
                    const lines = component.render(width);
                    const observation = options.formatObservation?.();
                    if (
                        observation !== undefined &&
                        (observation.state !== "ready" || renderedUnsplit)
                    )
                        observeComponentFormat(invalidate, observation);

                    return lines;
                },
                invalidate() {
                    component.invalidate();
                },
            };
            const shell: Component = {
                render(width) {
                    return renderSyntaxComponent(observed, invalidate, width);
                },
                invalidate() {
                    component.invalidate();
                    unsplit.invalidate();
                    state.split?.invalidate();
                },
            };

            shellRenderStates.set(shell, state);

            return shell;
        },
        options.logicalSource ?? command,
    );
}

export type BashCommandRenderOptions = {
    readonly state: GlowupCallState;
    readonly expanded: boolean;
    readonly maxCodePreviewLines: number;
    readonly showPrologueOmission: boolean;
    readonly shellLayout: ShellLayout;
    readonly shellOperatorPosition: ShellOperatorPosition;
    readonly pureScriptOverride?: ScriptInvocation;
    readonly logicalSource?: string;
    readonly formatObservation?: () => ComponentFormat | undefined;
    readonly signal?: AbortSignal;
    readonly lastComponent?: Component | undefined;
    readonly invalidate?: () => void;
    readonly onContentWidth?: (contentWidth: number, renderWidth: number) => void;
    readonly profile?: ScriptCallRenderOptions["profile"];
    readonly embeddedPrograms?: EmbeddedProgramLookup;
    readonly durationMs?: number | undefined;
};

function renderScriptInvocation(
    theme: GlowupRenderTheme,
    pureScript: ScriptInvocation,
    options: BashCommandRenderOptions,
): Component {
    if (pureScript.language === "bash") {
        let programs;
        if (options.embeddedPrograms !== undefined)
            programs = options.embeddedPrograms(pureScript.code, options.invalidate) ?? [];

        return renderFullShellCommand(
            theme,
            pureScript.code,
            pureScript.launcher,
            analyzeBashCommand(pureScript.code, options.shellOperatorPosition, programs),
            options,
        );
    }

    return renderScriptCall(theme, pureScript, {
        ...scriptCallRenderOptions(options),
        ...(options.formatObservation !== undefined && {
            formatObservation: options.formatObservation,
        }),
    });
}

/** Renders a standalone interpreter call or a losslessly reflowed Bash command as a `$` prompt. */
export function renderBashCommandCall(
    theme: GlowupRenderTheme,
    command: string,
    options: BashCommandRenderOptions,
): Component {
    if (options.logicalSource === undefined) options = { ...options, logicalSource: command };

    if (options.pureScriptOverride !== undefined) {
        return renderScriptInvocation(theme, options.pureScriptOverride, options);
    }

    let programs;
    if (options.embeddedPrograms !== undefined)
        programs = options.embeddedPrograms(command, options.invalidate) ?? [];

    const analysis = analyzeBashCommand(command, options.shellOperatorPosition, programs);
    if (analysis.pureScript !== undefined) {
        return renderScriptInvocation(theme, analysis.pureScript, options);
    }

    return renderFullShellCommand(theme, command, undefined, analysis, options);
}
