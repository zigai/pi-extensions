import {
    emptyComponent,
    renderCodexOutput,
    type CodexCallState,
    type CodexRenderTheme,
} from "../rendering/core.ts";
import { callState, renderThirdPartyCall } from "./call-rendering.ts";
import type {
    CodexLookRenderingAdapter,
    CodexLookSection,
    CodexLookView,
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
} from "./types.ts";

function renderCodexLookView(
    view: CodexLookView,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
) {
    switch (view.kind) {
        case "call":
            return renderThirdPartyCall(theme, {
                state: view.state ?? callState(context),
                statusText: view.label,
                body: view.body,
                maxRenderedLines: view.maxRenderedLines ?? 4,
                expanded: context.expanded,
                ...(view.expandable === undefined ? {} : { expandable: view.expandable }),
            });
        case "output":
            return renderCodexOutput(theme, view.text, {
                expanded: options.expanded,
                mode: view.mode ?? "headTail",
                maxPreviewLines: view.maxPreviewLines ?? 4,
                noOutputLabel: view.noOutputLabel ?? null,
                ...(view.syntax === undefined ? {} : { syntax: view.syntax }),
            });
        case "sections":
            return renderCodexOutput(theme, sectionText(view.sections, theme), {
                expanded: options.expanded,
                mode: "headTail",
                maxPreviewLines: view.maxPreviewLines ?? 6,
                noOutputLabel: null,
            });
        case "empty":
            return emptyComponent();
    }
}

function sectionText(sections: readonly CodexLookSection[], theme: CodexRenderTheme): string {
    return sections.map((section) => formatSection(section, theme)).join("\n");
}

function formatSection(section: CodexLookSection, theme: CodexRenderTheme): string {
    switch (section.kind) {
        case "text":
            return section.text;
        case "summary":
            return section.label === undefined
                ? section.text
                : `${theme.fg("accent", section.label)} ${theme.fg("dim", "→")} ${section.text}`;
        case "code":
            return section.title === undefined ? section.text : `${section.title}\n${section.text}`;
    }
    return "";
}

/** Creates a renderer from a passive `codexLookRendering` adapter object. */
export function createProtocolRenderer(
    adapter: CodexLookRenderingAdapter,
    fallback: ThirdPartyToolRenderer,
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const view = adapter.renderCall?.(args, context);
            if (view === undefined) {
                return fallback.renderCall(args, theme, context);
            }
            return renderCodexLookView(view, theme, context, {
                expanded: context.expanded,
                isPartial: context.isPartial,
            });
        },
        renderResult(result, options, theme, context) {
            const view = adapter.renderResult?.(result, options, context);
            if (view === undefined) {
                return fallback.renderResult(result, options, theme, context);
            }
            return renderCodexLookView(view, theme, context, options);
        },
    };
}

export function isCodexLookRenderingAdapter(value: unknown): value is CodexLookRenderingAdapter {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    if (Reflect.get(value, "version") !== 1) {
        return false;
    }
    const renderCall = Reflect.get(value, "renderCall");
    const renderResult = Reflect.get(value, "renderResult");
    return typeof renderCall === "function" || typeof renderResult === "function";
}

export function codexLookRenderingAdapter(
    toolDefinition: unknown,
    propertyName: string,
): CodexLookRenderingAdapter | undefined {
    if (
        typeof toolDefinition !== "object" ||
        toolDefinition === null ||
        Array.isArray(toolDefinition)
    ) {
        return undefined;
    }
    const value = Reflect.get(toolDefinition, propertyName);
    return isCodexLookRenderingAdapter(value) ? value : undefined;
}

export function codexLookViewState(state: CodexCallState): CodexCallState {
    return state;
}
