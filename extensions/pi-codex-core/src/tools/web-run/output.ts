export type WebRunSource = {
    readonly title?: string | undefined;
    readonly url?: string | undefined;
    readonly paragraphs: readonly string[];
    readonly omitted: boolean;
};

const MAX_EXCERPT_CHARS = 800;
const MAX_EXCERPT_LINES = 8;
const MAX_EXCERPT_PARAGRAPHS = 3;
export const WEB_RUN_OMISSION =
    "[Remaining content omitted; full text is in the tool result artifact.]";

function stripCodexCitationMarkers(text: string): string {
    return text
        .replace(/(?:cite|navlist|image)[^]*/gu, "")
        .replace(/【(?:turn[^】]*|\d+†[^】]*)】/gu, "");
}

/** Parse both remote Markdown/page output and restored numbered compact results. No source cap. */
export function parseWebRunSources(rawOutput: string): WebRunSource[] {
    const sources: WebRunSource[] = [];
    let title: string | undefined;
    let url: string | undefined;
    let content: ContentLine[] = [];
    const flush = () => {
        const excerpt = readableExcerpt(content);
        if (title || url || excerpt.paragraphs.length > 0) {
            sources.push({ title, url, ...excerpt });
        }

        title = undefined;
        url = undefined;
        content = [];
    };

    const lines = stripCodexCitationMarkers(rawOutput)
        .replace(/\u00a0/gu, " ")
        // Remote search sometimes appends the ruler directly to the preceding paragraph.
        .replace(/[+|]?-{20,}[+|]?/gu, "\n")
        .split(/\r?\n/u);

    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? "").trim();
        if (/^(?:[+|]?-{3,}[+|]?|_{3,}|\*{3,})$/u.test(line)) {
            flush();
            continue;
        }

        const heading = /^(?:#{1,6}\s+)?(?:\d+\.\s+)?\[?(.+?)\]?\s*\((https?:\/\/\S+)\)\s*$/u.exec(
            line,
        );
        if (heading) {
            flush();
            title = cleanText(heading[1] ?? "");
            url = heading[2];
            continue;
        }

        // Compact entries use a numbered title followed by an explicit URL line.
        if (/^\d+\.\s+/u.test(line) && /^\s*URL:\s*https?:\/\//u.test(lines[index + 1] ?? "")) {
            flush();
            title = cleanText(line.replace(/^\d+\.\s+/u, ""));
            continue;
        }

        const link = /^(?:(?:URL:|Opened)\s*)?(https?:\/\/\S+)$/u.exec(line);
        if (link) {
            if (url) flush();
            url = link[1];
            continue;
        }

        if (
            /^(?:web_run results|Full raw Codex search output:|Codex citation markers|Key lines:)/u.test(
                line,
            )
        )
            continue;

        if (/(?:Content type:|Source:\s*(?:open|find|click)\(|Total lines:)/iu.test(line)) continue;

        const cleaned = cleanText(line);
        if (url && !title && /^(?:L\d+:\s*)?#{1,6}\s/u.test(line)) {
            title = cleaned;
            continue;
        }

        if (/^(?:Source|Content[- ]type|Total[- ]lines):/iu.test(cleaned)) continue;
        if (cleaned !== "" && cleaned === title) continue;

        if (/^(?:Menu|Search|Skip to (?:content|main content)|Share:|Image:)$/iu.test(cleaned))
            continue;

        content.push({
            text: cleaned,
            prose: !/^(?:#{1,6}\s|[-*]\s)/u.test(cleanContentLine(line)),
        });
    }

    flush();

    return sources;
}

type ContentLine = { readonly text: string; readonly prose: boolean };

function cleanContentLine(line: string): string {
    return line
        .replace(/\[wordlim:\s*\d+\]/giu, "")
        .trim()
        .replace(/(?:Published|Crawled):\s*[^;]*(?:;|$)\s*/giu, "")
        .replace(/^L\d+:\s*/u, "")
        .trim();
}

function cleanText(line: string): string {
    return cleanContentLine(line)
        .replace(/^#{1,6}\s+/u, "")
        .replace(/^[-*]\s+/u, "")
        .replace(/^\*\*(.*?)\*\*$/u, "$1")
        .replace(/\s+/gu, " ")
        .trim();
}

function readableExcerpt(
    lines: readonly ContentLine[],
): Pick<WebRunSource, "paragraphs" | "omitted"> {
    const paragraphs: string[] = [];
    let paragraph: string[] = [];
    let chars = 0;
    let count = 0;

    // Prefer prose to page navigation/headings, but retain heading-only API excerpts.
    const prose = lines.filter((line) => line.prose);

    // Navigation labels and signatures must not crowd out explanatory sentences.
    const descriptive = prose.filter(
        (line) => line.text === "" || line.text.split(/\s+/u).length >= 6,
    );
    const selected = descriptive.some((line) => line.text !== "")
        ? descriptive
        : prose.some((line) => line.text !== "")
          ? prose
          : lines;

    // Deduplicate complete paragraphs within this source before applying excerpt budgets.
    const seen = new Set<string>();
    const uniqueLines: string[] = [];
    for (const section of selected
        .map((line) => line.text)
        .join("\n")
        .split(/\n{2,}/u)) {
        const sectionLines = section.split("\n").filter((line) => line !== "");
        const text = sectionLines.join(" ");
        if (text === "" || seen.has(text)) continue;
        seen.add(text);
        uniqueLines.push(...sectionLines, "");
    }

    let omitted = false;

    const flush = () => {
        if (paragraph.length > 0) paragraphs.push(paragraph.join(" "));
        paragraph = [];
    };

    for (const line of uniqueLines) {
        if (line === "") {
            flush();
            continue;
        }

        if (
            count >= MAX_EXCERPT_LINES ||
            paragraphs.length >= MAX_EXCERPT_PARAGRAPHS ||
            chars >= MAX_EXCERPT_CHARS
        ) {
            omitted = true;
            break;
        }

        const available = MAX_EXCERPT_CHARS - chars;
        if (line.length > available) {
            // End an oversized line at a word boundary, not in the middle of a raw page.
            paragraph.push(line.slice(0, available).replace(/\s+\S*$/u, "") + "…");
            omitted = true;
            break;
        }

        paragraph.push(line);
        chars += line.length + 1;
        count += 1;
    }

    flush();

    return { paragraphs, omitted };
}
