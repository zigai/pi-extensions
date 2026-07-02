import type { FileDiffMetadata } from "@pierre/diffs";

/** Terminal appearance used for Pierre-highlighted diffs. */
export type PierreAppearance = "dark" | "light";

/** Compact details stored on tool results for replayable Pierre diff rendering. */
export type PierreDiffDetails = {
  readonly pierreDiff?: PierreDiffPayload;
};

/** Replayable Pierre diff payload. Does not store original file snapshots or highlighted HAST. */
export type PierreDiffPayload = {
  readonly version: 1;
  readonly path: string;
  readonly metadata: FileDiffMetadata;
  readonly stats: PierreDiffStats;
};

/** Summary values used for mutation call labels and guardrails. */
export type PierreDiffStats = {
  readonly added: number;
  readonly removed: number;
  readonly lineCount: number;
  readonly sizeBytes: number;
};

/** Highlighted line trees returned by Pierre/Shiki, kept only in renderer state. */
export type HighlightedDiffCode = {
  readonly deletionLines: ReadonlyArray<unknown>;
  readonly additionLines: ReadonlyArray<unknown>;
};

/** Highlighted line trees for both Pi light and dark themes. */
export type HighlightedDiffSet = Record<PierreAppearance, HighlightedDiffCode>;

/** Styled terminal text segment. */
export type DiffSpan = {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
};

/** Unified diff row ready for terminal rendering. */
export type UnifiedDiffRow =
  | {
      readonly kind: "collapsed" | "metadata";
      readonly text: string;
      readonly fg: string;
      readonly bg: string;
    }
  | {
      readonly kind: "line";
      readonly lineType: "context" | "addition" | "deletion";
      readonly lineNumber?: number;
      readonly spans: ReadonlyArray<DiffSpan>;
      readonly rowFg: string;
      readonly rowBg: string;
      readonly lineNumberFg: string;
    };

/** One side of a side-by-side diff row. */
export type SplitDiffCell = {
  readonly lineType: "context" | "addition" | "deletion" | "empty";
  readonly lineNumber?: number;
  readonly spans: ReadonlyArray<DiffSpan>;
  readonly rowFg: string;
  readonly rowBg: string;
  readonly lineNumberFg: string;
};

/** Side-by-side diff row ready for terminal rendering. */
export type SplitDiffRow =
  | {
      readonly kind: "collapsed" | "metadata";
      readonly text: string;
      readonly fg: string;
      readonly bg: string;
    }
  | {
      readonly kind: "line";
      readonly deletion: SplitDiffCell;
      readonly addition: SplitDiffCell;
    };
