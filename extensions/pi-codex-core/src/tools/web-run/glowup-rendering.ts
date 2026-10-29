import { StringDecoder } from "../../schema-parsing.ts";
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
const TITLE_URL_PATTERN = /^(?<title>.*?)\s*\((?<url>https?:\/\/[^)]+)\)$/u;
const TOTAL_LINES_PATTERN = /Total lines:\s*(?<lines>\d+)/u;
const CONTENT_TYPE_PATTERN = /Content type:\s*(?<type>[^;]+)/u;
const SOURCE_PATTERN = /Source:\s*(?<source>[^;]+)/u;
const LINE_PATTERN = /^L\d+:\s*(?<text>.*)$/u;
const CITATION_PATTERN = /cite[^]*/gu;

type WebRunGlowupArgs = GlowupWireRecord;
type WebRunGlowupResult = GlowupWireToolResult;

type SourceCollection = {
    readonly labels: string[];
    readonly maximum: number;
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

type TextNode = {
    readonly kind: "text";
    readonly text:
        | string
        | { readonly kind: "text"; readonly text: string; readonly tone: "url" | "muted" };
};

function styledText(text: string, tone?: "url" | "muted"): TextNode {
    if (tone === undefined) return { kind: "text", text };
    return { kind: "text", text: { kind: "text", text, tone } };
}

function summarizeArgs(args: WebRunGlowupArgs, expanded: boolean): TextNode[] {
    const actions = [
        ["search", "search_query"],
        ["image", "image_query"],
        ["open", "open"],
        ["click", "click"],
        ["find", "find"],
        ["screenshot", "screenshot"],
        ["finance", "finance"],
        ["weather", "weather"],
        ["sports", "sports"],
        ["time", "time"],
    ] as const;
    const active = actions.filter(([, key]) => (getArray(args, key)?.length ?? 0) > 0);
    const nodes: TextNode[] = [];
    const limit = expanded ? 10 : 2;
    for (const [label, key] of active) {
        const values = getArray(args, key) ?? [];
        for (const value of values.slice(0, limit)) {
            const record = getRecord(value);
            if (!record) continue;
            const first =
                getString(record, "q") ??
                getString(record, "ref_id") ??
                getString(record, "ticker") ??
                getString(record, "location") ??
                getString(record, "league") ??
                getString(record, "utc_offset");
            const firstText = compactQuotedText(first) ?? "request";
            const prefix = active.length === 1 && label === "search" ? "" : `${label} `;
            const extra: string[] = [];
            const fields = [
                "pattern",
                "id",
                "lineno",
                "pageno",
                "type",
                "market",
                "fn",
                "team",
                "opponent",
                "start",
                "duration",
                "date_from",
                "date_to",
                "num_games",
                "locale",
                "recency",
            ];
            for (const field of fields) {
                const fieldValue = getString(record, field) ?? getNumber(record, field);
                if (fieldValue === undefined) continue;
                const formatted = truncateGraphemeText(
                    String(fieldValue).replace(/\s+/gu, " "),
                    80,
                );
                if (field === "id") extra.push(`#${formatted}`);
                else extra.push(`${field}=${formatted}`);
            }
            const domains = getArray(record, "domains");
            if (domains?.length)
                extra.push(
                    `domains=${domains
                        .slice(0, 4)
                        .flatMap((value) => {
                            const decoded = StringDecoder.decode(value);
                            return decoded === undefined ? [] : [decoded];
                        })
                        .map((v) => truncateGraphemeText(v, 60))
                        .join(",")}`,
                );
            nodes.push(
                styledText(`${prefix}${firstText}`, first?.startsWith("http") ? "url" : undefined),
            );
            if (extra.length) nodes.push(styledText(extra.join(" • "), "muted"));
        }
        if (values.length > limit)
            nodes.push(styledText(`${label} … +${values.length - limit}`, "muted"));
    }
    const length = getString(args, "response_length");
    if (length) nodes.push(styledText(`length=${truncateGraphemeText(length, 20)}`, "muted"));
    return nodes;
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
        maximum: context.expanded ? EXPANDED_SOURCE_LIMIT : COLLAPSED_SOURCE_LIMIT,
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

    const total = Math.max(sourceCount ?? 0, collection.count);
    const details = [...collection.labels];
    const remaining = Math.max(0, total - details.length);
    if (remaining > 0) details.push(`… +${remaining} source${remaining === 1 ? "" : "s"}`);
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

    return webResearchLabels();
}

function renderWebRunCall(args: WebRunGlowupArgs, context: GlowupWireCallContext) {
    const children = summarizeArgs(args, context.expanded);
    const labels = webRunLabels(args);
    if (children.length === 0) return { kind: "call" as const, labels };
    if (children.length === 1) return { kind: "call" as const, labels, body: children[0] };
    return { kind: "call" as const, labels, body: { kind: "stack" as const, children } };
}

function styledResult(summary: string) {
    const children = summary.split("\n").map((line) => {
        const separator = line.indexOf(" — ");
        if (separator >= 0)
            return {
                kind: "summary" as const,
                rows: [
                    {
                        label: line.slice(0, separator),
                        value: {
                            kind: "text" as const,
                            text: line.slice(separator + 3),
                            tone: "url" as const,
                        },
                    },
                ],
            };
        if (line.startsWith("metadata:") || line.startsWith("…")) return styledText(line, "muted");
        return styledText(line);
    });
    return { kind: "stack" as const, children };
}

export const webRunGlowupRendering = {
    version: 3,
    parseArgs: parseGlowupWireArgs,
    parseResult: parseGlowupWireResult,
    renderCall(args: WebRunGlowupArgs, context: GlowupWireCallContext) {
        return renderWebRunCall(args, context);
    },
    renderResult(result: WebRunGlowupResult, context: GlowupWireResultContext<WebRunGlowupArgs>) {
        if (context.isError) return undefined;

        const summary = summarizeResult(result, context);

        return summary === undefined ? undefined : styledResult(summary);
    },
} as const;
