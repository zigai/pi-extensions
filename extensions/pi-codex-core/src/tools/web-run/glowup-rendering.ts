import { truncateGraphemeText } from "../../glowup/text.ts";
import {
    glowupWireArray as getArray,
    glowupWireNumber as getNumber,
    glowupWireString as getString,
    glowupWireTextOutput as textOutput,
    parseGlowupWireRecord as getRecord,
    parseGlowupWireArgs,
    parseGlowupWireResult,
    type GlowupWireCallContext,
    type GlowupWireRecord,
    type GlowupWireResultContext,
    type GlowupWireToolResult,
} from "../../glowup/wire.ts";

const MAX_WEB_RUN_HIGHLIGHTS = 3;
const COLLAPSED_SOURCE_LIMIT = 4;
const EXPANDED_SOURCE_LIMIT = 100;
const TITLE_URL_PATTERN = /^(?<title>.+?)\s+\((?<url>https?:\/\/[^)]+)\)$/u;
const TOTAL_LINES_PATTERN = /Total lines:\s*(?<lines>\d+)/u;
const CONTENT_TYPE_PATTERN = /Content type:\s*(?<type>[^;]+)/u;
const SOURCE_PATTERN = /Source:\s*(?<source>[^;]+)/u;
const LINE_PATTERN = /^L\d+:\s*(?<text>.*)$/u;
const CITATION_PATTERN = /cite[^]*/gu;

type WebRunGlowupArgs = GlowupWireRecord;
type WebRunGlowupResult = GlowupWireToolResult;

type SourceCollection = {
    readonly labels: string[];
    readonly seenLabels: Set<string>;
    readonly maximum: number;
    readonly sourceCountKnown: boolean;
    count: number;
};

type HighlightCandidate = {
    readonly text: string;
    readonly index: number;
    readonly score: number;
};

function compactQuotedText(value: string | undefined, maximum = 96): string | undefined {
    if (value === undefined || value.trim().length === 0) return undefined;
    const compact = value.replace(/\s+/gu, " ").trim();
    return `"${truncateGraphemeText(compact, maximum)}"`;
}

function countedSummary(label: string, values: readonly unknown[] | undefined): string | undefined {
    if (values === undefined || values.length === 0) return undefined;
    const prefix = label.length > 0 ? `${label} ` : "";
    const first = values[0];
    const firstRecord = getRecord(first);
    if (firstRecord) {
        const query =
            getString(firstRecord, "q") ??
            getString(firstRecord, "ref_id") ??
            getString(firstRecord, "url");
        const quoted = compactQuotedText(query);
        if (quoted !== undefined) {
            return values.length === 1
                ? `${prefix}${quoted}`
                : `${prefix}${quoted} +${values.length - 1}`;
        }
    }
    return `${prefix}${values.length}`;
}

