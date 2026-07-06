import type { CodexRenderTheme } from "../rendering/core.ts";
import type { ThirdPartyToolRenderContext, ThirdPartyToolResult } from "./types.ts";
import { RENDER_THEME_TOKENS } from "../syntax/palette.ts";
import {
    countedSummary,
    previewArgsForContext,
    textOutput,
    truncateText,
    visitNormalizedOutputLines,
} from "./previews.ts";
import {
    getArray,
    getNumber,
    getString,
    isDefined,
    isNonEmptyString,
    isRecord,
} from "./tool-values.ts";

const MAX_WEB_RUN_HIGHLIGHTS = 3;
export const WEB_RUN_COLLAPSED_SOURCE_LIMIT = 4;
const WEB_RUN_EXPANDED_SOURCE_LIMIT = 100;
const WEB_RUN_TITLE_URL_PATTERN = /^(?<title>.+?)\s+\((?<url>https?:\/\/[^)]+)\)$/u;
const WEB_RUN_TOTAL_LINES_PATTERN = /Total lines:\s*(?<lines>\d+)/u;
const WEB_RUN_CONTENT_TYPE_PATTERN = /Content type:\s*(?<type>[^;]+)/u;
const WEB_RUN_SOURCE_PATTERN = /Source:\s*(?<source>[^;]+)/u;
const WEB_RUN_LINE_PATTERN = /^L\d+:\s*(?<text>.*)$/u;
const WEB_RUN_CITATION_PATTERN = /cite[^]*/gu;
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gu;

function getBracketOpener(closingBracket: string): string {
    if (closingBracket === ")") {
        return "(";
    }
    if (closingBracket === "]") {
        return "[";
    }
    return "{";
}

function trimUrlEnd(text: string): string {
    let result = text.replace(/[.,;:!?]+$/u, "");
    while (result.length > 0) {
        const last = result.at(-1);
        if (last !== ")" && last !== "]" && last !== "}") {
            break;
        }

        const opener = getBracketOpener(last);
        const openingCount = result.split(opener).length - 1;
        const closingCount = result.split(last).length - 1;
        if (closingCount <= openingCount) {
            break;
        }
        result = result.slice(0, -1);
    }
    return result;
}

function styleUrlText(theme: CodexRenderTheme, text: string): string {
    return theme.fg(RENDER_THEME_TOKENS.url, text);
}

function highlightUrlText(theme: CodexRenderTheme, text: string): string {
    let output = "";
    let cursor = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        if (match.index === undefined) {
            continue;
        }

        const rawUrl = match[0];
        const url = trimUrlEnd(rawUrl);
        if (url.length === 0) {
            continue;
        }

        const start = match.index;
        const end = start + url.length;
        output += text.slice(cursor, start);
        output += styleUrlText(theme, url);
        cursor = end;
    }

    if (cursor === 0) {
        return text;
    }
    return `${output}${text.slice(cursor)}`;
}

export function summarizeWebRunArgs(
    args: unknown,
    theme: CodexRenderTheme,
    context: ThirdPartyToolRenderContext,
): string | undefined {
    if (!isRecord(args)) {
        return previewArgsForContext(args, context);
    }

    const webRunActions = [
        { label: "search", values: getArray(args, "search_query") },
        { label: "image", values: getArray(args, "image_query") },
        { label: "open", values: getArray(args, "open") },
        { label: "click", values: getArray(args, "click") },
        { label: "find", values: getArray(args, "find") },
        { label: "screenshot", values: getArray(args, "screenshot") },
        { label: "finance", values: getArray(args, "finance") },
        { label: "weather", values: getArray(args, "weather") },
        { label: "sports", values: getArray(args, "sports") },
        { label: "time", values: getArray(args, "time") },
    ].filter((action) => action.values !== undefined && action.values.length > 0);
    const parts = webRunActions
        .map((action) =>
            countedSummary(
                webRunActions.length === 1 && action.label === "search" ? "" : action.label,
                action.values,
            ),
        )
        .filter(isDefined);
    return parts.length > 0
        ? highlightUrlText(theme, parts.join(" • "))
        : previewArgsForContext(args, context);
}

