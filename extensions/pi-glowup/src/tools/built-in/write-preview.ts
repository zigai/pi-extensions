import type { Component } from "@earendil-works/pi-tui";
import type { CodePreview } from "../../rendering/streaming/presentation.ts";
import {
    renderSyntaxComponent,
    scheduleCodeOutputSyntaxLoad,
} from "../../rendering/syntax/code-component.ts";
import { observeSyntaxHighlightSource } from "../../rendering/syntax/highlighter.ts";
import {
    createSyntaxComponent,
    inheritSyntaxComponent,
} from "../../rendering/syntax/component-owner.ts";
import {
    countContentLines,
    hasNonWhitespaceText,
    truncateGraphemeText,
    truncateUtf8ByGrapheme,
} from "../../text-boundaries.ts";
import {
    makeComponent,
    emptyComponent,
    omittedLinesLabel,
    toolExpandHint,
} from "../../rendering/component.ts";
import { formatPathTarget } from "../../rendering/path.ts";
import {
    renderGlowupCall,
    renderMutationCall,
    type MutationCallRenderOptions,
} from "../../rendering/tool-header.ts";
import {
    renderGlowupDiff,
    type GlowupDiffRenderOptions,
} from "../../rendering/diff/text-renderer.ts";
import { renderGlowupOutput } from "../../rendering/output.ts";
import { MUTATION_DIFF_PREVIEW_ROWS } from "../../rendering/diff/preview-selection.ts";
import { type GlowupRenderTheme } from "../../rendering/theme.ts";
import { type DiffSection } from "../../rendering/diff/text-diff.ts";
import {
    isActiveToolCall,
    toolStatusLabel,
    type ToolLabelMode,
} from "../../rendering/status-labels.ts";
import {
    PREVIEW_MUTATION_SETTINGS,
    showsFullMutation,
    type MutationSettings,
} from "../../rendering/preview-settings.ts";

const WRITE_PREVIEW_TRUNCATION_SUFFIX = "\n… write preview truncated";

export type WriteCallArgs = {
    readonly path?: string;
    readonly content?: string;
};

export type WriteCallContext = {
    readonly toolCallId?: string;
    readonly streamCode?: CodePreview;
    readonly sourceLineCount?: number;
    readonly syntaxSource?: string;
    readonly waitingForCode?: boolean;
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
    state: "running" | "success" | "error",
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
    readonly sourceLineCount: number | undefined;
    readonly waitingForCode: boolean;
    readonly labelMode: ToolLabelMode;
    readonly mutationLabelColumnWidth: number | undefined;
    readonly movingViewport: boolean;
    readonly expanded: boolean;
    readonly maxWritePreviewBytes: number | null;
    readonly invalidate: (() => void) | undefined;
    readonly appendStart: number | undefined;
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

// Only the first few blank samples are retained by the established preview policy.
// Visit bounded head/tail samples and account for the invisible middle in O(1).
function appendPendingBlankLines(
    count: number,
    samples: readonly string[],
    append: (line: string) => void,
    skip: (count: number) => void,
): void {
    const head = Math.min(count, PARTIAL_WRITE_HEAD_LINES);
    for (let index = 0; index < head; index += 1) append(samples[index] ?? "");
    const tail = Math.min(count - head, PARTIAL_WRITE_MOVING_TAIL_LINES);
    skip(count - head - tail);

    for (let index = 0; index < tail; index += 1) append("");
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
    private currentLineStart = 0;
    private incremental = false;

    update(content: string, appendStart: number | undefined): void {
        this.incremental = appendStart !== undefined;
        // Only the streaming owner can prove append identity from its already-owned
        // previous args. Other callers safely rebuild; never retain another full source.
        if (appendStart === undefined || appendStart !== this.scannedLength) this.reset();
        this.consume(content, this.scannedLength);
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
            `${omittedLinesLabel(snapshot.lineCount - lines.length)} (${toolExpandHint()})`,
        ].join("\n");
    }

    private movingPreviewText(snapshot: PreviewSnapshot): string {
        if (snapshot.lineCount <= PARTIAL_WRITE_PREVIEW_LINES) {
            return snapshot.headLines.slice(0, snapshot.lineCount).join("\n");
        }

        const tailLines = snapshot.tailLines.slice(-PARTIAL_WRITE_MOVING_TAIL_LINES);
        return [
            `${omittedLinesLabel(snapshot.lineCount - tailLines.length)} (${toolExpandHint()})`,
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
        this.currentLineStart = 0;
    }

    private consume(content: string, start: number): void {
        let index = start;

        if (start > 0 && content.charCodeAt(start - 1) === 13 && content.charCodeAt(start) === 10) {
            this.currentLineStart = start + 1;
            index = start + 1;
        }

        for (; index < content.length; index += 1) {
            const charCode = content.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                this.endsWithLineBreak = false;
                continue;
            }

            this.consumeLine(this.boundedSourceLine(content, index));
            this.currentLine = "";
            this.newlineCount += 1;
            this.endsWithLineBreak = true;

            if (charCode === 13 && content.charCodeAt(index + 1) === 10) {
                index += 1;
            }

            this.currentLineStart = index + 1;
        }

        if (this.currentLineStart < content.length) {
            this.currentLine = this.retainLine(this.boundedSourceLine(content, content.length));
        }
    }

    private boundedSourceLine(content: string, end: number): string {
        // Re-read the bounded raw prefix, not the previously truncated display.
        // This repairs split surrogates / extending graphemes without retaining an
        // unbounded unfinished line. Two extra code units establish overflow even
        // when completeUnicodePrefix withholds a trailing high surrogate.
        return boundedPartialWriteLine(
            content.slice(
                this.currentLineStart,
                Math.min(end, this.currentLineStart + MAX_PARTIAL_WRITE_LINE_CHARS + 2),
            ),
        );
    }

    private retainLine(line: string): string {
        if (!this.incremental) return line;
        // Samples survive later updates. A small sliced string can otherwise
        // pin an entire old input buffer. UTF-16 preserves even unmatched
        // surrogate code units; UTF-8 round-tripping would change the input.
        return Buffer.from(line, "utf16le").toString("utf16le");
    }

    private consumeLine(line: string): void {
        const boundedLine = this.retainLine(boundedPartialWriteLine(line));
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
        appendPendingBlankLines(
            this.pendingBlankLineCount,
            this.pendingBlankLineSamples,
            (line) => this.appendDisplayLine(line),
            (count) => {
                this.displayLineCount += count;
            },
        );

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
            appendPendingBlankLines(
                this.pendingBlankLineCount,
                this.pendingBlankLineSamples,
                appendLine,
                (count) => {
                    lineCount += count;
                },
            );
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
    private sourceLineCount: number | undefined;
    private waitingForCode = false;
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;
    private invalidateHost: (() => void) | undefined;

    private readonly invalidateSyntax = (): void => {
        this.invalidate();
        this.invalidateHost?.();
    };

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
        this.sourceLineCount = update.sourceLineCount;
        this.waitingForCode = update.waitingForCode;
        this.invalidateHost = update.invalidate;
        this.expandedContent = update.expanded
            ? boundedWriteContentPreview(update.content, update.maxWritePreviewBytes)
            : "";
        this.preview.update(update.content, update.appendStart);
        this.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const added = this.sourceLineCount ?? this.preview.lineCount();
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
                      ...(this.waitingForCode && { noOutputLabel: null }),
                  })
                : renderGlowupDiff(
                      this.theme,
                      [writeDiffSection(this.path, previewText, added)],
                      true,
                      {
                          ...writeDiffRenderOptions(PARTIAL_WRITE_PREVIEW_LINES, this.expanded),
                          lastComponent: this,
                          invalidate: this.invalidateSyntax,
                      },
                  );

        inheritSyntaxComponent(this, body);

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

