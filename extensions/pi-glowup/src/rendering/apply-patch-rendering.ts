import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    formatPathTarget,
    makeComponent,
    renderCodexBody,
    renderCodexCall,
    renderCodexDiff,
    renderCodexOutput,
    renderMutationCall,
    MUTATION_DIFF_PREVIEW_ROWS,
    type CodexRenderTheme,
    type DiffSection,
} from "./core.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRenderContext,
    ThirdPartyToolResult,
} from "../third-party-tools/types.ts";
import {
    isActiveToolCall,
    toolStatusLabel,
    type ToolLabelMode,
    type ToolLifecycleContext,
} from "./status-labels.ts";
import { captureDeletedTextPreview, type DeletedTextPreview } from "./delete-preview.ts";

type ApplyPatchKind = "add" | "delete" | "update";

type ApplyPatchSection = DiffSection & {
    readonly kind: ApplyPatchKind;
    readonly countsKnown: boolean;
};

type ApplyPatchSummary = {
    readonly sections: readonly ApplyPatchSection[];
};

const MAX_COMPLETED_PATCH_PARSE_CHARS = 64 * 1024;
const MAX_PARTIAL_PATCH_REPLAY_CHARS = 64 * 1024;
const MAX_PARTIAL_PATCH_PREVIEW_LINES = MUTATION_DIFF_PREVIEW_ROWS;
const MAX_PARTIAL_PATCH_LINE_CHARS = 2_000;
const PARTIAL_PATCH_SUFFIX_CHARS = 32;
const MAX_DELETE_PREIMAGE_CALLS = 100;

type MutableApplyPatchSection = {
    kind: ApplyPatchKind;
    path: string;
    movePath: string | undefined;
    lines: string[];
    added: number;
    removed: number;
    oldLine: number;
    newLine: number;
    lineNumbersKnown: boolean;
};

const deletePreimages = new Map<string, Map<string, DeletedTextPreview>>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const field = value[key];
    return typeof field === "string" ? field : undefined;
}

function patchTextFromArgs(args: unknown): string | undefined {
    return (
        stringField(args, "patch") ??
        stringField(args, "input") ??
        stringField(args, "command") ??
        (typeof args === "string" ? args : undefined)
    );
}

function captureDeletePreimages(toolCallId: string, cwd: string, patch: string): void {
    let previews = deletePreimages.get(toolCallId);
    if (previews === undefined) {
        previews = new Map();
        deletePreimages.set(toolCallId, previews);
        while (deletePreimages.size > MAX_DELETE_PREIMAGE_CALLS) {
            const oldest = deletePreimages.keys().next().value;
            if (typeof oldest !== "string") {
                break;
            }
            deletePreimages.delete(oldest);
        }
    }
    for (const line of patch.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")) {
        if (!line.startsWith("*** Delete File: ")) {
            continue;
        }
        const filePath = line.slice("*** Delete File: ".length);
        if (filePath.length === 0 || previews.has(filePath)) {
            continue;
        }
        const preview = captureDeletedTextPreview(cwd, filePath);
        if (preview !== undefined) {
            previews.set(filePath, preview);
        }
    }
}

function hydrateDeletePreimages(summary: ApplyPatchSummary, toolCallId: string): ApplyPatchSummary {
    const previews = deletePreimages.get(toolCallId);
    if (previews === undefined) {
        return summary;
    }
    return {
        sections: summary.sections.map((section) => {
            if (section.kind !== "delete" || section.path === undefined) {
                return section;
            }
            const preview = previews.get(section.path);
            return preview === undefined
                ? section
                : {
                      ...section,
                      lines: preview.section.lines,
                      removed: preview.removed,
                      countsKnown: true,
                  };
        }),
    };
}

function displayPath(section: MutableApplyPatchSection): string {
    return section.movePath === undefined ? section.path : `${section.path} → ${section.movePath}`;
}

