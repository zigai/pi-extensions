import type {
    GlowupCallLabels,
    GlowupInline,
    GlowupMutationFile,
    GlowupMutationLine,
    GlowupNode,
    GlowupPreview,
    GlowupSyntax,
    GlowupTone,
} from "./protocol.js";
import { isRecord } from "../unknown-values.js";

export type GlowupNodeDecodeLimits = {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxCollectionItems: number;
    readonly maxTextCharacters: number;
};

export const DEFAULT_GLOWUP_NODE_DECODE_LIMITS: GlowupNodeDecodeLimits = {
    maxDepth: 8,
    maxNodes: 1_000,
    maxCollectionItems: 1_000,
    maxTextCharacters: 1_000_000,
};

type DecodeState = {
    readonly limits: GlowupNodeDecodeLimits;
    nodes: number;
    textCharacters: number;
};

function field(record: Record<string, unknown>, key: string): unknown {
    try {
        return Reflect.get(record, key);
    } catch {
        return undefined;
    }
}

function countText(state: DecodeState, value: string): boolean {
    state.textCharacters += value.length;
    return state.textCharacters <= state.limits.maxTextCharacters;
}

function parseTone(value: unknown): GlowupTone | undefined {
    switch (value) {
        case "default":
        case "muted":
        case "dim":
        case "accent":
        case "success":
        case "error":
        case "path":
        case "url":
        case "code":
            return value;
        default:
            return undefined;
    }
}

function parseInline(value: unknown, state: DecodeState): GlowupInline | undefined {
    if (typeof value === "string") {
        return countText(state, value) ? value : undefined;
    }
    if (!isRecord(value) || field(value, "kind") !== "text") return undefined;
    const valueText = field(value, "text");
    if (typeof valueText !== "string" || !countText(state, valueText)) return undefined;
    const rawTone = field(value, "tone");
    const tone = rawTone === undefined ? undefined : parseTone(rawTone);
    if (rawTone !== undefined && tone === undefined) return undefined;
    const rawBold = field(value, "bold");
    if (rawBold !== undefined && typeof rawBold !== "boolean") return undefined;
    let inline: GlowupInline = { kind: "text", text: valueText };
    if (tone !== undefined) {
        inline = { ...inline, tone };
    }
    if (rawBold !== undefined) {
        inline = { ...inline, bold: rawBold };
    }
    return inline;
}

function parseSyntax(value: unknown, state: DecodeState): GlowupSyntax | undefined {
    if (!isRecord(value)) return undefined;
    const language = field(value, "language");
    const path = field(value, "path");
    if (language !== undefined && typeof language !== "string") return undefined;
    if (path !== undefined && typeof path !== "string") return undefined;
    if (typeof language === "string" && !countText(state, language)) return undefined;
    if (typeof path === "string" && !countText(state, path)) return undefined;
    let syntax: GlowupSyntax = {};
    if (language !== undefined) {
        syntax = { ...syntax, language };
    }
    if (path !== undefined) {
        syntax = { ...syntax, path };
    }
    return syntax;
}

function parsePreview(value: unknown): GlowupPreview | undefined {
    if (!isRecord(value)) return undefined;
    const mode = field(value, "mode");
    if (mode !== undefined && mode !== "head" && mode !== "headTail" && mode !== "hidden") {
        return undefined;
    }
    const collapsedLines = field(value, "collapsedLines");
    const expandedLines = field(value, "expandedLines");
    const expandable = field(value, "expandable");
    const parseLimit = (limit: unknown): number | undefined =>
        typeof limit === "number" && Number.isFinite(limit) && limit >= 1
            ? Math.trunc(limit)
            : undefined;
    const parsedCollapsedLines = parseLimit(collapsedLines);
    const parsedExpandedLines = parseLimit(expandedLines);
    if (
        (collapsedLines !== undefined && parsedCollapsedLines === undefined) ||
        (expandedLines !== undefined && parsedExpandedLines === undefined)
    ) {
        return undefined;
    }
    if (expandable !== undefined && typeof expandable !== "boolean") return undefined;
    let preview: GlowupPreview = {};
    if (mode !== undefined) {
        preview = { ...preview, mode };
    }
    if (parsedCollapsedLines !== undefined) {
        preview = { ...preview, collapsedLines: parsedCollapsedLines };
    }
    if (parsedExpandedLines !== undefined) {
        preview = { ...preview, expandedLines: parsedExpandedLines };
    }
    if (expandable !== undefined) {
        preview = { ...preview, expandable };
    }
    return preview;
}