type StreamingWriteUpdate = {
    readonly args: WriteCallArgs;
    readonly theme: GlowupRenderTheme;
    readonly context: Omit<WriteCallContext, "lastComponent" | "streamCode">;
    readonly streamCode: CodePreview;
    readonly invalidate: () => void;
};

class StreamingWritePreviewComponent implements Component {
    private preview: Component | undefined;
    private readonly rendered = makeComponent((width) => this.renderPreview(width));
    private readonly toolCallId: string | undefined;
    private sourceNewlineCount = 0;
    private renderedSourceLength = 0;

    constructor(private input: StreamingWriteUpdate) {
        // The host may mutate an args object in place between updates. Snapshot
        // its primitive fields, sharing the current string rather than copying it.
        this.input = { ...input, args: { ...input.args } };
        this.toolCallId = input.context.toolCallId;
        this.countNewlines(this.input.args.content ?? "", 0);
    }

    private countNewlines(content: string, start: number): void {
        for (let index = start; index < content.length; index += 1) {
            if (content.charCodeAt(index) === 10) this.sourceNewlineCount += 1;
        }
    }

    belongsTo(toolCallId: string | undefined): boolean {
        return this.toolCallId === toolCallId;
    }

    update(input: StreamingWriteUpdate): void {
        const previous = this.input.args.content ?? "";
        const content = input.args.content ?? "";

        // Exact rewrite detection still requires a full startsWith comparison.
        // Borrow the owner's existing args reference; do not retain source history.
        const appending = content.startsWith(previous);
        let start = previous.length;
        if (!appending) {
            start = 0;
            this.sourceNewlineCount = 0;
            this.renderedSourceLength = 0;
        }

        this.countNewlines(content, start);
        this.input = { ...input, args: { ...input.args } };
        this.invalidate();
    }

    render(width: number): string[] {
        return renderSyntaxComponent(this.rendered, this.input.invalidate, width);
    }

    invalidate(): void {
        this.rendered.invalidate();
    }