function normalizeWebRunText(text: string): string {
    return text
        .replace(WEB_RUN_CITATION_PATTERN, "")
        .replace(/[`*_#]+/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
}

function compactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./u, "");
        const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "");
        return truncateText(`${host}${path}`, 70);
    } catch {
        return truncateText(url, 70);
    }
}

function isUsefulWebRunTitle(title: string): boolean {
    const normalized = normalizeWebRunText(title);
    return normalized.length > 2 && !/^\d+[.)]?$/u.test(normalized);
}

function formatWebRunSourceLabel(theme: CodexRenderTheme, text: string): string | undefined {
    const match = WEB_RUN_TITLE_URL_PATTERN.exec(text.trim());
    const groups = match?.groups;
    if (!groups) {
        return undefined;
    }

    const url = groups.url ?? "";
    const sourceUrl = styleUrlText(theme, compactUrl(url));
    if (!isUsefulWebRunTitle(groups.title ?? "")) {
        return sourceUrl;
    }
    return `${truncateText(normalizeWebRunText(groups.title ?? ""), 72)} — ${sourceUrl}`;
}

type WebRunSourceCollection = {
    readonly labels: string[];
    readonly seenLabels: Set<string>;
    readonly maxLabels: number | undefined;
    readonly sourceCountKnown: boolean;
    count: number;
};

function collectWebRunSourceLabel(
    theme: CodexRenderTheme,
    line: string,
    collection: WebRunSourceCollection,
): void {
    const label = formatWebRunSourceLabel(theme, line);
    if (label === undefined || label.length === 0) {
        return;
    }

    if (
        collection.sourceCountKnown &&
        collection.maxLabels !== undefined &&
        collection.labels.length >= collection.maxLabels
    ) {
        return;
    }

    const key = label.toLowerCase();
    if (collection.seenLabels.has(key)) {
        return;
    }

    collection.seenLabels.add(key);
    collection.count += 1;
    if (collection.maxLabels === undefined || collection.labels.length < collection.maxLabels) {
        collection.labels.push(label);
    }
}

function formatWebRunSummary(options: {
    readonly sourceCount: number | undefined;
    readonly sources: ReadonlyArray<string>;
    readonly metadata: string | undefined;
    readonly highlights: string | undefined;
    readonly expanded: boolean;
}): string | undefined {
    const sourceTotal = options.sourceCount ?? options.sources.length;
    const headline =
        sourceTotal > 0 ? `${sourceTotal} source${sourceTotal === 1 ? "" : "s"}` : undefined;
    const sourceLimit = options.expanded ? options.sources.length : WEB_RUN_COLLAPSED_SOURCE_LIMIT;
    const sources = options.sources.slice(0, sourceLimit);
    const remainingSourceCount = Math.max(0, sourceTotal - sources.length);
    const details = [...sources];

    if (remainingSourceCount > 0) {
        details.push(`… +${remainingSourceCount} sources`);
    }
    if (options.expanded && isNonEmptyString(options.metadata)) {
        details.push(`metadata: ${options.metadata}`);
    }
    if (options.expanded && isNonEmptyString(options.highlights)) {
        details.push(`preview: ${options.highlights}`);
    }

    if (headline === undefined && details.length === 0) {
        return undefined;
    }
    return [headline, ...details].filter(isDefined).join("\n");
}

function compactWebRunSource(source: string): string {
    const normalized = source
        .replace(/\(\{.+\}/u, "(")
        .replace(/\s+/gu, " ")
        .trim();
    return truncateText(normalized, 48);
}

function webRunMetadataFromLine(line: string): string | undefined {
    if (!WEB_RUN_CONTENT_TYPE_PATTERN.test(line)) {
        return undefined;
    }

    const contentType = WEB_RUN_CONTENT_TYPE_PATTERN.exec(line)?.groups?.type?.trim();
    const source = WEB_RUN_SOURCE_PATTERN.exec(line)?.groups?.source?.trim();
    const totalLines = WEB_RUN_TOTAL_LINES_PATTERN.exec(line)?.groups?.lines;
    const parts = [
        isNonEmptyString(source) ? compactWebRunSource(source) : undefined,
        contentType,
        isNonEmptyString(totalLines) ? `${totalLines} lines` : undefined,
    ].filter(isDefined);
    return parts.length > 0 ? parts.join(" • ") : undefined;
}

function isWebRunBoilerplate(text: string): boolean {
    const lower = text.toLowerCase();
    return (
        lower.length < 4 ||
        lower === "skip to content" ||
        lower === "main navigation" ||
        lower === "sidebar navigation" ||
        lower === "return to top" ||
        lower === "on this page" ||
        lower === "appearance" ||
        lower === "english" ||
        lower === "menu" ||
        lower === "references" ||
        lower === "guide" ||
        lower === "blog" ||
        lower.startsWith("search⌘") ||
        /^v\d+\.\d+\.\d+/u.test(lower)
    );
}

function webRunHighlightScore(text: string): number {
    if (/^#{1,3}\s/u.test(text)) {
        return 8;
    }
    if (/^\s*[*-]\s/u.test(text)) {
        return 5;
    }
    if (text.length >= 80) {
        return 4;
    }
    return 2;
}

type WebRunHighlightCandidate = {
    readonly text: string;
    readonly index: number;
    readonly score: number;
};

type WebRunHighlightCollection = {
    readonly candidates: WebRunHighlightCandidate[];
    nextIndex: number;
};

function collectWebRunHighlight(line: string, collection: WebRunHighlightCollection): void {
    const match = WEB_RUN_LINE_PATTERN.exec(line.trim());
    const rawText = match?.groups?.text;
    if (rawText === undefined) {
        return;
    }

    const normalized = normalizeWebRunText(rawText);
    const key = normalized.toLowerCase();
    if (
        normalized.length === 0 ||
        isWebRunBoilerplate(normalized) ||
        collection.candidates.some((candidate) => candidate.text.toLowerCase() === key)
    ) {
        return;
    }

    collection.candidates.push({
        text: normalized,
        index: collection.nextIndex,
        score: webRunHighlightScore(normalized),
    });
    collection.nextIndex += 1;
    collection.candidates.sort(
        (left, right) => right.score - left.score || left.index - right.index,
    );
    if (collection.candidates.length > MAX_WEB_RUN_HIGHLIGHTS) {
        collection.candidates.pop();
    }
}

function formatWebRunHighlights(
    candidates: ReadonlyArray<WebRunHighlightCandidate>,
): string | undefined {
    if (candidates.length === 0) {
        return undefined;
    }

    return [...candidates]
        .sort((left, right) => left.index - right.index)
        .map((highlight) => truncateText(highlight.text, 115))
        .join(" · ");
}

function webRunOutputSummary(
    theme: CodexRenderTheme,
    output: string | undefined,
    sourceCount: number | undefined,
    options: { readonly expanded: boolean },
): string | undefined {
    if (output === undefined || output.length === 0) {
        return undefined;
    }

    const sourceCollection: WebRunSourceCollection = {
        labels: [],
        seenLabels: new Set<string>(),
        maxLabels: options.expanded
            ? WEB_RUN_EXPANDED_SOURCE_LIMIT
            : WEB_RUN_COLLAPSED_SOURCE_LIMIT,
        sourceCountKnown: sourceCount !== undefined,
        count: 0,
    };
    const highlightCollection: WebRunHighlightCollection = {
        candidates: [],
        nextIndex: 0,
    };
    let metadata: string | undefined;

    const sawOutput = visitNormalizedOutputLines(output, (line) => {
        collectWebRunSourceLabel(theme, line, sourceCollection);
        metadata ??= webRunMetadataFromLine(line);
        collectWebRunHighlight(line, highlightCollection);
    });
    if (!sawOutput) {
        return undefined;
    }

    const highlights = formatWebRunHighlights(highlightCollection.candidates);
    if (
        sourceCollection.count === 0 &&
        !isNonEmptyString(metadata) &&
        !isNonEmptyString(highlights)
    ) {
        return undefined;
    }

    return formatWebRunSummary({
        sourceCount: sourceCount ?? sourceCollection.count,
        sources: sourceCollection.labels,
        metadata,
        highlights,
        expanded: options.expanded,
    });
}

export function webRunResultSummary(
    theme: CodexRenderTheme,
    result: ThirdPartyToolResult,
    options: { readonly expanded: boolean },
): string | undefined {
    if (!isRecord(result.details)) {
        return undefined;
    }
    const sourceCount = getNumber(result.details, "sourceCount");
    const outputPath = getString(result.details, "fullOutputPath");
    if (sourceCount === undefined && outputPath === undefined) {
        return undefined;
    }

    const inlineSummary = webRunOutputSummary(theme, textOutput(result), sourceCount, options);
    if (inlineSummary !== undefined) {
        return inlineSummary;
    }

    if (sourceCount !== undefined) {
        return `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;
    }

    return outputPath === undefined ? undefined : "Full output saved";
}
