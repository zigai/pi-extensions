import type { Component } from "@earendil-works/pi-tui";
import { scheduleCodeOutputSyntaxLoad } from "../syntax/code-component.ts";
import {
    countContentLines,
    hasNonWhitespaceText,
    truncateGraphemeText,
    truncateUtf8ByGrapheme,
} from "../text-boundaries.ts";
import {
    emptyComponent,
    formatPathTarget,
    renderGlowupCall,
    renderGlowupDiff,
    renderGlowupOutput,
    renderMutationCall,
    MUTATION_DIFF_PREVIEW_ROWS,
    toolExpandHint,
    type GlowupDiffRenderOptions,
    type GlowupRenderTheme,
    type DiffSection,
    type MutationCallRenderOptions,
} from "./core.ts";
import { isActiveToolCall, toolStatusLabel, type ToolLabelMode } from "./status-labels.ts";
import {
    PREVIEW_MUTATION_SETTINGS,
    showsFullMutation,
    type MutationSettings,
} from "../mutations/settings.ts";

const WRITE_PREVIEW_TRUNCATION_SUFFIX = "\n… write preview truncated";

export type WriteCallArgs = {
    readonly path?: string;
    readonly content?: string;
};

export type WriteCallContext = {
    readonly toolCallId?: string;
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly argsComplete?: boolean;
    readonly expanded: boolean;
    readonly lastComponent?: Component | undefined;
    readonly labelMode?: ToolLabelMode;
    readonly mutationLabelColumnWidth?: number;
    readonly movingViewport?: boolean;
    readonly mutationSettings?: MutationSettings;
    readonly invalidate?: () => void;
};

const PARTIAL_WRITE_PREVIEW_LINES = MUTATION_DIFF_PREVIEW_ROWS;

function writeDiffRenderOptions(
    collapsedLineBudget: number,
    showAllRows: boolean,
): GlowupDiffRenderOptions {
    let options: GlowupDiffRenderOptions = { collapsedLineBudget };
    if (!showAllRows) {
        options = { ...options, maxWrappedRows: 1 };
    }
    return options;
}

function writeMutationCallOptions(
    labelColumnWidth: number | undefined,
    body: Component,
    state: "running" | "success",
): MutationCallRenderOptions {
    let options: MutationCallRenderOptions = {};
    if (labelColumnWidth !== undefined) {
        options = { ...options, labelColumnWidth };
    }
    return { ...options, body, state };
}
const PARTIAL_WRITE_HEAD_LINES = PARTIAL_WRITE_PREVIEW_LINES;
const PARTIAL_WRITE_MOVING_TAIL_LINES = PARTIAL_WRITE_PREVIEW_LINES;
const MAX_PARTIAL_WRITE_LINE_CHARS = 2_000;

type PartialWritePreviewUpdate = {
    readonly toolCallId: string;
    readonly theme: GlowupRenderTheme;
    readonly path: string;
    readonly content: string;
    readonly labelMode: ToolLabelMode;
    readonly mutationLabelColumnWidth: number | undefined;
    readonly movingViewport: boolean;
    readonly expanded: boolean;
    readonly maxWritePreviewBytes: number | null;
};

function boundedPartialWriteLine(line: string): string {
    return truncateGraphemeText(line, MAX_PARTIAL_WRITE_LINE_CHARS);
}

function writeDiffSection(path: string, preview: string, totalLines: number): DiffSection {
    const previewLines = preview.split("\n");
    if (previewLines.length > totalLines && previewLines.at(-1) === "") {
        previewLines.pop();
    }
    const contentLineCount = previewLines.filter((line) => !line.startsWith("… ")).length;
    let lineNumber =
        previewLines[0]?.startsWith("… ") === true
            ? Math.max(1, totalLines - contentLineCount + 1)
            : 1;
    return {
        path,
        lines: previewLines.map((line) => {
            if (line.startsWith("… ")) {
                return `  ${line}`;
            }
            const rendered = `+${lineNumber} ${line}`;
            lineNumber += 1;
            return rendered;
        }),
        added: totalLines,
        removed: 0,
    };
}

