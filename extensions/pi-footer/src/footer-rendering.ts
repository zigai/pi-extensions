import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { getFooterSlotSnapshots, subscribeFooterSlotUpdates } from "./footer-slot-api.ts";
import { getFooterRoute } from "./footer-session-status.ts";
import {
    createGitAheadBehindTracker,
    formatGitAheadBehind,
    type GitAheadBehindSource,
} from "./git-ahead-behind.ts";
import { DEFAULT_FOOTER_CONFIG, type FooterConfig } from "./settings.ts";
import type {
    ContextUsage,
    FooterContext,
    FooterData,
    FooterItem,
    FooterLayout,
    FooterSlotId,
    FooterSlotSnapshot,
    FooterSide,
    FooterVariant,
} from "./footer-model.ts";

const ACTIVE_FOOTER_VARIANT = "plain" as const;
const BRANCH_ICON = "";

export type PlainFooterTheme = {
    fg(role: "muted" | "dim", text: string): string;
};

function sanitizeStatusText(text: string): string {
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}

function formatTokens(count: number): string {
    if (count < 1000) return count.toString();
    if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000) return `${Math.round(count / 1000)}k`;
    if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}

function collapseHome(path: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home !== undefined && home.length > 0 && path.startsWith(home)) {
        return `~${path.slice(home.length)}`;
    }

    return path;
}

function renderBlockItem(item: FooterItem): string {
    return ` ${item.text} `;
}

function renderThemeText(
    text: string,
    role: "muted" | "dim",
    theme: PlainFooterTheme | undefined,
): string {
    if (theme === undefined) return text;
    return theme.fg(role, text);
}

function renderPlainItem(item: FooterItem, theme: PlainFooterTheme | undefined): string {
    return renderThemeText(item.text, "muted", theme);
}

function getFallbackProviderDisplayName(provider: string): string {
    switch (provider) {
        case "github-copilot":
            return "copilot";
        default:
            return provider;
    }
}

function getProviderDisplayName(ctx: FooterContext, provider: string): string {
    const snapshotDisplayName = ctx.model?.providerDisplayName;
    if (snapshotDisplayName !== undefined && snapshotDisplayName.length > 0) {
        return snapshotDisplayName;
    }

    try {
        const registryDisplayName = ctx.modelRegistry?.getProviderDisplayName(provider);
        if (registryDisplayName !== undefined && registryDisplayName.length > 0) {
            return registryDisplayName;
        }
    } catch {
        return getFallbackProviderDisplayName(provider);
    }

    return getFallbackProviderDisplayName(provider);
}

function getContextText(usage: ContextUsage, fallbackWindow?: number): string {
    const contextWindow = usage?.contextWindow ?? fallbackWindow ?? 0;
    const contextPercent = usage?.percent;
    if (contextPercent === null || contextPercent === undefined) {
        return `?/${formatTokens(contextWindow)}`;
    }

    return `${contextPercent.toFixed(1)}%/${formatTokens(contextWindow)}`;
}

function getMcpText(ctx: FooterContext, footerData: FooterData): string | null {
    const statuses = Array.from(footerData.getExtensionStatuses().values())
        .map(sanitizeStatusText)
        .filter((status) => status.length > 0);

    const mcpStatus = statuses.find((status) => /^MCP:/i.test(status));
    if (mcpStatus !== undefined && mcpStatus.length > 0) return mcpStatus;

    const serverCount = ctx.getMcpServerCount?.() ?? ctx.mcpServers?.length;
    if (serverCount !== undefined) {
        return `MCP: ${serverCount} servers`;
    }

    return null;
}

function getSeparator(
    variant: FooterVariant,
    config: FooterConfig,
    theme: PlainFooterTheme | undefined,
): string {
    if (variant === "blocks") return "";

    return renderThemeText(` ${config.separator} `, "dim", theme);
}

function renderItem(
    item: FooterItem,
    variant: FooterVariant,
    theme: PlainFooterTheme | undefined,
): string {
    if (variant === "blocks") {
        return renderBlockItem(item);
    }

    return renderPlainItem(item, theme);
}

function joinRenderedItems(
    rendered: string[],
    variant: FooterVariant,
    config: FooterConfig,
    theme: PlainFooterTheme | undefined,
): string {
    return rendered.join(getSeparator(variant, config, theme));
}

