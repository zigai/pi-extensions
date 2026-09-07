import { countDiffStats } from "../../rendering/diff/statistics.ts";

export type EditPreview = {
    readonly path: string;
    readonly added: number;
    readonly removed: number;
};

/** Builds display-only edit preview metadata from Pi's built-in edit diff. */
export function buildEditPreview(options: {
    readonly path: string;
    readonly diff: string;
}): EditPreview {
    const stats = countDiffStats(options.diff);
    return {
        path: options.path,
        added: stats.added,
        removed: stats.removed,
    };
}

type PreviewStoreOptions<TPreview> = {
    readonly maxEntries: number;
    readonly maxBytes?: number;
    readonly measureBytes?: (preview: TPreview) => number;
};

export type PreviewStoreStats = {
    readonly entries: number;
    readonly bytes: number;
};

/** Bounded in-memory previews keyed by Pi tool call id. */
export class PreviewStore<TPreview> {
    private readonly maxEntries: number;
    private readonly maxBytes: number | undefined;
    private readonly measureBytes: ((preview: TPreview) => number) | undefined;
    private readonly previewsByToolCallId = new Map<string, TPreview>();
    private readonly previewBytesByToolCallId = new Map<string, number>();
    private totalBytes = 0;

    constructor(maxEntriesOrOptions: number | PreviewStoreOptions<TPreview>) {
        const options =
            maxEntriesOrOptions instanceof Object && "maxEntries" in maxEntriesOrOptions
                ? maxEntriesOrOptions
                : { maxEntries: maxEntriesOrOptions };
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
        this.maxBytes =
            options.maxBytes === undefined ? undefined : Math.max(1, Math.floor(options.maxBytes));
        this.measureBytes = options.measureBytes;
    }

    set(toolCallId: string, preview: TPreview): void {
        this.delete(toolCallId);

        const previewBytes = this.measureBytes?.(preview) ?? 0;

        this.previewsByToolCallId.set(toolCallId, preview);
        this.previewBytesByToolCallId.set(toolCallId, previewBytes);
        this.totalBytes += previewBytes;
        this.trim();
    }

    get(toolCallId: string): TPreview | undefined {
        return this.previewsByToolCallId.get(toolCallId);
    }

    clear(): void {
        this.previewsByToolCallId.clear();
        this.previewBytesByToolCallId.clear();
        this.totalBytes = 0;
    }

    stats(): PreviewStoreStats {
        return {
            entries: this.previewsByToolCallId.size,
            bytes: this.totalBytes,
        };
    }

    private delete(toolCallId: string): void {
        if (!this.previewsByToolCallId.delete(toolCallId)) {
            return;
        }

        this.totalBytes -= this.previewBytesByToolCallId.get(toolCallId) ?? 0;
        this.previewBytesByToolCallId.delete(toolCallId);
    }

    private trim(): void {
        while (
            this.previewsByToolCallId.size > this.maxEntries ||
            (this.maxBytes !== undefined && this.totalBytes > this.maxBytes)
        ) {
            const oldest = this.previewsByToolCallId.keys().next();
            if (oldest.done === true) {
                return;
            }
            this.delete(oldest.value);
        }
    }
}

export class EditPreviewStore extends PreviewStore<EditPreview> {}