class PartialWriteContentPreview {
    private scannedLength = 0;
    private newlineCount = 0;
    private endsWithLineBreak = false;
    private sawContent = false;
    private displayLineCount = 0;
    private readonly headLines: string[] = [];
    private readonly tailLines: string[] = [];
    private pendingBlankLineCount = 0;
    private readonly pendingBlankLineSamples: string[] = [];
    private currentLine = "";

    update(content: string): void {
        this.reset();
        this.consume(content, 0);
        this.scannedLength = content.length;
    }

    lineCount(): number {
        if (this.scannedLength === 0) {
            return 0;
        }
        return this.newlineCount + (this.endsWithLineBreak ? 0 : 1);
    }

    previewText(options: { readonly movingViewport: boolean }): string {
        const snapshot = this.previewSnapshot();
        if (snapshot.lineCount === 0) {
            return "";
        }
        if (!options.movingViewport) {
            return this.headPreviewText(snapshot);
        }
        return this.movingPreviewText(snapshot);
    }

    private headPreviewText(snapshot: PreviewSnapshot): string {
        const lines = snapshot.headLines.slice(0, PARTIAL_WRITE_HEAD_LINES);
        if (snapshot.lineCount <= lines.length) {
            return lines.join("\n");
        }
        return [
            ...lines,
            `… +${snapshot.lineCount - lines.length} lines (${toolExpandHint()})`,
        ].join("\n");
    }

    private movingPreviewText(snapshot: PreviewSnapshot): string {
        if (snapshot.lineCount <= PARTIAL_WRITE_PREVIEW_LINES) {
            return snapshot.headLines.slice(0, snapshot.lineCount).join("\n");
        }
        const tailLines = snapshot.tailLines.slice(-PARTIAL_WRITE_MOVING_TAIL_LINES);
        return [
            `… +${snapshot.lineCount - tailLines.length} lines (${toolExpandHint()})`,
            ...tailLines,
        ].join("\n");
    }

    private reset(): void {
        this.scannedLength = 0;
        this.newlineCount = 0;
        this.endsWithLineBreak = false;
        this.sawContent = false;
        this.displayLineCount = 0;
        this.headLines.length = 0;
        this.tailLines.length = 0;
        this.pendingBlankLineCount = 0;
        this.pendingBlankLineSamples.length = 0;
        this.currentLine = "";
    }

    private consume(content: string, start: number): void {
        let lineStart = start;
        let index = start;
        if (start > 0 && content.charCodeAt(start - 1) === 13 && content.charCodeAt(start) === 10) {
            lineStart = start + 1;
            index = start + 1;
        }
        for (; index < content.length; index += 1) {
            const charCode = content.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                this.endsWithLineBreak = false;
                continue;
            }

            this.consumeLine(`${this.currentLine}${content.slice(lineStart, index)}`);
            this.currentLine = "";
            this.newlineCount += 1;
            this.endsWithLineBreak = true;
            if (charCode === 13 && content.charCodeAt(index + 1) === 10) {
                index += 1;
            }
            lineStart = index + 1;
        }