function parseLabels(value: unknown, state: DecodeState): GlowupCallLabels | undefined {
    if (!isRecord(value)) return undefined;
    const staticLabel = field(value, "static");
    if (
        typeof staticLabel !== "string" ||
        staticLabel.length === 0 ||
        !countText(state, staticLabel)
    ) {
        return undefined;
    }
    const running = field(value, "running");
    const completed = field(value, "completed");
    const failed = field(value, "failed");
    const parseOptionalLabel = (label: unknown): string | undefined =>
        label === undefined ? undefined : typeof label === "string" ? label : undefined;
    const parsedRunning = parseOptionalLabel(running);
    const parsedCompleted = parseOptionalLabel(completed);
    const parsedFailed = parseOptionalLabel(failed);
    if (
        (running !== undefined && parsedRunning === undefined) ||
        (completed !== undefined && parsedCompleted === undefined) ||
        (failed !== undefined && parsedFailed === undefined)
    ) {
        return undefined;
    }
    for (const label of [parsedRunning, parsedCompleted, parsedFailed]) {
        if (label !== undefined && !countText(state, label)) return undefined;
    }
    let labels: GlowupCallLabels = { static: staticLabel };
    if (parsedRunning !== undefined) {
        labels = { ...labels, running: parsedRunning };
    }
    if (parsedCompleted !== undefined) {
        labels = { ...labels, completed: parsedCompleted };
    }
    if (parsedFailed !== undefined) {
        labels = { ...labels, failed: parsedFailed };
    }
    return labels;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
        ? value
        : undefined;
}

function parseMutationLine(value: unknown, state: DecodeState): GlowupMutationLine | undefined {
    if (!isRecord(value)) return undefined;
    const kind = field(value, "kind");
    if (
        kind !== "context" &&
        kind !== "addition" &&
        kind !== "deletion" &&
        kind !== "metadata" &&
        kind !== "omission"
    ) {
        return undefined;
    }
    const text = field(value, "text");
    if (typeof text !== "string" || !countText(state, text)) return undefined;
    const rawOldLine = field(value, "oldLine");
    const rawNewLine = field(value, "newLine");
    const oldLine = rawOldLine === undefined ? undefined : parsePositiveInteger(rawOldLine);
    const newLine = rawNewLine === undefined ? undefined : parsePositiveInteger(rawNewLine);
    if (
        (rawOldLine !== undefined && oldLine === undefined) ||
        (rawNewLine !== undefined && newLine === undefined)
    ) {
        return undefined;
    }
    let line: GlowupMutationLine = { kind, text };
    if (oldLine !== undefined) {
        line = { ...line, oldLine };
    }
    if (newLine !== undefined) {
        line = { ...line, newLine };
    }
    return line;
}

function parseMutationFile(value: unknown, state: DecodeState): GlowupMutationFile | undefined {
    if (!isRecord(value)) return undefined;
    const path = field(value, "path");
    if (typeof path !== "string" || path.length === 0 || !countText(state, path)) return undefined;
    const rawPreviousPath = field(value, "previousPath");
    if (
        rawPreviousPath !== undefined &&
        (typeof rawPreviousPath !== "string" ||
            rawPreviousPath.length === 0 ||
            !countText(state, rawPreviousPath))
    ) {
        return undefined;
    }
    const rawLines = field(value, "lines");
    if (!Array.isArray(rawLines) || rawLines.length > state.limits.maxCollectionItems) {
        return undefined;
    }
    const lines: GlowupMutationLine[] = [];
    for (const rawLine of rawLines) {
        const line = parseMutationLine(rawLine, state);
        if (line === undefined) return undefined;
        lines.push(line);
    }
    const added = parseNonNegativeInteger(field(value, "added"));
    const removed = parseNonNegativeInteger(field(value, "removed"));
    if (added === undefined || removed === undefined) return undefined;
    const countsKnown = field(value, "countsKnown");
    if (countsKnown !== undefined && typeof countsKnown !== "boolean") return undefined;
    if (rawPreviousPath === undefined) {
        return countsKnown === undefined
            ? { path, lines, added, removed }
            : { path, lines, added, removed, countsKnown };
    }
    return countsKnown === undefined
        ? { path, previousPath: rawPreviousPath, lines, added, removed }
        : { path, previousPath: rawPreviousPath, lines, added, removed, countsKnown };
}

