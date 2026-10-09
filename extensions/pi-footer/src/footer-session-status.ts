import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

import type { FooterContext, FooterRoute } from "./footer-model.ts";

export function getNativeMcpServerCount(
    tools: readonly Pick<ToolInfo, "sourceInfo" | "namespace" | "exposure">[],
): number | undefined {
    const servers = new Set<string>();
    for (const tool of tools) {
        if (tool.sourceInfo.path !== "builtin:mcp" || tool.exposure === "hidden") continue;
        if (tool.namespace !== undefined) servers.add(tool.namespace.name);
    }

    if (servers.size === 0) return undefined;
    return servers.size;
}

export function getFooterRoute(ctx: FooterContext): FooterRoute | undefined {
    if (ctx.routedModel !== undefined) return ctx.routedModel;
    if (ctx.model?.api !== "pi-virtual" || ctx.sessionManager === undefined) return undefined;

    const messages = ctx.sessionManager.buildSessionProjection().messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "assistant") continue;
        if (message.stopReason === "error" || message.stopReason === "aborted") continue;
        if (message.api === "pi-virtual") continue;
        return {
            provider: message.provider,
            id: message.model,
            thinkingLevel: message.thinkingLevel,
        };
    }

    return undefined;
}

export function createLiveFooterContext(
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "getAllTools">,
): FooterContext & Pick<ExtensionContext, "ui"> {
    return {
        get cwd() {
            return ctx.cwd;
        },
        get model() {
            return ctx.model;
        },
        modelRegistry: ctx.modelRegistry,
        sessionManager: ctx.sessionManager,
        ui: ctx.ui,
        getContextUsage: () => ctx.getContextUsage(),
        getMcpServerCount: () => getNativeMcpServerCount(pi.getAllTools()),
    };
}