    private renderPreview(width: number): string[] {
        const { args, theme, context, streamCode, invalidate } = this.input;
        const path = args.path ?? "";
        const content = args.content ?? "";
        const display = streamCode({
            key: `tool:${context.toolCallId ?? ""}:write:${path}`,
            source: content,
            path,
            complete: context.argsComplete === true || !context.isPartial || context.isError,
            targetWidth: Math.max(1, width - 10),
            invalidate,
            ...(context.toolCallId !== undefined && { toolCallId: context.toolCallId }),
        });

        // A transformed streamCode result has no append-identity contract. Only
        // pass the proof through when the display is exactly the owned raw source.
        let appendStart: number | undefined;
        if (display === content) appendStart = this.renderedSourceLength;

        this.preview = renderWriteCallPreviewInternal(
            { ...args, content: display },
            theme,
            {
                ...context,
                invalidate,
                sourceLineCount:
                    this.sourceNewlineCount + Number(content.length > 0 && !content.endsWith("\n")),
                syntaxSource: content,
                waitingForCode: display.length === 0 && content.length > 0,
                lastComponent: this.preview,
            },
            appendStart,
        );
        this.renderedSourceLength = 0;
        if (display === content) this.renderedSourceLength = content.length;

        const lines = this.preview.render(width);
        const current = observeSyntaxHighlightSource(content, invalidate);
        scheduleCodeOutputSyntaxLoad({ path }, invalidate, content, current, {
            invalidateOnComplete: false,
        });

        return lines;
    }
}

/** Renders a built-in write call with a bounded preview of the content being written. */
export function renderWriteCallPreview(
    args: WriteCallArgs,
    theme: GlowupRenderTheme,
    context: WriteCallContext,
): Component {
    return renderWriteCallPreviewInternal(args, theme, context);
}

function renderWriteCallPreviewInternal(
    args: WriteCallArgs,
    theme: GlowupRenderTheme,
    context: WriteCallContext,
    appendStart?: number,
): Component {
    const path = args.path ?? "";
    const content = args.content;
    const labelMode = context.labelMode ?? "static";
    const mutationSettings = context.mutationSettings ?? PREVIEW_MUTATION_SETTINGS;
    let statusText = toolStatusLabel(labelMode, context, {
        static: "Write",
        active: "Writing",
        completed: "Wrote",
    });
    if (context.isError) statusText = "Write";

    if (content === undefined && isActiveToolCall(context)) {
        return emptyComponent();
    }

    if (
        content === undefined ||
        (context.isError &&
            context.streamCode === undefined &&
            context.sourceLineCount === undefined)
    ) {
        return renderGlowupCall(theme, {
            state: context.isError ? "error" : "success",
            statusText: context.isError ? "Write" : statusText,
            body: formatPathTarget(theme, path),
        });
    }

    const streamCode = context.streamCode;
    if (streamCode !== undefined) {
        // Streaming state survives redraws. Never retain context.lastComponent:
        // that links every old preview and its syntax rows together.
        const {
            streamCode: _streamCode,
            lastComponent: _lastComponent,
            ...displayContext
        } = context;

        return createSyntaxComponent(
            context.lastComponent,
            context.invalidate,
            (invalidate, previous) => {
                const update = { args, theme, context: displayContext, streamCode, invalidate };
                if (
                    previous instanceof StreamingWritePreviewComponent &&
                    previous.belongsTo(displayContext.toolCallId)
                ) {
                    previous.update(update);
                    return previous;
                }

                return new StreamingWritePreviewComponent(update);
            },
            content,
        );
    }

    if (context.isPartial) {
        const update = {
            toolCallId: context.toolCallId ?? "",
            appendStart,
            theme,
            path,
            content,
            sourceLineCount: context.sourceLineCount,
            waitingForCode: context.waitingForCode === true,
            labelMode,
            mutationLabelColumnWidth: context.mutationLabelColumnWidth,
            movingViewport: context.movingViewport !== false,
            expanded: context.expanded,
            maxWritePreviewBytes: mutationSettings.limits.maxWritePreviewBytes,
            invalidate: context.invalidate,
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

    let current: (() => boolean) | undefined;
    if (context.invalidate !== undefined)
        current = observeSyntaxHighlightSource(context.syntaxSource ?? content, context.invalidate);

    scheduleCodeOutputSyntaxLoad({ path }, context.invalidate, content, current);

    const added = context.sourceLineCount ?? countContentLines(content);
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
                  ...(context.waitingForCode === true && { noOutputLabel: null }),
              })
            : renderGlowupDiff(
                  theme,
                  [writeDiffSection(path, boundedContent, added)],
                  showAllRows,
                  {
                      ...writeDiffRenderOptions(mutationSettings.previewLines, showAllRows),
                      lastComponent: context.lastComponent,
                      invalidate: context.invalidate,
                  },
              );

    let state: "success" | "error" = "success";
    if (context.isError) state = "error";

    const component = renderMutationCall(
        theme,
        {
            label: statusText,
            path,
            added,
            removed: 0,
        },
        writeMutationCallOptions(context.mutationLabelColumnWidth, body, state),
    );
    inheritSyntaxComponent(component, body);

    return component;
}

/** Returns an empty successful write result when the call renderer already showed content. */
export function renderSuccessfulWriteResultFallback(args: WriteCallArgs): Component | undefined {
    return args.content === undefined ? undefined : emptyComponent();
}
