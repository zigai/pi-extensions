import type {
    ExtensionAPI,
    ExtensionContext,
    SessionEntry,
    ToolInfo,
} from "@earendil-works/pi-coding-agent";

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

// Kimi Coding plans authenticate with an API key but bill as a flat subscription.
const SUBSCRIPTION_API_KEY_PROVIDERS = new Set(["kimi-coding"]);

function getEntryCost(entry: SessionEntry): number {
    if (entry.type === "usage") return entry.usage.cost.total;

    if (entry.type === "branch_summary" || entry.type === "compaction") {
        return entry.usage?.cost.total ?? 0;
    }

    if (entry.type !== "message") return 0;
    if (entry.message.role === "assistant") return entry.message.usage.cost.total;
    if (entry.message.role === "toolResult") return entry.message.usage?.cost.total ?? 0;
    return 0;
}

export function sumSessionCost(entries: readonly SessionEntry[]): number {
    let total = 0;
    for (const entry of entries) total += getEntryCost(entry);

    return total;
}

export function isApiKeyBilled<TModel extends { provider: string }>(
    ctx: {
        model: TModel | undefined;

        modelRegistry: {
            find(provider: string, id: string): TModel | undefined;
            isUsingOAuth(model: TModel): boolean;
        };
    },
    route: FooterRoute | undefined,
): boolean {
    let model = ctx.model;
    if (route !== undefined) model = ctx.modelRegistry.find(route.provider, route.id) ?? model;
    if (model === undefined) return false;
    if (SUBSCRIPTION_API_KEY_PROVIDERS.has(model.provider)) return false;

    return !ctx.modelRegistry.isUsingOAuth(model);
}

function createSessionCostReader(sessionManager: ExtensionContext["sessionManager"]): () => number {
    let cachedKey: string | undefined;
    let cachedCost = 0;

    return () => {
        // Every session append moves the leaf, so session and leaf identify the entry set.
        const key = `${sessionManager.getSessionId()}\0${sessionManager.getLeafId() ?? ""}`;
        if (key !== cachedKey) {
            cachedCost = sumSessionCost(sessionManager.getEntries());
            cachedKey = key;
        }

        return cachedCost;
    };
}

export function createLiveFooterContext(
    ctx: ExtensionContext,
    pi: Pick<ExtensionAPI, "getAllTools">,
): FooterContext & Pick<ExtensionContext, "ui"> {
    const readSessionCost = createSessionCostReader(ctx.sessionManager);
    const liveContext: FooterContext & Pick<ExtensionContext, "ui"> = {
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
        getApiSessionCost() {
            if (!isApiKeyBilled(ctx, getFooterRoute(liveContext))) return undefined;
            return readSessionCost();
        },
    };

    return liveContext;
}
