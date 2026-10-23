import type { Component } from "@earendil-works/pi-tui";
import type { GlowupNode } from "../tools/protocol/contract.ts";
import { renderProtocolNode } from "../tools/protocol/node-renderer.ts";
import { createOutlineRenderer, renderOutlineNode } from "./outline.ts";
import type { GlowupRenderTheme } from "./theme.ts";
import type { ToolLabelMode } from "./status-labels.ts";
import type { MutationSettings } from "./preview-settings.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderingOptions,
} from "../tools/types.ts";

export type GlowupPresentation = {
    readonly renderNode: (
        node: GlowupNode,
        theme: GlowupRenderTheme,
        context: ThirdPartyToolRenderContext,
        labelMode: ToolLabelMode,
        mutations?: MutationSettings,
    ) => Component;

    readonly createRenderer: (
        toolName: string,
        renderer: ThirdPartyToolRenderer,
        options?: ThirdPartyToolRenderingOptions,
    ) => ThirdPartyToolRenderer;
};

export const compactPresentation: GlowupPresentation = {
    renderNode: renderProtocolNode,
    createRenderer: (_name, renderer) => renderer,
};

export const outlinePresentation: GlowupPresentation = {
    renderNode: renderOutlineNode,
    createRenderer: (name, renderer, options) =>
        createOutlineRenderer(name, options?.labelMode, renderer.codeSource, options?.streamCode),
};
