import type { Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    formatPathTarget,
    renderCodexCall,
    renderCodexOutput,
    renderMutationCall,
    type CodexRenderTheme,
} from "./core.ts";

const MAX_WRITE_PREVIEW_BYTES = 64 * 1024;
const WRITE_PREVIEW_TRUNCATION_SUFFIX = "\n… write preview truncated";

type WriteCallContext = {
    readonly isError: boolean;
    readonly isPartial: boolean;
    readonly expanded: boolean;
    readonly lastComponent?: Component | undefined;
    readonly dynamicStatusLabels?: boolean;
    readonly mutationLabelColumnWidth?: number;
};

const PARTIAL_WRITE_PREVIEW_LINES = 20;
const PARTIAL_WRITE_HEAD_LINES = PARTIAL_WRITE_PREVIEW_LINES - 1;
const PARTIAL_WRITE_SUFFIX_CHARS = 32;
const MAX_PARTIAL_WRITE_LINE_CHARS = 2_000;

type PartialWritePreviewUpdate = {
    readonly theme: CodexRenderTheme;
    readonly path: string;
    readonly content: string;
    readonly dynamicStatusLabels: boolean;
    readonly mutationLabelColumnWidth: number | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(args: unknown, key: string): string | undefined {
    if (!isRecord(args)) {
        return undefined;
    }
    const value = args[key];
    return typeof value === "string" ? value : undefined;
}

function countContentLines(content: string): number {
    if (content.length === 0) {
        return 0;
    }

    let lineCount = content.endsWith("\n") ? 0 : 1;
    for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 10) {
            lineCount += 1;
        }
    }
    return lineCount;
}

function hasNonWhitespaceText(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        if (text.charAt(index).trim().length > 0) {
            return true;
        }
    }
    return false;
}

function boundedPartialWriteLine(line: string): string {
    if (line.length <= MAX_PARTIAL_WRITE_LINE_CHARS) {
        return line;
    }
    return `${line.slice(0, Math.max(0, MAX_PARTIAL_WRITE_LINE_CHARS - 1))}…`;
}

class PartialWriteContentPreview {
    private scannedLength = 0;
    private suffix = "";
    private newlineCount = 0;
    private endsWithLineBreak = false;
    private sawContent = false;
    private displayLineCount = 0;
    private readonly headLines: string[] = [];
    private pendingBlankLineCount = 0;
    private readonly pendingBlankLineSamples: string[] = [];
    private currentLine = "";

    update(content: string): void {
        if (!this.canAppend(content)) {
            this.reset();
        }

        this.consume(content, this.scannedLength);
        this.scannedLength = content.length;
        this.suffix = content.slice(Math.max(0, content.length - PARTIAL_WRITE_SUFFIX_CHARS));
    }

    lineCount(): number {
        if (this.scannedLength === 0) {
            return 0;
        }
        return this.newlineCount + (this.endsWithLineBreak ? 0 : 1);
    }

    previewText(): string {
        const snapshot = this.previewSnapshot();
        if (snapshot.lineCount === 0) {
            return "";
        }
        if (snapshot.lineCount <= snapshot.lines.length) {
            return snapshot.lines.join("\n");
        }
        return [
            ...snapshot.lines,
            `… +${snapshot.lineCount - snapshot.lines.length} lines (to expand)`,
        ].join("\n");
    }

    private canAppend(content: string): boolean {
        if (content.length < this.scannedLength) {
            return false;
        }
        if (this.suffix.length === 0) {
            return true;
        }
        const suffixStart = this.scannedLength - this.suffix.length;
        return suffixStart >= 0 && content.slice(suffixStart, this.scannedLength) === this.suffix;
    }

    private reset(): void {
        this.scannedLength = 0;
        this.suffix = "";
        this.newlineCount = 0;
        this.endsWithLineBreak = false;
        this.sawContent = false;
        this.displayLineCount = 0;
        this.headLines.length = 0;
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
        if (this.headLines.length < PARTIAL_WRITE_HEAD_LINES) {
            this.headLines.push(line);
        }
    }

    private previewSnapshot(): { readonly lines: string[]; readonly lineCount: number } {
        const lines = [...this.headLines];
        let lineCount = this.displayLineCount;
        const currentLine = boundedPartialWriteLine(this.currentLine);
        if (!hasNonWhitespaceText(currentLine)) {
            return { lines, lineCount };
        }

        if (this.sawContent) {
            for (let index = 0; index < this.pendingBlankLineCount; index += 1) {
                lineCount += 1;
                if (lines.length < PARTIAL_WRITE_HEAD_LINES) {
                    lines.push(this.pendingBlankLineSamples[index] ?? "");
                }
            }
        }
        lineCount += 1;
        if (lines.length < PARTIAL_WRITE_HEAD_LINES) {
            lines.push(currentLine);
        }
        return { lines, lineCount };
    }
}