function lineCount(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    let lines = text.endsWith("\n") ? 0 : 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) === 10) {
            lines += 1;
        }
    }
    return lines;
}

function hasCompletePatchEnvelope(patchText: string): boolean {
    return patchText.trimEnd().endsWith("*** End Patch") && patchText.includes("*** Begin Patch");
}

function canParseCompletedPatchCall(patchText: string): boolean {
    return (
        patchText.length <= MAX_COMPLETED_PATCH_PARSE_CHARS && hasCompletePatchEnvelope(patchText)
    );
}

function makeSection(kind: ApplyPatchKind, path: string): MutableApplyPatchSection {
    return {
        kind,
        path,
        movePath: undefined,
        lines: [],
        added: 0,
        removed: 0,
        oldLine: 1,
        newLine: 1,
        lineNumbersKnown: kind === "add",
    };
}

function numberedDiffLine(
    sign: "+" | "-" | " ",
    lineNumber: number,
    content: string,
    known: boolean,
): string {
    return known ? `${sign}${lineNumber} ${content}` : `${sign} ${content}`;
}

function applyHunkCoordinates(section: MutableApplyPatchSection, line: string): void {
    const match = /^@@ -(?<oldLine>\d+)(?:,\d+)? \+(?<newLine>\d+)(?:,\d+)?(?: @@|$)/u.exec(line);
    const oldLine = Number(match?.groups?.oldLine);
    const newLine = Number(match?.groups?.newLine);
    if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine)) {
        return;
    }
    section.oldLine = oldLine;
    section.newLine = newLine;
    section.lineNumbersKnown = true;
}

function finalizedSection(section: MutableApplyPatchSection): ApplyPatchSection {
    return {
        kind: section.kind,
        path: displayPath(section),
        lines: [...section.lines],
        added: section.added,
        removed: section.removed,
        countsKnown: section.kind !== "delete",
    };
}

function parseApplyPatchSummary(patchText: string): ApplyPatchSummary | undefined {
    const normalized = patchText.trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("*** Begin Patch") || !normalized.includes("*** End Patch")) {
        return undefined;
    }

    const sections: ApplyPatchSection[] = [];
    let current: MutableApplyPatchSection | undefined;

    function flush(): void {
        if (current === undefined) {
            return;
        }
        sections.push(finalizedSection(current));
        current = undefined;
    }

    for (const line of normalized.split("\n")) {
        const addPath = line.startsWith("*** Add File: ")
            ? line.slice("*** Add File: ".length)
            : undefined;
        if (addPath !== undefined) {
            flush();
            current = makeSection("add", addPath);
            continue;
        }

        const deletePath = line.startsWith("*** Delete File: ")
            ? line.slice("*** Delete File: ".length)
            : undefined;
        if (deletePath !== undefined) {
            flush();
            current = makeSection("delete", deletePath);
            continue;
        }

        const updatePath = line.startsWith("*** Update File: ")
            ? line.slice("*** Update File: ".length)
            : undefined;
        if (updatePath !== undefined) {
            flush();
            current = makeSection("update", updatePath);
            continue;
        }

        if (current === undefined) {
            continue;
        }

        if (current.kind === "update" && line.startsWith("*** Move to: ")) {
            current.movePath = line.slice("*** Move to: ".length);
            continue;
        }

        if (line === "*** End Patch") {
            flush();
            break;
        }

        if (line === "*** End of File") {
            continue;
        }

        if (current.kind === "add") {
            if (line.startsWith("+")) {
                current.added += 1;
                current.lines.push(numberedDiffLine("+", current.added, line.slice(1), true));
            }
            continue;
        }

        if (current.kind === "delete") {
            continue;
        }

        if (line === "@@" || line.startsWith("@@ ")) {
            applyHunkCoordinates(current, line);
            continue;
        }

        if (line.startsWith("+")) {
            current.added += 1;
            current.lines.push(
                numberedDiffLine("+", current.newLine, line.slice(1), current.lineNumbersKnown),
            );
            current.newLine += 1;
            continue;
        }

        if (line.startsWith("-")) {
            current.removed += 1;
            current.lines.push(
                numberedDiffLine("-", current.oldLine, line.slice(1), current.lineNumbersKnown),
            );
            current.oldLine += 1;
            continue;
        }

        if (line.startsWith(" ")) {
            current.lines.push(
                numberedDiffLine(" ", current.newLine, line.slice(1), current.lineNumbersKnown),
            );
            current.oldLine += 1;
            current.newLine += 1;
            continue;
        }

        if (line.length === 0) {
            current.lines.push(
                numberedDiffLine(" ", current.newLine, "", current.lineNumbersKnown),
            );
            current.oldLine += 1;
            current.newLine += 1;
        }
    }

    flush();

    if (sections.length === 0) {
        return undefined;
    }

    return { sections };
}

