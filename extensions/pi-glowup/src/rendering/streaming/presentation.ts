export type CodePreview = (input: {
    readonly key: string;
    readonly source: string;
    readonly language?: string;
    readonly path?: string;
    readonly complete: boolean;
    readonly targetWidth?: number;
    readonly invalidate?: () => void;
}) => string;

export type CodeSource = Pick<Parameters<CodePreview>[0], "key" | "source" | "language" | "path">;