function parseNode(value: unknown, state: DecodeState, depth: number): GlowupNode | undefined {
    if (!isRecord(value) || depth > state.limits.maxDepth) return undefined;
    state.nodes += 1;
    if (state.nodes > state.limits.maxNodes) return undefined;

    switch (field(value, "kind")) {
        case "empty":
            return { kind: "empty" };
        case "text": {
            const rawText = field(value, "text");
            const parsed = parseInline(rawText, state);
            return parsed === undefined ? undefined : { kind: "text", text: parsed };
        }
        case "summary": {
            const rawRows = field(value, "rows");
            if (!Array.isArray(rawRows) || rawRows.length > state.limits.maxCollectionItems) {
                return undefined;
            }
            const rows: Array<{ readonly label: GlowupInline; readonly value: GlowupInline }> = [];
            for (const rawRow of rawRows) {
                if (!isRecord(rawRow)) return undefined;
                const label = parseInline(field(rawRow, "label"), state);
                const rowValue = parseInline(field(rawRow, "value"), state);
                if (label === undefined || rowValue === undefined) return undefined;
                rows.push({ label, value: rowValue });
            }
            return { kind: "summary", rows };
        }
        case "code": {
            const rawText = field(value, "text");
            if (typeof rawText !== "string" || !countText(state, rawText)) return undefined;
            const rawTitle = field(value, "title");
            const title = rawTitle === undefined ? undefined : parseInline(rawTitle, state);
            const rawSyntax = field(value, "syntax");
            const syntax = rawSyntax === undefined ? undefined : parseSyntax(rawSyntax, state);
            const rawPreview = field(value, "preview");
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (
                (rawTitle !== undefined && title === undefined) ||
                (rawSyntax !== undefined && syntax === undefined) ||
                (rawPreview !== undefined && preview === undefined)
            ) {
                return undefined;
            }
            let node: GlowupNode = { kind: "code", text: rawText };
            if (title !== undefined) {
                node = { ...node, title };
            }
            if (syntax !== undefined) {
                node = { ...node, syntax };
            }
            if (preview !== undefined) {
                node = { ...node, preview };
            }
            return node;
        }
        case "list": {
            const rawItems = field(value, "items");
            if (!Array.isArray(rawItems) || rawItems.length > state.limits.maxCollectionItems) {
                return undefined;
            }
            const items: Array<GlowupInline | GlowupNode> = [];
            for (const rawItem of rawItems) {
                const beforeInlineText = state.textCharacters;
                const inline = parseInline(rawItem, state);
                if (inline !== undefined) {
                    items.push(inline);
                    continue;
                }
                state.textCharacters = beforeInlineText;
                const node = parseNode(rawItem, state, depth + 1);
                if (node === undefined) return undefined;
                items.push(node);
            }
            const rawPreview = field(value, "preview");
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (rawPreview !== undefined && preview === undefined) return undefined;
            let node: GlowupNode = { kind: "list", items };
            if (preview !== undefined) {
                node = { ...node, preview };
            }
            return node;
        }
        case "call": {
            const labels = parseLabels(field(value, "labels"), state);
            if (labels === undefined) return undefined;
            const rawBody = field(value, "body");
            const body = rawBody === undefined ? undefined : parseNode(rawBody, state, depth + 1);
            const rawPreview = field(value, "preview");
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (
                (rawBody !== undefined && body === undefined) ||
                (rawPreview !== undefined && preview === undefined)
            ) {
                return undefined;
            }
            let node: GlowupNode = { kind: "call", labels };
            if (body !== undefined) {
                node = { ...node, body };
            }
            if (preview !== undefined) {
                node = { ...node, preview };
            }
            return node;
        }
        case "output": {
            const rawText = field(value, "text");
            const rawSyntax = field(value, "syntax");
            const rawPreview = field(value, "preview");
            const rawNoOutputLabel = field(value, "noOutputLabel");
            const syntax = rawSyntax === undefined ? undefined : parseSyntax(rawSyntax, state);
            const preview = rawPreview === undefined ? undefined : parsePreview(rawPreview);
            if (
                (rawText !== undefined &&
                    (typeof rawText !== "string" || !countText(state, rawText))) ||
                (rawSyntax !== undefined && syntax === undefined) ||
                (rawPreview !== undefined && preview === undefined) ||
                (rawNoOutputLabel !== undefined &&
                    rawNoOutputLabel !== null &&
                    (typeof rawNoOutputLabel !== "string" || !countText(state, rawNoOutputLabel)))
            ) {
                return undefined;
            }
            let node: GlowupNode = { kind: "output" };
            if (rawText !== undefined) {
                node = { ...node, text: rawText };
            }
            if (syntax !== undefined) {
                node = { ...node, syntax };
            }
            if (preview !== undefined) {
                node = { ...node, preview };
            }
            if (rawNoOutputLabel !== undefined) {
                node = { ...node, noOutputLabel: rawNoOutputLabel };
            }
            return node;
        }
        case "mutation": {
            const labels = parseLabels(field(value, "labels"), state);
            const rawFiles = field(value, "files");
            if (
                labels === undefined ||
                !Array.isArray(rawFiles) ||
                rawFiles.length === 0 ||
                rawFiles.length > state.limits.maxCollectionItems
            ) {
                return undefined;
            }
            const files: GlowupMutationFile[] = [];
            let collectionItems = rawFiles.length;
            for (const rawFile of rawFiles) {
                const file = parseMutationFile(rawFile, state);
                if (file === undefined) return undefined;
                collectionItems += file.lines.length;
                if (collectionItems > state.limits.maxCollectionItems) return undefined;
                files.push(file);
            }
            const rawPatch = field(value, "patch");
            if (
                rawPatch !== undefined &&
                (typeof rawPatch !== "string" || !countText(state, rawPatch))
            ) {
                return undefined;
            }
            let node: GlowupNode = { kind: "mutation", labels, files };
            if (rawPatch !== undefined) {
                node = { ...node, patch: rawPatch };
            }
            return node;
        }
        case "stack": {
            const rawChildren = field(value, "children");
            if (
                !Array.isArray(rawChildren) ||
                rawChildren.length > state.limits.maxCollectionItems
            ) {
                return undefined;
            }
            const children: GlowupNode[] = [];
            for (const rawChild of rawChildren) {
                const child = parseNode(rawChild, state, depth + 1);
                if (child === undefined) return undefined;
                children.push(child);
            }
            return { kind: "stack", children };
        }
        default:
            return undefined;
    }
}

/** Decodes and bounds a semantic node returned across the tool-definition boundary. */
export function decodeGlowupNode(
    value: unknown,
    limits: GlowupNodeDecodeLimits = DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
): GlowupNode | undefined {
    if (
        !Number.isSafeInteger(limits.maxDepth) ||
        !Number.isSafeInteger(limits.maxNodes) ||
        !Number.isSafeInteger(limits.maxCollectionItems) ||
        !Number.isSafeInteger(limits.maxTextCharacters) ||
        limits.maxDepth < 0 ||
        limits.maxNodes < 1 ||
        limits.maxCollectionItems < 1 ||
        limits.maxTextCharacters < 1
    ) {
        return undefined;
    }
    return parseNode(value, { limits, nodes: 0, textCharacters: 0 }, 0);
}