type PartialApplyPatchSection = MutableApplyPatchSection & {
    diffLineCount: number;
};

function makePartialSection(kind: ApplyPatchKind, path: string): PartialApplyPatchSection {
    return {
        ...makeSection(kind, path),
        diffLineCount: 0,
    };
}

function copyPartialSection(section: PartialApplyPatchSection): PartialApplyPatchSection {
    return {
        ...section,
        lines: [...section.lines],
    };
}

function partialPatchSectionHeader(
    line: string,
): { readonly kind: ApplyPatchKind; readonly path: string } | undefined {
    for (const candidate of [
        { prefix: "*** Add File: ", kind: "add" },
        { prefix: "*** Delete File: ", kind: "delete" },
        { prefix: "*** Update File: ", kind: "update" },
    ] as const) {
        if (line.startsWith(candidate.prefix)) {
            return { kind: candidate.kind, path: line.slice(candidate.prefix.length) };
        }
    }
    return undefined;
}

function appendPartialPatchDiffLine(section: PartialApplyPatchSection, line: string): void {
    section.diffLineCount += 1;
    section.lines.push(line);
    if (section.lines.length > MAX_PARTIAL_PATCH_PREVIEW_LINES) {
        section.lines.shift();
    }
}

function applyPartialPatchBodyLine(section: PartialApplyPatchSection, line: string): void {
    if (line === "*** End Patch" || line === "*** End of File") {
        return;
    }

    if (section.kind === "add") {
        if (line.startsWith("+")) {
            section.added += 1;
            appendPartialPatchDiffLine(
                section,
                numberedDiffLine("+", section.added, line.slice(1), true),
            );
        }
        return;
    }

    if (section.kind === "delete") {
        return;
    }
    if (line === "@@" || line.startsWith("@@ ")) {
        applyHunkCoordinates(section, line);
        return;
    }

    if (line.startsWith("+")) {
        section.added += 1;
        appendPartialPatchDiffLine(
            section,
            numberedDiffLine("+", section.newLine, line.slice(1), section.lineNumbersKnown),
        );
        section.newLine += 1;
        return;
    }

    if (line.startsWith("-")) {
        section.removed += 1;
        appendPartialPatchDiffLine(
            section,
            numberedDiffLine("-", section.oldLine, line.slice(1), section.lineNumbersKnown),
        );
        section.oldLine += 1;
        return;
    }

    if (line.startsWith(" ") || line.length === 0) {
        const content = line.startsWith(" ") ? line.slice(1) : "";
        appendPartialPatchDiffLine(
            section,
            numberedDiffLine(" ", section.newLine, content, section.lineNumbersKnown),
        );
        section.oldLine += 1;
        section.newLine += 1;
    }
}

function finalizedPartialSection(section: PartialApplyPatchSection): ApplyPatchSection {
    return {
        kind: section.kind,
        path: displayPath(section),
        lines: section.lines.slice(-MAX_PARTIAL_PATCH_PREVIEW_LINES),
        added: section.added,
        removed: section.removed,
        countsKnown: section.kind !== "delete",
    };
}

