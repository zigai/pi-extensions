import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type FooterVariant = "blocks" | "plain";
export type FooterSide = "left" | "right";
export type FooterKey = "path" | "branch" | "provider" | "model" | "thinking" | "mcp" | "context";
export type FooterCustomSlotId = `${string}.${string}`;
export type FooterSlotId = FooterKey | FooterCustomSlotId;
export type Rgb = [number, number, number];
export type SegmentColors = { bg: string; fg: string };
export type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;

export type FooterLayout = {
    readonly left: readonly FooterSlotId[];
    readonly right: readonly FooterSlotId[];
    readonly hidden: readonly FooterSlotId[];
};

export type FooterRoute = {
    provider: string;
    id: string;
    thinkingLevel?: string;
};

export type FooterModel = {
    api?: string;
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    providerDisplayName?: string;
};

export type ProviderDisplayNameRegistry = {
    getProviderDisplayName(provider: string): string;
};

export type FooterContext = {
    cwd: string;
    model?: FooterModel;
    modelRegistry?: ProviderDisplayNameRegistry;
    mcpServers?: unknown[];
    getMcpServerCount?(): number | undefined;
    routedModel?: FooterRoute;
    sessionManager?: Pick<ExtensionContext["sessionManager"], "buildSessionProjection">;
    getContextUsage(): ContextUsage;
};

export type FooterData = {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(callback: () => void): () => void;
};

export type FooterItem = {
    key: FooterSlotId;
    text: string;
    colors: SegmentColors;
};

export type FooterSlotSnapshot = {
    readonly id: FooterCustomSlotId;
    readonly text: string;
    readonly colors: SegmentColors;
    readonly defaultSide?: FooterSide;
};

export const FOOTER_CUSTOM_SLOT_ID_PATTERN = "^[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+$";