        if (lineStart < content.length) {
            this.currentLine = boundedPartialWriteLine(
                `${this.currentLine}${content.slice(lineStart)}`,
            );
        }
    }

    private consumeLine(line: string): void {
        const boundedLine = boundedPartialWriteLine(line);
        if (!hasNonWhitespaceText(boundedLine)) {
            if (this.sawContent) {
                this.pendingBlankLineCount += 1;
                if (this.pendingBlankLineSamples.length < PARTIAL_WRITE_HEAD_LINES) {
                    this.pendingBlankLineSamples.push(boundedLine);
                }
            }
            return;
        }

        this.sawContent = true;
        this.flushPendingBlankLines();
        this.appendDisplayLine(boundedLine);
    }

    private flushPendingBlankLines(): void {
        for (let index = 0; index < this.pendingBlankLineCount; index += 1) {
            this.appendDisplayLine(this.pendingBlankLineSamples[index] ?? "");
        }
        this.pendingBlankLineCount = 0;
        this.pendingBlankLineSamples.length = 0;
    }

    private appendDisplayLine(line: string): void {
        this.displayLineCount += 1;
        if (this.headLines.length < PARTIAL_WRITE_PREVIEW_LINES) {
            this.headLines.push(line);
        }
        this.appendTailLine(line);
    }

    private appendTailLine(line: string): void {
        this.tailLines.push(line);
        if (this.tailLines.length > PARTIAL_WRITE_MOVING_TAIL_LINES) {
            this.tailLines.shift();
        }
    }

    private previewSnapshot(): PreviewSnapshot {
        const headLines = [...this.headLines];
        const tailLines = [...this.tailLines];
        let lineCount = this.displayLineCount;
        const appendLine = (line: string): void => {
            lineCount += 1;
            if (headLines.length < PARTIAL_WRITE_PREVIEW_LINES) {
                headLines.push(line);
            }
            tailLines.push(line);
            if (tailLines.length > PARTIAL_WRITE_MOVING_TAIL_LINES) {
                tailLines.shift();
            }
        };
        const currentLine = boundedPartialWriteLine(this.currentLine);
        if (!hasNonWhitespaceText(currentLine)) {
            return { headLines, tailLines, lineCount };
        }

        if (this.sawContent) {
            for (let index = 0; index < this.pendingBlankLineCount; index += 1) {
                appendLine(this.pendingBlankLineSamples[index] ?? "");
            }
        }
        appendLine(currentLine);
        return { headLines, tailLines, lineCount };
    }
}

type PreviewSnapshot = {
    readonly headLines: readonly string[];
    readonly tailLines: readonly string[];
    readonly lineCount: number;
};

class PartialWriteCallPreviewComponent implements Component {
    private readonly preview = new PartialWriteContentPreview();
    private readonly toolCallId: string;
    private theme: GlowupRenderTheme;
    private path = "";
    private labelMode: ToolLabelMode = "static";
    private mutationLabelColumnWidth: number | undefined;
    private movingViewport = true;
    private expanded = false;
    private expandedContent = "";
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(update: PartialWritePreviewUpdate) {
        this.toolCallId = update.toolCallId;
        this.theme = update.theme;
        this.update(update);
    }

    belongsTo(toolCallId: string): boolean {
        return this.toolCallId === toolCallId;
    }

    update(update: PartialWritePreviewUpdate): void {
        this.theme = update.theme;
        this.path = update.path;
        this.labelMode = update.labelMode;
        this.mutationLabelColumnWidth = update.mutationLabelColumnWidth;
        this.movingViewport = update.movingViewport;
        this.expanded = update.expanded;
        this.expandedContent = update.expanded
            ? boundedWriteContentPreview(update.content, update.maxWritePreviewBytes)
            : "";
        this.preview.update(update.content);
        this.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const added = this.preview.lineCount();
        const previewText = this.expanded
            ? this.expandedContent
            : this.preview.previewText({ movingViewport: this.movingViewport });
        const body =
            previewText.length === 0
                ? renderGlowupOutput(this.theme, "", {
                      expanded: false,
                      mode: "head",
                      maxPreviewLines: 1,
                      noOutputLabel: "(empty file)",
                  })
                : renderGlowupDiff(
                      this.theme,
                      [writeDiffSection(this.path, previewText, added)],
                      true,
                      writeDiffRenderOptions(PARTIAL_WRITE_PREVIEW_LINES, this.expanded),
                  );
        const component = renderMutationCall(
            this.theme,
            {
                label: toolStatusLabel(
                    this.labelMode,
                    { isPartial: true },
                    {
                        static: "Write",
                        active: "Writing",
                        completed: "Wrote",
                    },
                ),
                path: this.path,
                added,
                removed: 0,
            },
            writeMutationCallOptions(this.mutationLabelColumnWidth, body, "running"),
        );
        const lines = component.render(width);
        this.cachedWidth = width;
        this.cachedLines = lines;
        return lines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }
}