function latestPartialPatchReplayStart(patch: string): number {
    const minimumStart = Math.max(0, patch.length - MAX_PARTIAL_PATCH_REPLAY_CHARS);
    const replayWindow = patch.slice(minimumStart);
    const relativeStart = Math.max(
        replayWindow.lastIndexOf("*** Add File: "),
        replayWindow.lastIndexOf("*** Delete File: "),
        replayWindow.lastIndexOf("*** Update File: "),
    );
    return relativeStart < 0 ? minimumStart : minimumStart + relativeStart;
}

class PartialApplyPatchPreview {
    private scannedLength = 0;
    private suffix = "";
    private currentLine = "";
    private currentLineTruncated = false;
    private skipLineFeed = false;
    private section: PartialApplyPatchSection | undefined;

    update(patch: string): void {
        const appendLength = patch.length - this.scannedLength;
        let consumeStart = this.scannedLength;
        if (!this.canAppend(patch) || appendLength > MAX_PARTIAL_PATCH_REPLAY_CHARS) {
            this.reset();
            consumeStart = latestPartialPatchReplayStart(patch);
        }

        this.consume(patch, consumeStart);
        this.scannedLength = patch.length;
        this.suffix = patch.slice(Math.max(0, patch.length - PARTIAL_PATCH_SUFFIX_CHARS));
    }

    snapshot(): ApplyPatchSection | undefined {
        const currentLine = this.displayCurrentLine();
        const header = partialPatchSectionHeader(currentLine);
        if (header !== undefined) {
            return finalizedPartialSection(makePartialSection(header.kind, header.path));
        }

        if (this.section === undefined) {
            return undefined;
        }

        const section = copyPartialSection(this.section);
        if (section.kind === "update" && currentLine.startsWith("*** Move to: ")) {
            section.movePath = currentLine.slice("*** Move to: ".length);
        } else if (currentLine.length > 0) {
            applyPartialPatchBodyLine(section, currentLine);
        }
        return finalizedPartialSection(section);
    }

    private canAppend(patch: string): boolean {
        if (patch.length < this.scannedLength) {
            return false;
        }
        if (this.suffix.length === 0) {
            return true;
        }
        const suffixStart = this.scannedLength - this.suffix.length;
        return suffixStart >= 0 && patch.slice(suffixStart, this.scannedLength) === this.suffix;
    }

    private reset(): void {
        this.scannedLength = 0;
        this.suffix = "";
        this.currentLine = "";
        this.currentLineTruncated = false;
        this.skipLineFeed = false;
        this.section = undefined;
    }

    private consume(patch: string, start: number): void {
        for (let index = start; index < patch.length; index += 1) {
            const charCode = patch.charCodeAt(index);
            if (this.skipLineFeed) {
                this.skipLineFeed = false;
                if (charCode === 10) {
                    continue;
                }
            }

            if (charCode === 10 || charCode === 13) {
                this.commitLine(this.displayCurrentLine());
                this.currentLine = "";
                this.currentLineTruncated = false;
                this.skipLineFeed = charCode === 13;
                continue;
            }

            if (this.currentLine.length < MAX_PARTIAL_PATCH_LINE_CHARS) {
                this.currentLine += patch.charAt(index);
            } else {
                this.currentLineTruncated = true;
            }
        }
    }

    private displayCurrentLine(): string {
        if (!this.currentLineTruncated) {
            return this.currentLine;
        }
        return `${this.currentLine.slice(0, MAX_PARTIAL_PATCH_LINE_CHARS - 1)}…`;
    }

    private commitLine(line: string): void {
        const header = partialPatchSectionHeader(line);
        if (header !== undefined) {
            this.section = makePartialSection(header.kind, header.path);
            return;
        }

        if (this.section === undefined) {
            return;
        }

        if (this.section.kind === "update" && line.startsWith("*** Move to: ")) {
            this.section.movePath = line.slice("*** Move to: ".length);
            return;
        }

        applyPartialPatchBodyLine(this.section, line);
    }
}

