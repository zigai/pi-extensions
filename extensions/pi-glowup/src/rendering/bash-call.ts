import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
    makeComponent,
    renderScriptCall,
    type GlowupCallState,
    type GlowupRenderTheme,
    type ScriptInvocation,
    type ScriptPreviewHeaderLayout,
} from "./core.ts";
import {
    analyzeBashCommand,
    type BashCommandAnalysis,
    type ShellLayout,
} from "../script-preview/bash-analysis.ts";
import { graphemes } from "../text-boundaries.ts";

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

function renderFullShellCommand(
    theme: GlowupRenderTheme,
    command: string,
    analysis: BashCommandAnalysis,
    options: BashCommandRenderOptions,
): Component {
    const headerLayout =
        options.headerLayout === "auto" && analysis.structurallyComplex
            ? "block"
            : options.headerLayout;
    const renderInvocation = (code: string): Component =>
        renderScriptCall(
            theme,
            { label: "Bash", language: "bash", code },
            {
                state: options.state,
                expanded: options.expanded,
                maxCodePreviewLines: options.maxCodePreviewLines,
                showPrologueOmission: options.showPrologueOmission,
                headerLayout,
                ...(options.invalidate === undefined ? {} : { invalidate: options.invalidate }),
            },
        );
    const unsplit = renderInvocation(command);
    const unsplitBaselineLines = headerLayout === "block" ? 2 : 1;
    let splitWidth: number | undefined;
    let splitComponent: Component | undefined;
    const component = makeComponent((width) => {
        const unsplitLines = unsplit.render(width);
        const canReflow = analysis.reflowedCommand !== undefined;
        const shouldReflow =
            canReflow &&
            (options.shellLayout === "always" ||
                (options.shellLayout === "auto" &&
                    (analysis.structurallyComplex || unsplitLines.length > unsplitBaselineLines)));
        if (!shouldReflow || analysis.reflowedCommand === undefined) return unsplitLines;
        if (splitComponent === undefined || splitWidth !== width) {
            const reflowedCode = options.expanded
                ? analysis.reflowedCommand
                : analysis.reflowedCommand
                      .split("\n")
                      .map((line) => truncatePlainTextToWidth(line, Math.max(1, (width - 6) * 2)))
                      .join("\n");
            splitComponent = renderInvocation(reflowedCode);
            splitWidth = width;
        }
        return splitComponent.render(width);
    });
    return {
        render(width) {
            return component.render(width);
        },
        invalidate() {
            component.invalidate();
            unsplit.invalidate();
            splitComponent?.invalidate();
        },
    };
}

export type BashCommandRenderOptions = {
    readonly state: GlowupCallState;
    readonly expanded: boolean;
    readonly maxCodePreviewLines: number;
    readonly showPrologueOmission: boolean;
    readonly headerLayout: ScriptPreviewHeaderLayout;
    readonly shellLayout: ShellLayout;
    readonly pureScriptOverride?: ScriptInvocation;
    readonly invalidate?: () => void;
};

/** Renders a clean standalone interpreter call or a losslessly reflowed Bash command. */
export function renderBashCommandCall(
    theme: GlowupRenderTheme,
    command: string,
    options: BashCommandRenderOptions,
): Component {
    const analysis = analyzeBashCommand(command);
    const pureScript = options.pureScriptOverride ?? analysis.pureScript;
    if (pureScript !== undefined) {
        return renderScriptCall(theme, pureScript, {
            state: options.state,
            expanded: options.expanded,
            maxCodePreviewLines: options.maxCodePreviewLines,
            showPrologueOmission: options.showPrologueOmission,
            headerLayout: options.headerLayout,
            ...(options.invalidate === undefined ? {} : { invalidate: options.invalidate }),
        });
    }
    return renderFullShellCommand(theme, command, analysis, options);
}