function boundedWriteContentPreview(content: string, maxBytes: number | null): string {
    if (maxBytes === null || Buffer.byteLength(content, "utf8") <= maxBytes) {
        return content;
    }

    const maxContentBytes = Math.max(
        0,
        maxBytes - Buffer.byteLength(WRITE_PREVIEW_TRUNCATION_SUFFIX, "utf8"),
    );
    return `${truncateUtf8ByGrapheme(content, maxContentBytes)}${WRITE_PREVIEW_TRUNCATION_SUFFIX}`;
}

/** Returns the built-in write tool content argument when it is available to render. */
function writeContentFromArgs(args: WriteCallArgs): string | undefined {
    return args.content;
}

/** Renders a built-in write call with a bounded preview of the content being written. */
export function renderWriteCallPreview(
    args: WriteCallArgs,
    theme: GlowupRenderTheme,
    context: WriteCallContext,
): Component {
    const path = args.path ?? "";
    const content = writeContentFromArgs(args);
    const labelMode = context.labelMode ?? "static";
    const mutationSettings = context.mutationSettings ?? PREVIEW_MUTATION_SETTINGS;
    const statusText = toolStatusLabel(labelMode, context, {
        static: "Write",
        active: "Writing",
        completed: "Wrote",
    });
    if (content === undefined && isActiveToolCall(context)) {
        return emptyComponent();
    }
    if (content === undefined || context.isError) {
        return renderGlowupCall(theme, {
            state: context.isError ? "error" : "success",
            statusText: context.isError ? "Write" : statusText,
            body: formatPathTarget(theme, path),
        });
    }
    scheduleCodeOutputSyntaxLoad({ path }, context.invalidate, content);

    if (context.isPartial) {
        const update = {
            toolCallId: context.toolCallId ?? "",
            theme,
            path,
            content,
            labelMode,
            mutationLabelColumnWidth: context.mutationLabelColumnWidth,
            movingViewport: context.movingViewport !== false,
            expanded: context.expanded,
            maxWritePreviewBytes: mutationSettings.limits.maxWritePreviewBytes,
        };
        if (
            context.lastComponent instanceof PartialWriteCallPreviewComponent &&
            context.lastComponent.belongsTo(context.toolCallId ?? "")
        ) {
            context.lastComponent.update(update);
            return context.lastComponent;
        }
        return new PartialWriteCallPreviewComponent(update);
    }

    const added = countContentLines(content);
    const boundedContent = boundedWriteContentPreview(
        content,
        mutationSettings.limits.maxWritePreviewBytes,
    );
    const showAllRows = showsFullMutation(mutationSettings, context.expanded);
    const body =
        boundedContent.length === 0
            ? renderGlowupOutput(theme, "", {
                  expanded: false,
                  mode: "head",
                  maxPreviewLines: 1,
                  noOutputLabel: "(empty file)",
              })
            : renderGlowupDiff(
                  theme,
                  [writeDiffSection(path, boundedContent, added)],
                  showAllRows,
                  writeDiffRenderOptions(mutationSettings.previewLines, showAllRows),
              );
    return renderMutationCall(
        theme,
        {
            label: statusText,
            path,
            added,
            removed: 0,
        },
        writeMutationCallOptions(context.mutationLabelColumnWidth, body, "success"),
    );
}

/** Returns an empty successful write result when the call renderer already showed content. */
export function renderSuccessfulWriteResultFallback(args: WriteCallArgs): Component | undefined {
    return writeContentFromArgs(args) === undefined ? undefined : emptyComponent();
}
