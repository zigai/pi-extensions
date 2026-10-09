export type TreeEntry = {
    id: string;
    parentId?: string | null;
    timestamp?: string;
    type?: string;

    message?: {
        role?: string;
        content?: unknown;
        command?: string;
        toolName?: string;
        stopReason?: string;
        errorMessage?: string;
    };

    content?: unknown;
    customType?: string;
    summary?: string;
    tokensBefore?: number;
    targetId?: string;
    replacement?: { content: unknown } | null;
    modelId?: string;
    thinkingLevel?: string;
    label?: string;
    name?: string;
};

export type TreeNode = {
    entry: TreeEntry;
    label?: string;
    labelTimestamp?: string;
};

export type FlatTreeNode = {
    node: TreeNode;
    indent: number;
    showConnector: boolean;
    isLast: boolean;
    gutters: Array<{ position: number; show: boolean }>;
    isVirtualRootChild: boolean;
};
