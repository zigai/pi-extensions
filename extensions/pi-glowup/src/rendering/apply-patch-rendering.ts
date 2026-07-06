import type { Component } from "@earendil-works/pi-tui";
import {
    emptyComponent,
    makeComponent,
    renderCodexDiff,
    renderCodexOutput,
    renderMutationCall,
    type CodexRenderTheme,
    type DiffSection,
} from "./core.ts";
import type {
    ThirdPartyToolRenderer,
    ThirdPartyToolRenderContext,
    ThirdPartyToolResult,
} from "../third-party-tools/types.ts";

type ApplyPatchKind = "add" | "delete" | "update";

type ApplyPatchSection = DiffSection & {
    readonly kind: ApplyPatchKind;
};

type ApplyPatchSummary = {
    readonly sections: readonly ApplyPatchSection[];
    readonly added: number;
    readonly removed: number;
};

const MAX_PARTIAL_PATCH_PARSE_CHARS = 8 * 1024;
const MAX_COMPLETED_PATCH_PARSE_CHARS = 64 * 1024;

type MutableApplyPatchSection = {
    kind: ApplyPatchKind;
    path: string;
    movePath: string | undefined;
    lines: string[];
    added: number;
    removed: number;
    oldLine: number;
    newLine: number;
    sawUpdateChunk: boolean;
};

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

function canParsePatchCall(patchText: string, context: ThirdPartyToolRenderContext): boolean {
    if (!context.isPartial && context.argsComplete) {
        return patchText.length <= MAX_COMPLETED_PATCH_PARSE_CHARS;
    }
    return patchText.length <= MAX_PARTIAL_PATCH_PARSE_CHARS && hasCompletePatchEnvelope(patchText);
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
        sawUpdateChunk: false,
    };
}

function finalizedSection(section: MutableApplyPatchSection): ApplyPatchSection {
    return {
        kind: section.kind,
        path: displayPath(section),
        lines: [...section.lines],
        added: section.added,
        removed: section.removed,
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
                current.lines.push(`+${current.added} ${line.slice(1)}`);
            }
            continue;
        }

        if (current.kind === "delete") {
            continue;
        }

        if (line === "@@" || line.startsWith("@@ ")) {
            if (current.sawUpdateChunk && current.lines.at(-1) !== "   ...") {
                current.lines.push("   ...");
            }
            current.sawUpdateChunk = true;
            continue;
        }

        if (line.startsWith("+")) {
            current.added += 1;
            current.lines.push(`+${current.newLine} ${line.slice(1)}`);
            current.newLine += 1;
            continue;
        }

        if (line.startsWith("-")) {
            current.removed += 1;
            current.lines.push(`-${current.oldLine} ${line.slice(1)}`);
            current.oldLine += 1;
            continue;
        }

        if (line.startsWith(" ")) {
            current.lines.push(` ${current.newLine} ${line.slice(1)}`);
            current.oldLine += 1;
            current.newLine += 1;
            continue;
        }

        if (line.length === 0) {
            current.lines.push(` ${current.newLine} `);
            current.oldLine += 1;
            current.newLine += 1;
        }
    }

    flush();

    if (sections.length === 0) {
        return undefined;
    }

    return {
        sections,
        added: sections.reduce((total, section) => total + section.added, 0),
        removed: sections.reduce((total, section) => total + section.removed, 0),
    };
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

function renderApplyPatchSummary(
    summary: ApplyPatchSummary,
    theme: CodexRenderTheme,
    expanded: boolean,
): Component {
    const [singleSection] = summary.sections;
    const label =
        summary.sections.length === 1 && singleSection !== undefined
            ? verbForSection(singleSection)
            : "Edited";
    const path =
        summary.sections.length === 1 && singleSection !== undefined
            ? (singleSection.path ?? "file")
            : `${summary.sections.length} ${summary.sections.length === 1 ? "file" : "files"}`;

    return renderMutationCall(
        theme,
        {
            label,
            path,
            added: summary.added,
            removed: summary.removed,
        },
        {
            body: renderCodexDiff(theme, summary.sections, expanded),
        },
    );
}

function renderApplyPatchFallbackCall(
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
): Component {
    const patch = patchTextFromArgs(args);
    const lines =
        patch === undefined || context.isPartial || !context.argsComplete ? 0 : lineCount(patch);
    return renderMutationCall(theme, {
        label: context.isPartial || !context.argsComplete ? "Editing" : "Edited",
        path: lines > 0 ? `${lines} patch lines` : "patch",
        added: 0,
        removed: 0,
    });
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
): Component {
    return makeComponent((width) => [
        theme.fg("error", theme.bold("✘ Failed to apply patch")),
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

export function createApplyPatchRenderer(): ThirdPartyToolRenderer {
    return {
        renderCall(args, theme, context) {
            const patch = patchTextFromArgs(args);
            const summary =
                patch === undefined || !canParsePatchCall(patch, context)
                    ? undefined
                    : parseApplyPatchSummary(patch);
            return summary === undefined
                ? renderApplyPatchFallbackCall(args, theme, context)
                : renderApplyPatchSummary(summary, theme, context.expanded);
        },
        renderResult(result, options, theme, context) {
            if (context.isError) {
                return renderApplyPatchFailure(result, options, theme);
            }
            const patch = patchTextFromArgs(context.args);
            if (
                patch !== undefined &&
                canParsePatchCall(patch, context) &&
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