type PartialApplyPatchPreviewUpdate = {
    readonly patch: string;
    readonly theme: CodexRenderTheme;
    readonly expanded: boolean;
    readonly labelMode: ToolLabelMode;
    readonly toolCallId: string;
};

class PartialApplyPatchCallPreviewComponent implements Component {
    private readonly preview = new PartialApplyPatchPreview();
    private readonly toolCallId: string;
    private theme: CodexRenderTheme;
    private expanded = false;
    private labelMode: ToolLabelMode = "static";
    private cachedWidth: number | undefined;
    private cachedLines: string[] | undefined;

    constructor(update: PartialApplyPatchPreviewUpdate) {
        this.toolCallId = update.toolCallId;
        this.theme = update.theme;
        this.update(update);
    }

    belongsTo(toolCallId: string): boolean {
        return this.toolCallId === toolCallId;
    }

    update(update: PartialApplyPatchPreviewUpdate): void {
        this.theme = update.theme;
        this.expanded = update.expanded;
        this.labelMode = update.labelMode;
        this.preview.update(update.patch);
        this.invalidate();
    }

    render(width: number): string[] {
        if (this.cachedWidth === width && this.cachedLines !== undefined) {
            return this.cachedLines;
        }

        const section = this.preview.snapshot();
        const component =
            section === undefined
                ? renderPartialPatchViewport(
                      renderCodexCall(this.theme, {
                          state: "running",
                          statusText: toolStatusLabel(
                              this.labelMode,
                              { isPartial: true, argsComplete: false },
                              {
                                  static: "Apply Patch",
                                  active: "Editing",
                                  completed: "Applied Patch",
                              },
                          ),
                          body: "patch",
                      }),
                      renderCodexBody(this.theme, this.theme.fg("dim", "    …")),
                  )
                : renderApplyPatchSummary(
                      { sections: [section] },
                      this.theme,
                      this.expanded,
                      { isPartial: true, argsComplete: false },
                      this.labelMode,
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

function renderPartialPatchViewport(header: Component, body: Component): Component {
    return makeComponent((width) => {
        const headerLines = header.render(width);
        const firstHeaderLine = headerLines[0] ?? "";
        const boundedHeader =
            headerLines.length <= 1
                ? firstHeaderLine
                : truncateToWidth(`${firstHeaderLine}…`, width, "…");
        const bodyLines = body.render(width).slice(0, MAX_PARTIAL_PATCH_PREVIEW_LINES);
        const padding = Array.from(
            { length: MAX_PARTIAL_PATCH_PREVIEW_LINES - bodyLines.length },
            () => "",
        );
        return [boundedHeader, ...bodyLines, ...padding];
    });
}

function firstBoundedComponentLine(component: Component, width: number): string {
    const lines = component.render(width);
    const firstLine = lines[0] ?? "";
    return lines.length <= 1 ? firstLine : truncateToWidth(`${firstLine}…`, width, "…");
}

function completedDiffLineBudget(lineCount: number, maxRenderedRows: number): number {
    return Math.min(Math.max(1, lineCount), maxRenderedRows);
}

function completedSectionDiff(
    section: ApplyPatchSection,
    theme: CodexRenderTheme,
): Component | undefined {
    if (section.lines.length === 0) {
        return undefined;
    }
    return renderCodexDiff(theme, [section], false, {
        collapsedLineBudget: completedDiffLineBudget(
            section.lines.length,
            MAX_PARTIAL_PATCH_PREVIEW_LINES,
        ),
        maxWrappedRows: 1,
    });
}

function renderCompletedPatchViewport(
    summary: ApplyPatchSummary,
    theme: CodexRenderTheme,
    context: ToolLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const firstSection = summary.sections[0];
    if (firstSection === undefined) {
        return renderCodexBody(theme, "");
    }

    return renderStandalonePatchSections(summary.sections, theme, false, context, labelMode);
}

function verbForSection(section: ApplyPatchSection): "Added" | "Deleted" | "Edited" {
    if (section.kind === "add") {
        return "Added";
    }
    if (section.kind === "delete") {
        return "Deleted";
    }
    return "Edited";
}

function deleteStats(theme: CodexRenderTheme, section: ApplyPatchSection): string {
    return section.countsKnown && section.removed > 0
        ? ` (${theme.fg("toolDiffRemoved", `-${section.removed}`)})`
        : "";
}

function completedPatchSection(
    section: ApplyPatchSection,
    theme: CodexRenderTheme,
    expanded: boolean,
    context: ToolLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const label = toolStatusLabel(labelMode, context, {
        static: "Apply Patch",
        active: "Editing",
        completed: verbForSection(section),
    });
    const diff = expanded
        ? section.lines.length === 0
            ? undefined
            : renderCodexDiff(theme, [section], true)
        : completedSectionDiff(section, theme);
    const header =
        section.kind === "delete" && !section.countsKnown
            ? renderCodexCall(theme, {
                  state: "success",
                  statusText: label,
                  body: `${formatPathTarget(theme, section.path ?? "file")}${deleteStats(theme, section)}`,
              })
            : renderMutationCall(
                  theme,
                  {
                      label,
                      path: section.path ?? "file",
                      added: section.added,
                      removed: section.removed,
                  },
                  { state: "success" },
              );
    if (diff === undefined) {
        return header;
    }
    return makeComponent((width) => [
        firstBoundedComponentLine(header, width),
        ...diff.render(width),
    ]);
}

function renderStandalonePatchSections(
    sections: readonly ApplyPatchSection[],
    theme: CodexRenderTheme,
    expanded: boolean,
    context: ToolLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const components = sections.map((section) =>
        completedPatchSection(section, theme, expanded, context, labelMode),
    );
    return makeComponent((width) =>
        components.flatMap((component, index) => [
            ...(index === 0 ? [] : [""]),
            ...component.render(width),
        ]),
    );
}

function renderSinglePatchSection(
    section: ApplyPatchSection,
    theme: CodexRenderTheme,
    expanded: boolean,
    context: ToolLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    const label = toolStatusLabel(labelMode, context, {
        static: "Apply Patch",
        active: "Editing",
        completed: verbForSection(section),
    });
    if (isActiveToolCall(context)) {
        const header =
            section.kind === "delete"
                ? renderCodexCall(theme, {
                      state: "running",
                      statusText: label,
                      body: formatPathTarget(theme, section.path ?? "file"),
                  })
                : renderMutationCall(
                      theme,
                      {
                          label,
                          path: section.path ?? "file",
                          added: section.added,
                          removed: section.removed,
                      },
                      { state: "running" },
                  );
        const body =
            section.lines.length === 0
                ? renderCodexBody(theme, theme.fg("dim", "    …"))
                : renderCodexDiff(theme, [section], false, {
                      collapsedLineBudget: MAX_PARTIAL_PATCH_PREVIEW_LINES,
                      maxWrappedRows: 1,
                  });
        return renderPartialPatchViewport(header, body);
    }
    if (section.kind === "delete") {
        const header = renderCodexCall(theme, {
            state: "muted",
            statusText: label,
            body: formatPathTarget(theme, section.path ?? "file"),
        });
        return header;
    }
    const body = renderCodexDiff(theme, [section], expanded);
    return renderMutationCall(
        theme,
        {
            label,
            path: section.path ?? "file",
            added: section.added,
            removed: section.removed,
        },
        { body, state: "success" },
    );
}

function renderApplyPatchSummary(
    summary: ApplyPatchSummary,
    theme: CodexRenderTheme,
    expanded: boolean,
    context: ToolLifecycleContext,
    labelMode: ToolLabelMode,
): Component {
    if (!expanded && !isActiveToolCall(context)) {
        return renderCompletedPatchViewport(summary, theme, context, labelMode);
    }

    if (summary.sections.length === 1) {
        const section = summary.sections[0];
        return section === undefined
            ? renderCodexBody(theme, "")
            : renderSinglePatchSection(section, theme, expanded, context, labelMode);
    }

    return renderStandalonePatchSections(summary.sections, theme, expanded, context, labelMode);
}

function renderApplyPatchFallbackCall(
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
): Component {
    const patch = patchTextFromArgs(args);
    const lines =
        patch === undefined || context.isPartial || !context.argsComplete ? 0 : lineCount(patch);
    return renderCodexCall(theme, {
        state: isActiveToolCall(context) ? "running" : "muted",
        statusText: toolStatusLabel(labelMode, context, {
            static: "Apply Patch",
            active: "Editing",
            completed: "Applied Patch",
        }),
        body: lines > 0 ? `${lines} patch lines` : "patch",
    });
}

function renderPartialApplyPatchCall(
    patch: string,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
    labelMode: ToolLabelMode,
): Component {
    const update = {
        patch,
        theme,
        expanded: context.expanded,
        labelMode,
        toolCallId: context.toolCallId,
    };
    if (
        context.lastComponent instanceof PartialApplyPatchCallPreviewComponent &&
        context.lastComponent.belongsTo(context.toolCallId)
    ) {
        context.lastComponent.update(update);
        return context.lastComponent;
    }
    return new PartialApplyPatchCallPreviewComponent(update);
}

function textOutput(result: ThirdPartyToolResult): string | undefined {
    const content = result.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    const text = content.find(
        (item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
    );
    return isRecord(text) && typeof text.text === "string" ? text.text : undefined;
}

function renderApplyPatchFailure(
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean },
    theme: CodexRenderTheme,
    labelMode: ToolLabelMode,
): Component {
    return makeComponent((width) => [
        ...renderCodexCall(theme, {
            state: "error",
            statusText: labelMode === "lifecycle" ? "Failed to apply patch" : "Apply Patch",
        }).render(width),
        ...renderCodexOutput(theme, textOutput(result), {
            expanded: options.expanded,
            mode: "head",
            maxPreviewLines: 5,
            prefixFirst: theme.fg("dim", "  │ "),
            prefixRest: theme.fg("dim", "  │ "),
            noOutputLabel: null,
        }).render(width),
    ]);
}

export function createApplyPatchRenderer(
    _toolName?: string,
    labelMode: ToolLabelMode = "static",
): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const patch = patchTextFromArgs(args);
            if (patch !== undefined && isActiveToolCall(context)) {
                captureDeletePreimages(context.toolCallId, context.cwd ?? process.cwd(), patch);
                return renderPartialApplyPatchCall(patch, theme, context, labelMode);
            }
            const parsedSummary =
                patch === undefined || !canParseCompletedPatchCall(patch)
                    ? undefined
                    : parseApplyPatchSummary(patch);
            const summary =
                parsedSummary === undefined
                    ? undefined
                    : hydrateDeletePreimages(parsedSummary, context.toolCallId);
            return summary === undefined
                ? renderApplyPatchFallbackCall(args, theme, context, labelMode)
                : renderApplyPatchSummary(summary, theme, context.expanded, context, labelMode);
        },
        renderResult(result, options, theme, context) {
            if (context.isError) {
                return renderApplyPatchFailure(result, options, theme, labelMode);
            }
            const patch = patchTextFromArgs(context.args);
            if (
                patch !== undefined &&
                canParseCompletedPatchCall(patch) &&
                parseApplyPatchSummary(patch) !== undefined
            ) {
                return emptyComponent();
            }
            return renderCodexOutput(theme, textOutput(result), {
                expanded: options.expanded,
                mode: "head",
                maxPreviewLines: 5,
            });
        },
    };
}
