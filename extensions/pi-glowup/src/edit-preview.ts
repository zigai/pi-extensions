export type EditPreview = {
    readonly path: string;
    readonly added: number;
    readonly removed: number;
};

function countDiffStats(diff: string): { readonly added: number; readonly removed: number } {
    let added = 0;
    let removed = 0;
    let lineStart = 0;

    for (let index = 0; index <= diff.length; index += 1) {
        if (index < diff.length && diff.charCodeAt(index) !== 10) {
            continue;
        }

        if (matchesDiffStatLine(diff, lineStart, index, 43)) {
            added += 1;
        } else if (matchesDiffStatLine(diff, lineStart, index, 45)) {
            removed += 1;
        }
        lineStart = index + 1;
    }

    return { added, removed };
}

function matchesDiffStatLine(
    text: string,
    start: number,
    end: number,
    markerCode: number,
): boolean {
    if (start >= end || text.charCodeAt(start) !== markerCode) {
        return false;
    }

    let index = start + 1;
    while (index < end && isWhitespace(text.charCodeAt(index))) {
        index += 1;
    }

    const digitStart = index;
    while (index < end && isDigit(text.charCodeAt(index))) {
        index += 1;
    }

    return index > digitStart && index < end && isWhitespace(text.charCodeAt(index));
}

function isDigit(charCode: number): boolean {
    return charCode >= 48 && charCode <= 57;
}

function isWhitespace(charCode: number): boolean {
    return (
        charCode === 9 ||
        charCode === 10 ||
        charCode === 11 ||
        charCode === 12 ||
        charCode === 13 ||
        charCode === 32
    );
}

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
            typeof maxEntriesOrOptions === "number"
                ? { maxEntries: maxEntriesOrOptions }
                : maxEntriesOrOptions;
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
            const oldestKey = this.previewsByToolCallId.keys().next().value;
            if (typeof oldestKey !== "string") {
                return;
            }
            this.delete(oldestKey);
        }
    }
}

export class EditPreviewStore extends PreviewStore<EditPreview> {}