function buildSideVariants(
    itemsByKey: ReadonlyMap<FooterSlotId, FooterItem>,
    keys: readonly FooterSlotId[],
    variant: FooterVariant,
    side: FooterSide,
    config: FooterConfig,
    theme: PlainFooterTheme | undefined,
): string[] {
    const items = keys
        .map((key) => itemsByKey.get(key))
        .filter((item): item is FooterItem => item !== undefined);
    if (items.length === 0) {
        return [""];
    }

    const variants: string[] = [];
    const seen = new Set<string>();

    if (side === "left") {
        for (let count = items.length; count >= 1; count--) {
            const rendered = joinRenderedItems(
                items.slice(0, count).map((item) => renderItem(item, variant, theme)),
                variant,
                config,
                theme,
            );
            if (!seen.has(rendered)) {
                seen.add(rendered);
                variants.push(rendered);
            }
        }
    } else {
        for (let start = 0; start < items.length; start++) {
            const rendered = joinRenderedItems(
                items.slice(start).map((item) => renderItem(item, variant, theme)),
                variant,
                config,
                theme,
            );
            if (!seen.has(rendered)) {
                seen.add(rendered);
                variants.push(rendered);
            }
        }

        variants.push("");
    }

    return variants;
}

function renderPadding(
    width: number,
    variant: FooterVariant,
    theme: PlainFooterTheme | undefined,
): string {
    if (width <= 0) return "";

    const padding = " ".repeat(width);
    if (variant === "plain") {
        return renderThemeText(padding, "muted", theme);
    }

    return padding;
}

function buildFooterItems(
    ctx: FooterContext,
    footerData: FooterData,
    thinkingLevel: string,
    customSlots: readonly FooterSlotSnapshot[],
    gitAheadBehindSource: GitAheadBehindSource | undefined,
): Map<FooterSlotId, FooterItem> {
    const branch = footerData.getGitBranch();
    const pathText = collapseHome(ctx.cwd);
    const providerId = ctx.model?.provider ?? "no-provider";
    const providerLabel = getProviderDisplayName(ctx, providerId);
    let modelLabel = ctx.model?.name ?? ctx.model?.id ?? "no-model";
    const route = getFooterRoute(ctx);
    if (route !== undefined) {
        modelLabel += ` → ${route.id}`;
        if (route.thinkingLevel !== undefined) modelLabel += ` • ${route.thinkingLevel}`;
    }

    const usage = ctx.getContextUsage();
    const contextText = getContextText(usage, ctx.model?.contextWindow);
    const mcpText = getMcpText(ctx, footerData);
    const items = new Map<FooterSlotId, FooterItem>();
    items.set("path", {
        key: "path",
        text: pathText,
        colors: { bg: "", fg: "" },
    });
    items.set("provider", {
        key: "provider",
        text: providerLabel,
        colors: { bg: "", fg: "" },
    });
    items.set("model", {
        key: "model",
        text: modelLabel,
        colors: { bg: "", fg: "" },
    });
    items.set("thinking", {
        key: "thinking",
        text: thinkingLevel,
        colors: { bg: "", fg: "" },
    });
    items.set("context", {
        key: "context",
        text: contextText,
        colors: { bg: "", fg: "" },
    });

    if (branch !== null && branch.length > 0) {
        const gitAheadBehind = gitAheadBehindSource?.getGitAheadBehind();
        let branchText = `${BRANCH_ICON} ${branch}`;
        if (gitAheadBehind !== undefined) {
            branchText += ` ${formatGitAheadBehind(gitAheadBehind)}`;
        }

        items.set("branch", {
            key: "branch",
            text: branchText,
            colors: { bg: "", fg: "" },
        });
    }

    if (mcpText !== null && mcpText.length > 0) {
        items.set("mcp", {
            key: "mcp",
            text: mcpText,
            colors: { bg: "", fg: "" },
        });
    }

    for (const slot of customSlots) {
        items.set(slot.id, {
            key: slot.id,
            text: slot.text,
            colors: slot.colors,
        });
    }

    return items;
}