function summarizeArgs(args: WebRunGlowupArgs): string | undefined {
    const actions = [
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
    const parts = actions.flatMap((action) => {
        const part = countedSummary(
            actions.length === 1 && action.label === "search" ? "" : action.label,
            action.values,
        );
        return part === undefined ? [] : [part];
    });
    return parts.length === 0 ? undefined : parts.join(" • ");
}

function normalizeText(value: string): string {
    return value
        .replace(CITATION_PATTERN, "")
        .replace(/[`*_#]+/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
}

function compactUrl(value: string): string {
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^www\./u, "");
        const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
        return truncateGraphemeText(`${host}${path}`, 70);
    } catch {
        return truncateGraphemeText(value, 70);
    }
}

function sourceLabel(value: string): string | undefined {
    const groups = TITLE_URL_PATTERN.exec(value.trim())?.groups;
    if (groups === undefined) return undefined;
    const title = normalizeText(groups.title ?? "");
    const url = compactUrl(groups.url ?? "");
    if (title.length <= 2 || /^\d+[.)]?$/u.test(title)) return url;
    return `${truncateGraphemeText(title, 72)} — ${url}`;
}

function collectSource(line: string, collection: SourceCollection): void {
    const label = sourceLabel(line);
    if (label === undefined || label.length === 0) return;
    if (collection.sourceCountKnown && collection.labels.length >= collection.maximum) return;
    const key = label.toLowerCase();
    if (collection.seenLabels.has(key)) return;
    collection.seenLabels.add(key);
    collection.count += 1;
    if (collection.labels.length < collection.maximum) collection.labels.push(label);
}

function metadataFromLine(line: string): string | undefined {
    if (!CONTENT_TYPE_PATTERN.test(line)) return undefined;
    const contentType = CONTENT_TYPE_PATTERN.exec(line)?.groups?.type?.trim();
    const source = SOURCE_PATTERN.exec(line)?.groups?.source?.trim();
    const totalLines = TOTAL_LINES_PATTERN.exec(line)?.groups?.lines;
    const parts = [
        source === undefined || source.length === 0
            ? undefined
            : truncateGraphemeText(source.replace(/\s+/gu, " "), 48),
        contentType,
        totalLines === undefined || totalLines.length === 0 ? undefined : `${totalLines} lines`,
    ].filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length === 0 ? undefined : parts.join(" • ");
}

function isBoilerplate(value: string): boolean {
    const lower = value.toLowerCase();
    return (
        lower.length < 4 ||
        [
            "skip to content",
            "main navigation",
            "sidebar navigation",
            "return to top",
            "on this page",
            "appearance",
            "english",
            "menu",
            "references",
            "guide",
            "blog",
        ].includes(lower) ||
        lower.startsWith("search⌘") ||
        /^v\d+\.\d+\.\d+/u.test(lower)
    );
}

function highlightScore(value: string): number {
    if (/^#{1,3}\s/u.test(value)) return 8;
    if (/^\s*[*-]\s/u.test(value)) return 5;
    return value.length >= 80 ? 4 : 2;
}

function collectHighlight(line: string, candidates: HighlightCandidate[]): void {
    const rawText = LINE_PATTERN.exec(line.trim())?.groups?.text;
    if (rawText === undefined) return;
    const normalized = normalizeText(rawText);
    const key = normalized.toLowerCase();
    if (
        normalized.length === 0 ||
        isBoilerplate(normalized) ||
        candidates.some((candidate) => candidate.text.toLowerCase() === key)
    ) {
        return;
    }
    candidates.push({
        text: normalized,
        index: candidates.length,
        score: highlightScore(normalized),
    });
    candidates.sort((left, right) => right.score - left.score || left.index - right.index);
    if (candidates.length > MAX_WEB_RUN_HIGHLIGHTS) candidates.pop();
}

function inlineOutputSummary(
    rawOutput: string | undefined,
    sourceCount: number | undefined,
    context: Pick<GlowupWireCallContext, "expanded">,
): string | undefined {
    if (rawOutput === undefined || rawOutput.length === 0) return undefined;
    const collection: SourceCollection = {
        labels: [],
        seenLabels: new Set<string>(),
        maximum: context.expanded ? EXPANDED_SOURCE_LIMIT : COLLAPSED_SOURCE_LIMIT,
        sourceCountKnown: sourceCount !== undefined,
        count: 0,
    };
    const highlights: HighlightCandidate[] = [];
    let metadata: string | undefined;
    for (const line of rawOutput.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n")) {
        if (line.trim().length === 0) continue;
        collectSource(line, collection);
        metadata ??= metadataFromLine(line);
        collectHighlight(line, highlights);
    }
    const total = sourceCount ?? collection.count;
    const details = [...collection.labels];
    const remaining = Math.max(0, total - details.length);
    if (remaining > 0) details.push(`… +${remaining} sources`);
    if (context.expanded && metadata !== undefined) details.push(`metadata: ${metadata}`);
    if (context.expanded && highlights.length > 0) {
        const preview = [...highlights]
            .sort((left, right) => left.index - right.index)
            .map((candidate) => truncateGraphemeText(candidate.text, 115))
            .join(" · ");
        details.push(`preview: ${preview}`);
    }
    if (total === 0 && details.length === 0) return undefined;
    return [`${total} source${total === 1 ? "" : "s"}`, ...details].join("\n");
}

function summarizeResult(
    result: WebRunGlowupResult,
    context: Pick<GlowupWireCallContext, "expanded">,
): string | undefined {
    const details = getRecord(result.details);
    if (!details) return undefined;
    const sourceCount = getNumber(details, "sourceCount");
    const fullOutputPath = getString(details, "fullOutputPath");
    if (sourceCount === undefined && fullOutputPath === undefined) return undefined;
    return (
        inlineOutputSummary(textOutput(result), sourceCount, context) ??
        (sourceCount === undefined
            ? fullOutputPath === undefined
                ? undefined
                : "Full output saved"
            : `${sourceCount} source${sourceCount === 1 ? "" : "s"}`)
    );
}

type WebRunOperation =
    | "search"
    | "image"
    | "open"
    | "click"
    | "find"
    | "screenshot"
    | "finance"
    | "weather"
    | "sports"
    | "time";

function webResearchLabels() {
    return {
        static: "Web Research",
        running: "Researching the web",
        completed: "Researched the web",
    };
}

function webRunLabels(args: WebRunGlowupArgs) {
    const operations = [
        getArray(args, "search_query") !== undefined ? "search" : undefined,
        getArray(args, "image_query") !== undefined ? "image" : undefined,
        getArray(args, "open") !== undefined ? "open" : undefined,
        getArray(args, "click") !== undefined ? "click" : undefined,
        getArray(args, "find") !== undefined ? "find" : undefined,
        getArray(args, "screenshot") !== undefined ? "screenshot" : undefined,
        getArray(args, "finance") !== undefined ? "finance" : undefined,
        getArray(args, "weather") !== undefined ? "weather" : undefined,
        getArray(args, "sports") !== undefined ? "sports" : undefined,
        getArray(args, "time") !== undefined ? "time" : undefined,
    ].filter((value): value is WebRunOperation => value !== undefined);
    if (operations.length !== 1) return webResearchLabels();
    const operation = operations[0];
    if (operation === undefined) return webResearchLabels();
    switch (operation) {
        case "search":
            return {
                static: "Web Search",
                running: "Searching the web",
                completed: "Searched the web",
            };
        case "image":
            return {
                static: "Image Search",
                running: "Searching images",
                completed: "Searched images",
            };
        case "open":
            return {
                static: "Open Web",
                running: "Opening web page",
                completed: "Opened web page",
            };
        case "click":
            return {
                static: "Web Click",
                running: "Opening web link",
                completed: "Opened web link",
            };
        case "find":
            return { static: "Web Find", running: "Finding on page", completed: "Found on page" };
        case "screenshot":
            return {
                static: "Web Screenshot",
                running: "Capturing web page",
                completed: "Captured web page",
            };
        case "finance":
            return {
                static: "Market Data",
                running: "Fetching market data",
                completed: "Fetched market data",
            };
        case "weather":
            return { static: "Weather", running: "Checking weather", completed: "Checked weather" };
        case "sports":
            return { static: "Sports", running: "Checking sports", completed: "Checked sports" };
        case "time":
            return { static: "Time", running: "Checking time", completed: "Checked time" };
    }
}

function renderWebRunCall(args: WebRunGlowupArgs) {
    const summary = summarizeArgs(args);
    const labels = webRunLabels(args);
    return summary === undefined
        ? { kind: "call" as const, labels }
        : { kind: "call" as const, labels, body: { kind: "text" as const, text: summary } };
}

export const webRunGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
    renderCall(args: WebRunGlowupArgs, _context: GlowupWireCallContext) {
        return renderWebRunCall(args);
    },
    renderResult(result: WebRunGlowupResult, context: GlowupWireResultContext<WebRunGlowupArgs>) {
        const summary = summarizeResult(result, context);
        return summary === undefined
            ? undefined
            : {
                  kind: "output" as const,
                  text: summary,
                  preview: {
                      mode: "head" as const,
                      collapsedLines: COLLAPSED_SOURCE_LIMIT + 2,
                      expandedLines: EXPANDED_SOURCE_LIMIT + 4,
                  },
                  noOutputLabel: null,
              };
    },
} as const;
