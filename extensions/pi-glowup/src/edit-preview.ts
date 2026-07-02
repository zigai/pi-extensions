export type EditPreview = {
  readonly path: string;
  readonly diff: string;
  readonly added: number;
  readonly removed: number;
};

const addCountPattern = /^\+\s*\d+\s/;
const removeCountPattern = /^-\s*\d+\s/;

function countDiffStats(diff: string): { readonly added: number; readonly removed: number } {
  const lines = diff.split("\n").filter((line) => line.length > 0);
  return {
    added: lines.filter((line) => addCountPattern.test(line)).length,
    removed: lines.filter((line) => removeCountPattern.test(line)).length,
  };
}

/** Builds display-only edit preview metadata from Pi's built-in edit diff. */
export function buildEditPreview(options: {
  readonly path: string;
  readonly diff: string;
}): EditPreview {
  const stats = countDiffStats(options.diff);
  return {
    path: options.path,
    diff: options.diff,
    added: stats.added,
    removed: stats.removed,
  };
}

/** Bounded in-memory previews keyed by Pi tool call id. */
class PreviewStore<TPreview> {
  private readonly maxEntries: number;
  private readonly previewsByToolCallId = new Map<string, TPreview>();

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  set(toolCallId: string, preview: TPreview): void {
    if (this.previewsByToolCallId.has(toolCallId)) {
      this.previewsByToolCallId.delete(toolCallId);
    }
    this.previewsByToolCallId.set(toolCallId, preview);

    while (this.previewsByToolCallId.size > this.maxEntries) {
      const oldestKey = this.previewsByToolCallId.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.previewsByToolCallId.delete(oldestKey);
    }
  }

  get(toolCallId: string): TPreview | undefined {
    return this.previewsByToolCallId.get(toolCallId);
  }

  clear(): void {
    this.previewsByToolCallId.clear();
  }
}

export class EditPreviewStore extends PreviewStore<EditPreview> {}
