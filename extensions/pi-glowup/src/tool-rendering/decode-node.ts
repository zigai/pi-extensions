import type {
    GlowupCallLabels,
    GlowupInline,
    GlowupNode,
    GlowupPreview,
    GlowupSyntax,
    GlowupTone,
} from "./protocol.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    return {
        kind: "text",
        text: valueText,
        ...(tone === undefined ? {} : { tone }),
        ...(rawBold === undefined ? {} : { bold: rawBold }),
    };
}

function parseSyntax(value: unknown, state: DecodeState): GlowupSyntax | undefined {
    if (!isRecord(value)) return undefined;
    const language = field(value, "language");
    const path = field(value, "path");
    if (language !== undefined && typeof language !== "string") return undefined;
    if (path !== undefined && typeof path !== "string") return undefined;
    if (typeof language === "string" && !countText(state, language)) return undefined;
    if (typeof path === "string" && !countText(state, path)) return undefined;
    return {
        ...(language === undefined ? {} : { language }),
        ...(path === undefined ? {} : { path }),
    };
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
    return {
        ...(mode === undefined ? {} : { mode }),
        ...(parsedCollapsedLines === undefined ? {} : { collapsedLines: parsedCollapsedLines }),
        ...(parsedExpandedLines === undefined ? {} : { expandedLines: parsedExpandedLines }),
        ...(expandable === undefined ? {} : { expandable }),
    };
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
    return {
        static: staticLabel,
        ...(parsedRunning === undefined ? {} : { running: parsedRunning }),
        ...(parsedCompleted === undefined ? {} : { completed: parsedCompleted }),
        ...(parsedFailed === undefined ? {} : { failed: parsedFailed }),
    };
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
            return {
                kind: "code",
                text: rawText,
                ...(title === undefined ? {} : { title }),
                ...(syntax === undefined ? {} : { syntax }),
                ...(preview === undefined ? {} : { preview }),
            };
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
            return { kind: "list", items, ...(preview === undefined ? {} : { preview }) };
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
            return {
                kind: "call",
                labels,
                ...(body === undefined ? {} : { body }),
                ...(preview === undefined ? {} : { preview }),
            };
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
            return {
                kind: "output",
                ...(rawText === undefined ? {} : { text: rawText }),
                ...(syntax === undefined ? {} : { syntax }),
                ...(preview === undefined ? {} : { preview }),
                ...(rawNoOutputLabel === undefined ? {} : { noOutputLabel: rawNoOutputLabel }),
            };
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