class PartialWriteCallPreviewComponent implements Component {
    private readonly preview = new PartialWriteContentPreview();
    private theme: CodexRenderTheme;
    private path = "";
    private dynamicStatusLabels = false;
    private mutationLabelColumnWidth: number | undefined;
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(update: PartialWritePreviewUpdate) {
        this.theme = update.theme;
        this.update(update);
    }

    update(update: PartialWritePreviewUpdate): void {
        this.theme = update.theme;
        this.path = update.path;
        this.dynamicStatusLabels = update.dynamicStatusLabels;
        this.mutationLabelColumnWidth = update.mutationLabelColumnWidth;
        this.preview.update(update.content);
        this.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const component = renderMutationCall(
            this.theme,
            {
                label: this.dynamicStatusLabels ? "Writing" : "Write",
                path: this.path,
                added: this.preview.lineCount(),
                removed: 0,
            },
            {
                ...(this.mutationLabelColumnWidth === undefined
                    ? {}
                    : { labelColumnWidth: this.mutationLabelColumnWidth }),
                body: renderCodexOutput(this.theme, this.preview.previewText(), {
                    expanded: false,
                    mode: "head",
                    maxPreviewLines: PARTIAL_WRITE_PREVIEW_LINES,
                    prefixFirst: "  │ ",
                    prefixRest: "  │ ",
                    noOutputLabel: "(empty file)",
                }),
            },
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

function truncateUtf8(text: string, maxBytes: number): string {
    let byteLength = 0;
    let endIndex = 0;
    for (const char of text) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (byteLength + charBytes > maxBytes) {
            break;
        }
        byteLength += charBytes;
        endIndex += char.length;
    }
    return text.slice(0, endIndex);
}

function boundedWriteContentPreview(content: string): string {
    if (Buffer.byteLength(content, "utf8") <= MAX_WRITE_PREVIEW_BYTES) {
        return content;
    }

    const maxContentBytes = Math.max(
        0,
        MAX_WRITE_PREVIEW_BYTES - Buffer.byteLength(WRITE_PREVIEW_TRUNCATION_SUFFIX, "utf8"),
    );
    return `${truncateUtf8(content, maxContentBytes)}${WRITE_PREVIEW_TRUNCATION_SUFFIX}`;
}

/** Returns the built-in write tool content argument when it is available to render. */
export function writeContentFromArgs(args: unknown): string | undefined {
    return stringField(args, "content");
}

/** Renders a built-in write call with a bounded preview of the content being written. */
export function renderWriteCallPreview(
    args: unknown,
    theme: CodexRenderTheme,
    context: WriteCallContext,
): Component {
    const path = stringField(args, "path") ?? "";
    const content = writeContentFromArgs(args);
    const dynamicStatusLabels = context.dynamicStatusLabels === true;
    if (content === undefined || context.isError) {
        return renderCodexCall(theme, {
            state: context.isError ? "error" : context.isPartial ? "muted" : "success",
            statusText: dynamicStatusLabels && !context.isPartial ? "Wrote" : "Write",
            body: formatPathTarget(theme, path),
        });
    }

    if (context.isPartial) {
        const update = {
            theme,
            path,
            content,
            dynamicStatusLabels,
            mutationLabelColumnWidth: context.mutationLabelColumnWidth,
        };
        if (context.lastComponent instanceof PartialWriteCallPreviewComponent) {
            context.lastComponent.update(update);
            return context.lastComponent;
        }
        return new PartialWriteCallPreviewComponent(update);
    }

    return renderMutationCall(
        theme,
        {
            label: dynamicStatusLabels ? (context.isPartial ? "Writing" : "Wrote") : "Write",
            path,
            added: countContentLines(content),
            removed: 0,
        },
        {
            ...(context.mutationLabelColumnWidth === undefined
                ? {}
                : { labelColumnWidth: context.mutationLabelColumnWidth }),
            body: renderCodexOutput(theme, boundedWriteContentPreview(content), {
                expanded: context.expanded,
                mode: "head",
                maxPreviewLines: 20,
                prefixFirst: "  │ ",
                prefixRest: "  │ ",
                noOutputLabel: "(empty file)",
                syntax: { path },
            }),
        },
    );
}

/** Returns an empty successful write result when the call renderer already showed content. */
export function renderSuccessfulWriteResultFallback(args: unknown): Component | undefined {
    return writeContentFromArgs(args) === undefined ? undefined : emptyComponent();
}
