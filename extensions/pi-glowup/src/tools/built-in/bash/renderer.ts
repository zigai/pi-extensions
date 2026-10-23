import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { makeComponent } from "../../../rendering/component.ts";
import { createSyntaxComponent } from "../../../rendering/syntax/component-owner.ts";
import {
    renderScriptCall,
    type ScriptCallRenderOptions,
    type ScriptPreviewHeaderLayout,
} from "./script-renderer.ts";
import { type GlowupCallState, type GlowupRenderTheme } from "../../../rendering/theme.ts";
import { type ScriptInvocation } from "./invocation.ts";
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

function scriptCallRenderOptions(
    options: BashCommandRenderOptions,
    headerLayout: ScriptPreviewHeaderLayout,
): ScriptCallRenderOptions {
    let renderOptions: ScriptCallRenderOptions = {
        state: options.state,
        expanded: options.expanded,
        maxCodePreviewLines: options.maxCodePreviewLines,
        showPrologueOmission: options.showPrologueOmission,
        headerLayout,
        lastComponent: options.lastComponent,
    };
    if (options.invalidate !== undefined) {
        renderOptions = { ...renderOptions, invalidate: options.invalidate };
    }

    if (options.onContentWidth !== undefined) {
        renderOptions = { ...renderOptions, onContentWidth: options.onContentWidth };
    }

    if (options.profile !== undefined)
        renderOptions = { ...renderOptions, profile: options.profile };

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
    analysis: BashCommandAnalysis,
    { lastComponent, ...options }: BashCommandRenderOptions,
): Component {
    return createSyntaxComponent(lastComponent, options.invalidate, (invalidate, previous) => {
        let state: ShellRenderState = { unsplit: undefined, split: undefined };
        if (previous !== undefined) state = shellRenderStates.get(previous) ?? state;

        const renderOptions = { ...options, invalidate };
        const headerLayout =
            options.headerLayout === "auto" && analysis.structurallyComplex
                ? "block"
                : options.headerLayout;
        const renderInvocation = (code: string, previous: Component | undefined): Component =>
            renderScriptCall(
                theme,
                { label: "Bash", language: "bash", code },
                {
                    ...scriptCallRenderOptions(renderOptions, headerLayout),
                    lastComponent: previous,
                },
            );
        const unsplit = renderInvocation(command, state.unsplit);
        state.unsplit = unsplit;

        const unsplitBaselineLines = headerLayout === "block" ? 2 : 1;
        let splitWidth: number | undefined;
        const component = makeComponent((width) => {
            const unsplitLines = unsplit.render(width);
            const canReflow = analysis.reflowedCommand !== undefined;
            const shouldReflow =
                canReflow &&
                (options.shellLayout === "always" ||
                    (options.shellLayout === "auto" &&
                        (analysis.structurallyComplex ||
                            unsplitLines.length > unsplitBaselineLines)));
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
        const shell: Component = {
            render(width) {
                return component.render(width);
            },
            invalidate() {
                component.invalidate();
                unsplit.invalidate();
                state.split?.invalidate();
            },
        };

        shellRenderStates.set(shell, state);

        return shell;
    });
}

export type BashCommandRenderOptions = {
    readonly state: GlowupCallState;
    readonly expanded: boolean;
    readonly maxCodePreviewLines: number;
    readonly showPrologueOmission: boolean;
    readonly headerLayout: ScriptPreviewHeaderLayout;
    readonly shellLayout: ShellLayout;
    readonly shellOperatorPosition: ShellOperatorPosition;
    readonly pureScriptOverride?: ScriptInvocation;
    readonly lastComponent?: Component | undefined;
    readonly invalidate?: () => void;
    readonly onContentWidth?: (contentWidth: number, renderWidth: number) => void;
    readonly profile?: ScriptCallRenderOptions["profile"];
};

function renderScriptInvocation(
    theme: GlowupRenderTheme,
    pureScript: ScriptInvocation,
    options: BashCommandRenderOptions,
): Component {
    if (pureScript.language === "bash") {
        return renderFullShellCommand(
            theme,
            pureScript.code,
            analyzeBashCommand(pureScript.code, options.shellOperatorPosition),
            options,
        );
    }

    return renderScriptCall(
        theme,
        pureScript,
        scriptCallRenderOptions(options, options.headerLayout),
    );
}

/** Renders a clean standalone interpreter call or a losslessly reflowed Bash command. */
export function renderBashCommandCall(
    theme: GlowupRenderTheme,
    command: string,
    options: BashCommandRenderOptions,
): Component {
    if (options.pureScriptOverride !== undefined) {
        return renderScriptInvocation(theme, options.pureScriptOverride, options);
    }

    const analysis = analyzeBashCommand(command, options.shellOperatorPosition);
    if (analysis.pureScript !== undefined) {
        return renderScriptInvocation(theme, analysis.pureScript, options);
    }

    return renderFullShellCommand(theme, command, analysis, options);
}