function resolveFooterLayout(
    configLayout: FooterLayout,
    customSlots: readonly FooterSlotSnapshot[],
): Pick<FooterLayout, "left" | "right"> {
    const hiddenIds = new Set(configLayout.hidden);
    const left: FooterSlotId[] = [];
    const right: FooterSlotId[] = [];

    for (const slotId of configLayout.left) {
        if (!hiddenIds.has(slotId)) {
            left.push(slotId);
        }
    }

    for (const slotId of configLayout.right) {
        if (!hiddenIds.has(slotId)) {
            right.push(slotId);
        }
    }

    const configuredIds = new Set<FooterSlotId>([...hiddenIds, ...left, ...right]);
    for (const slot of customSlots) {
        if (slot.defaultSide === undefined) continue;
        if (configuredIds.has(slot.id)) continue;

        if (slot.defaultSide === "left") {
            left.push(slot.id);
        } else {
            right.push(slot.id);
        }

        configuredIds.add(slot.id);
    }

    return { left, right };
}

export function createFooterComponent(
    ctx: FooterContext,
    footerData: FooterData,
    getThinkingLevel: () => string,
    requestRender: () => void,
    config: FooterConfig = DEFAULT_FOOTER_CONFIG,
    theme?: PlainFooterTheme,
    gitAheadBehindSource?: GitAheadBehindSource,
) {
    let activeGitAheadBehindSource: GitAheadBehindSource | undefined;
    if (config.showGitAheadBehind) {
        activeGitAheadBehindSource = gitAheadBehindSource;
        activeGitAheadBehindSource ??= createGitAheadBehindTracker(ctx.cwd, requestRender);
    }

    const unsubscribeBranchChange = footerData.onBranchChange(() => {
        activeGitAheadBehindSource?.refresh();
        requestRender();
    });
    const unsubscribeSlotUpdates = subscribeFooterSlotUpdates(() => requestRender());

    return {
        dispose() {
            unsubscribeBranchChange();
            unsubscribeSlotUpdates();
            activeGitAheadBehindSource?.dispose();
        },
        invalidate() {},
        render(width: number): string[] {
            // Keep spare terminal cells unused as a guard against ambiguous-width
            // glyphs (notably Nerd Font icons like the branch icon). A footer line
            // that reaches the exact terminal width can soft-wrap into an apparent
            // blank line and make the bottom chrome jump during heavy tool output.
            const renderWidth = Math.max(0, width - 2);
            if (renderWidth === 0) return [""];

            const variant: FooterVariant = ACTIVE_FOOTER_VARIANT;
            const customSlots = getFooterSlotSnapshots();
            const layout = resolveFooterLayout(config.layout, customSlots);
            const itemsByKey = buildFooterItems(
                ctx,
                footerData,
                getThinkingLevel(),
                customSlots,
                activeGitAheadBehindSource,
            );
            const leftVariants = buildSideVariants(
                itemsByKey,
                layout.left,
                variant,
                "left",
                config,
                theme,
            );
            const rightVariants = buildSideVariants(
                itemsByKey,
                layout.right,
                variant,
                "right",
                config,
                theme,
            );

            for (const left of leftVariants) {
                for (const right of rightVariants) {
                    const rightWidth = visibleWidth(right);
                    const leftWidth = visibleWidth(left);
                    const edgePaddingWidth = 2;
                    let minimumInnerGap = 0;
                    if (right.length > 0) {
                        minimumInnerGap = 1;
                    }

                    const requiredWidth =
                        edgePaddingWidth + leftWidth + minimumInnerGap + rightWidth;

                    if (requiredWidth > renderWidth) {
                        continue;
                    }

                    const paddingWidth = Math.max(
                        minimumInnerGap,
                        renderWidth - edgePaddingWidth - leftWidth - rightWidth,
                    );
                    const padding = renderPadding(paddingWidth, variant, theme);
                    if (right.length > 0) {
                        return [truncateToWidth(` ${left}${padding}${right} `, renderWidth, "")];
                    }

                    return [truncateToWidth(` ${left}${padding} `, renderWidth, "")];
                }
            }

            const fallbackRight = rightVariants.find((value) => value.length > 0) ?? "";
            if (fallbackRight.length > 0) {
                return [truncateToWidth(fallbackRight, renderWidth, "")];
            }

            const fallbackLeft = leftVariants.find((value) => value.length > 0) ?? "";
            return [truncateToWidth(fallbackLeft, renderWidth, "")];
        },
    };
}
