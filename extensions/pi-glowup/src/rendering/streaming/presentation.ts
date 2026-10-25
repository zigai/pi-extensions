export type CodePreview = (input: {
    readonly key: string;
    readonly source: string;
    readonly language?: string;
    readonly path?: string;
    readonly complete: boolean;
    readonly targetWidth?: number;
    readonly invalidate?: () => void;

    /** Owning tool call, used only to attribute render diagnostics. */
    readonly toolCallId?: string;
}) => string;

export type CodeSource = Pick<Parameters<CodePreview>[0], "key" | "source" | "language" | "path">;
