export type WebRunFormattedOutput = {
    readonly text: string;
    readonly sourceCount: number;
};

const CITATION_MARKER_PATTERN = /cite[^]*/g;
const URL_PATTERN = /https?:\/\/[^\s)]+/;
const SECTION_SEPARATOR_PATTERN = /\n-{20,}\n/g;
const MAX_SOURCES = 6;
const MAX_SNIPPETS_PER_SOURCE = 6;
const MAX_COMPACT_OUTPUT_CHARS = 12_000;

type ParsedWebRunSource = {
    readonly title: string;
    readonly url?: string | undefined;
    readonly metadata?: string | undefined;
    readonly snippets: readonly WebRunSnippet[];
};

type WebRunSnippet = {
    readonly line?: number | undefined;
    readonly text: string;
};

export function formatWebRunToolOutput(
    rawOutput: string,
    fullOutputPath: string | undefined,
): WebRunFormattedOutput {
    const sources = parseWebRunSources(rawOutput);
    const lines =
        sources.length > 0
            ? formatSources(sources, fullOutputPath)
            : formatPlainText(rawOutput, fullOutputPath);
    return {
        text: truncateCompactOutput(lines.join("\n"), fullOutputPath),
        sourceCount: sources.length,
    };
}

export function stripCodexCitationMarkers(text: string): string {
    return text.replace(CITATION_MARKER_PATTERN, "");
}

function parseWebRunSources(rawOutput: string): ParsedWebRunSource[] {
    return rawOutput
        .split(SECTION_SEPARATOR_PATTERN)
        .flatMap((section) => {
            const parsed = parseWebRunSection(section);
            return parsed ? [parsed] : [];
        })
        .slice(0, MAX_SOURCES);
}

function parseWebRunSection(section: string): ParsedWebRunSource | undefined {
    const cleaned = cleanWebRunText(section);
    const lines = cleaned
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    if (lines.length === 0) return undefined;

    const url = firstUrl(lines);
    const title = parseTitle(lines, url);
    const metadata = parseMetadata(lines);
    const snippets = parseSnippets(lines);
    if (!url && snippets.length === 0 && title.length < 10) return undefined;
    return { title: title || "Web result", url, metadata, snippets };
}

function formatSources(
    sources: readonly ParsedWebRunSource[],
    fullOutputPath: string | undefined,
): string[] {
    const lines = [
        `web_run results (${sources.length} source${sources.length === 1 ? "" : "s"}, compact view)`,
    ];
    if (fullOutputPath) lines.push(`Full raw Codex search output: ${fullOutputPath}`);
    lines.push(
        "Codex citation markers were removed; cite the URLs shown below, not turn/view markers.",
    );
    sources.forEach((source, index) => {
        lines.push("");
        lines.push(`${index + 1}. ${source.title}`);
        if (source.url) lines.push(`   URL: ${source.url}`);
        if (source.metadata) lines.push(`   ${source.metadata}`);
        if (source.snippets.length > 0) {
            lines.push("   Key lines:");
            for (const snippet of source.snippets) {
                const prefix = snippet.line === undefined ? "-" : `L${snippet.line}:`;
                lines.push(`   ${prefix} ${snippet.text}`);
            }
        }
    });
    return lines;
}

function formatPlainText(rawOutput: string, fullOutputPath: string | undefined): string[] {
    const cleaned = cleanWebRunText(rawOutput).trim();
    return [
        "web_run results (compact view)",
        ...(fullOutputPath ? [`Full raw Codex search output: ${fullOutputPath}`] : []),
        "Codex citation markers were removed; cite explicit URLs from the text below.",
        "",
        cleaned,
    ];
}

function truncateCompactOutput(text: string, fullOutputPath: string | undefined): string {
    if (text.length <= MAX_COMPACT_OUTPUT_CHARS) return text;
    const suffix = fullOutputPath
        ? `\n[web_run compact output truncated after ${MAX_COMPACT_OUTPUT_CHARS} characters. Full raw output saved to ${fullOutputPath}.]`
        : `\n[web_run compact output truncated after ${MAX_COMPACT_OUTPUT_CHARS} characters.]`;
    return `${text.slice(0, MAX_COMPACT_OUTPUT_CHARS)}${suffix}`;
}

function cleanWebRunText(text: string): string {
    return stripCodexCitationMarkers(text)
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function firstUrl(lines: readonly string[]): string | undefined {
    for (const line of lines) {
        const match = URL_PATTERN.exec(line);
        if (match) return match[0];
    }
    return undefined;
}

function parseTitle(lines: readonly string[], url: string | undefined): string {
    const firstContentLine = lines.find((line) => !isMetadataLine(line));
    if (!firstContentLine) return "";
    if (!url) return stripLineNoise(firstContentLine);
    const withoutUrl = firstContentLine
        .replace(`(${url})`, "")
        .replace(url, "")
        .replace(/\s+/g, " ")
        .trim();
    return stripLineNoise(withoutUrl || firstContentLine);
}

function parseMetadata(lines: readonly string[]): string | undefined {
    const line = lines.find(isMetadataLine);
    if (!line) return undefined;
    const parts = [
        parseMetadataPart(line, /Content type:\s*([^;]+)/),
        parseMetadataPart(line, /Source:\s*([^;]+)/),
        parseMetadataPart(line, /Total lines:\s*(\d+)/, (value) => `${value} lines`),
    ].filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join(" · ") : undefined;
}

function parseMetadataPart(
    line: string,
    pattern: RegExp,
    format: (value: string) => string = (value) => value,
): string | undefined {
    const match = pattern.exec(line);
    const value = match?.[1]?.trim();
    return value ? format(value) : undefined;
}

function parseSnippets(lines: readonly string[]): WebRunSnippet[] {
    const snippets: WebRunSnippet[] = [];
    for (const line of lines) {
        const match = /^L(\d+):\s*(.*)$/.exec(line);
        if (!match) continue;
        const text = stripLineNoise(match[2] ?? "");
        if (!isUsefulSnippet(text)) continue;
        snippets.push({ line: Number(match[1]), text });
        if (snippets.length >= MAX_SNIPPETS_PER_SOURCE) break;
    }
    if (snippets.length > 0) return snippets;

    for (const line of lines) {
        if (isMetadataLine(line) || URL_PATTERN.test(line)) continue;
        const text = stripLineNoise(line);
        if (!isUsefulSnippet(text)) continue;
        snippets.push({ text });
        if (snippets.length >= 3) break;
    }
    return snippets;
}

function stripLineNoise(line: string): string {
    return line
        .replace(/\[wordlim:\s*\d+\]/g, "")
        .replace(/\s+/g, " ")
        .replace(/^[-*]\s+/, "")
        .trim();
}

function isMetadataLine(line: string): boolean {
    return (
        line.includes("Content type:") || line.includes("Source:") || line.includes("Total lines:")
    );
}

function isUsefulSnippet(text: string): boolean {
    if (text.length < 18) return false;
    if (/^(search|menu|skip to|share:|email|sms|facebook|twitter|linkedin|bluesky)$/i.test(text)) {
        return false;
    }
    if (/^image:/i.test(text)) return false;
    if (/^add .* on google/i.test(text)) return false;
    return true;
}
