const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ST = `${ESC}\\`;
const DEFAULT_FOREGROUND = `${ESC}[39m`;
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;
const FILE_EXTENSION_PATTERN = [
    "astro",
    "bash",
    "c",
    "cjs",
    "css",
    "gif",
    "go",
    "gql",
    "graphql",
    "h",
    "html?",
    "ico",
    "iso",
    "java",
    "jpeg",
    "jpg",
    "js",
    "jsonc?",
    "jsx",
    "kt",
    "kts",
    "less",
    "lock",
    "log",
    "mdx?",
    "mjs",
    "php",
    "png",
    "proto",
    "py",
    "rb",
    "rs",
    "sass",
    "scss",
    "sh",
    "sql",
    "sqlite",
    "svg",
    "svelte",
    "swift",
    "toml",
    "tsx?",
    "txt",
    "vue",
    "wasm",
    "webp",
    "ya?ml",
    "zsh",
].join("|");
const HOME_OR_DOT_PATH_PREFIX_PATTERN = String.raw`(?:~/|\.{1,2}/)`;
const PATH_SEGMENT_PATTERN = String.raw`[A-Za-z0-9._~+@%-]+`;
const SPACED_PATH_SEGMENT_PATTERN = String.raw`${PATH_SEGMENT_PATTERN}(?: ${PATH_SEGMENT_PATTERN})*`;
const PATH_FILENAME_PATTERN = String.raw`${PATH_SEGMENT_PATTERN}\.(?:${FILE_EXTENSION_PATTERN})`;
const SPACED_PATH_FILENAME_PATTERN = String.raw`${SPACED_PATH_SEGMENT_PATTERN}\.(?:${FILE_EXTENSION_PATTERN})`;
const HOME_OR_DOT_PATH_PATTERN = String.raw`${HOME_OR_DOT_PATH_PREFIX_PATTERN}${PATH_SEGMENT_PATTERN}(?:/${PATH_SEGMENT_PATTERN})*`;
const ROOT_PATH_PATTERN = String.raw`/(?:${PATH_FILENAME_PATTERN}|${PATH_SEGMENT_PATTERN}/${PATH_SEGMENT_PATTERN}(?:/${PATH_SEGMENT_PATTERN})*)`;
const PREFIXED_PATH_PATTERN = String.raw`(?:${HOME_OR_DOT_PATH_PATTERN}|${ROOT_PATH_PATTERN})`;
const SPACED_PREFIXED_FILE_PATH_PATTERN = String.raw`(?:${HOME_OR_DOT_PATH_PREFIX_PATTERN}|/)(?:${SPACED_PATH_SEGMENT_PATTERN}/)+${SPACED_PATH_FILENAME_PATTERN}`;
const RELATIVE_FILE_PATH_PATTERN = String.raw`${PATH_SEGMENT_PATTERN}(?:/${PATH_SEGMENT_PATTERN})*/${PATH_FILENAME_PATTERN}`;
const BARE_FILENAME_PATTERN = String.raw`(?:${PATH_FILENAME_PATTERN}|Dockerfile|Justfile|Makefile|\.(?:env|gitignore|npmrc|prettierignore)(?:\.[A-Za-z0-9_-]+)?)`;
const LINE_SUFFIX_PATTERN = String.raw`(?::\d+(?:-\d+)?(?::\d+)?)?`;
const BARE_EXTENSION_FILEPATH_REGEX = new RegExp(
    String.raw`^${PATH_FILENAME_PATTERN}${LINE_SUFFIX_PATTERN}$`,
);
const FILEPATH_REGEX = new RegExp(
    String.raw`(^|[\s([{<"'\x60])((?:${SPACED_PREFIXED_FILE_PATH_PATTERN}|${PREFIXED_PATH_PATTERN}|${RELATIVE_FILE_PATH_PATTERN}|${BARE_FILENAME_PATTERN})${LINE_SUFFIX_PATTERN})(?=$|[\s)\]}>"'\x60,.;:!?])`,
    "g",
);
const CODE_VALUE_PREFIX_PATTERN = /[:=]\s*$/;
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/;
const TRAILING_PATH_PUNCTUATION = /[.,;!?]+$/;
const MAX_WRAPPED_HIGHLIGHT_LINES = 5;

export type HighlightStyles = {
    readonly url: string;
    readonly filepath: string;
};

type TextIntensity = {
    readonly bold: boolean;
    readonly faint: boolean;
};

type TextToken = {
    readonly kind: "text";
    readonly text: string;
    readonly plainStart: number;
    readonly plainEnd: number;
    readonly foreground: string | undefined;
    readonly intensity: TextIntensity;
};

type ControlToken = {
    readonly kind: "control";
    readonly text: string;
};

type Token = TextToken | ControlToken;

export type HighlightRange = {
    readonly start: number;
    readonly end: number;
    readonly style: string;
};

type LineContent = {
    readonly lineIndex: number;
    readonly lineTextStart: number;
    readonly text: string;
};

type JoinedLineContent = LineContent & {
    readonly joinedStart: number;
    readonly joinedEnd: number;
};

type JoinedLineVariant = {
    readonly text: string;
    readonly chunks: readonly JoinedLineContent[];
};

const DEFAULT_WRAPPED_LINE_JOINERS = ["", " "] as const;
const SPACE_WRAPPED_LINE_JOINER = [" "] as const;

function readEscapeSequence(text: string, start: number): string {
    const introducer = text.at(start + 1);
    if (introducer === undefined) return text.slice(start, start + 1);

    if (introducer === "[") {
        for (let index = start + 2; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) return text.slice(start, index + 1);
        }

        return text.slice(start);
    }

    if (introducer === "]" || introducer === "_" || introducer === "P" || introducer === "^") {
        const belIndex = text.indexOf(BEL, start + 2);
        const stIndex = text.indexOf(ST, start + 2);
        if (belIndex === -1 && stIndex === -1) return text.slice(start);

        if (belIndex !== -1 && (stIndex === -1 || belIndex < stIndex)) {
            return text.slice(start, belIndex + BEL.length);
        }

        return text.slice(start, stIndex + ST.length);
    }

    return text.slice(start, start + 2);
}

function parseSgrNumbers(sequence: string): number[] | undefined {
    if (!sequence.startsWith(`${ESC}[`) || !sequence.endsWith("m")) return undefined;

    const params = sequence.slice(2, -1);
    if (params.length === 0) return [0];

    const numbers: number[] = [];
    for (const param of params.split(";")) {
        if (param.length === 0) {
            numbers.push(0);
            continue;
        }

        const value = Number(param);
        if (!Number.isInteger(value)) return undefined;

        numbers.push(value);
    }

    return numbers;
}

function resolveForegroundAfterSgr(
    sequence: string,
    currentForeground: string | undefined,
): string | undefined {
    const numbers = parseSgrNumbers(sequence);
    if (numbers === undefined) return currentForeground;

    let foreground = currentForeground;

    for (let index = 0; index < numbers.length; index += 1) {
        const code = numbers[index] ?? 0;
        if (code === 0) {
            foreground = undefined;
        } else if (code === 39) {
            foreground = undefined;
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            foreground = `${ESC}[${code}m`;
        } else if (code === 38) {
            const mode = numbers[index + 1];
            if (mode === 5) {
                const color = numbers.at(index + 2);
                if (color !== undefined) {
                    foreground = `${ESC}[38;5;${color}m`;
                    index += 2;
                }
            } else if (mode === 2) {
                const red = numbers.at(index + 2);
                const green = numbers.at(index + 3);
                const blue = numbers.at(index + 4);
                if (red !== undefined && green !== undefined && blue !== undefined) {
                    foreground = `${ESC}[38;2;${red};${green};${blue}m`;
                    index += 4;
                }
            }
        }
    }

    return foreground;
}

function resolveIntensityAfterSgr(sequence: string, current: TextIntensity): TextIntensity {
    const numbers = parseSgrNumbers(sequence);
    if (numbers === undefined) return current;

    let { bold, faint } = current;
    for (let index = 0; index < numbers.length; index += 1) {
        const code = numbers[index];
        if (code === 0 || code === 22) {
            bold = false;
            faint = false;
        } else if (code === 1) {
            bold = true;
        } else if (code === 2) {
            faint = true;
        } else if (code === 38 || code === 48 || code === 58) {
            const mode = numbers[index + 1];
            if (mode === 5) index += 2;
            if (mode === 2) index += 4;
        }
    }

    return { bold, faint };
}

function restoreIntensity(style: string, original: TextIntensity): string {
    let styled = original;

    for (let index = 0; index < style.length; index += 1) {
        if (style[index] !== ESC) continue;

        const sequence = readEscapeSequence(style, index);
        styled = resolveIntensityAfterSgr(sequence, styled);
        index += sequence.length - 1;
    }

    if (styled.bold === original.bold && styled.faint === original.faint) return "";

    let restored = `${ESC}[22m`;
    if (original.bold) restored += `${ESC}[1m`;
    if (original.faint) restored += `${ESC}[2m`;

    return restored;
}

type TokenizedAnsi = {
    readonly tokens: Token[];
    readonly plainText: string;
};

function tokenizeAnsi(text: string): TokenizedAnsi {
    const tokens: Token[] = [];
    let plainText = "";
    let foreground: string | undefined;
    let intensity: TextIntensity = { bold: false, faint: false };
    let index = 0;

    while (index < text.length) {
        if (text[index] === ESC) {
            const sequence = readEscapeSequence(text, index);
            foreground = resolveForegroundAfterSgr(sequence, foreground);
            intensity = resolveIntensityAfterSgr(sequence, intensity);
            tokens.push({ kind: "control", text: sequence });
            index += sequence.length;
            continue;
        }

        const start = index;

        while (index < text.length && text[index] !== ESC) {
            index += 1;
        }

        const tokenText = text.slice(start, index);

        tokens.push({
            kind: "text",
            text: tokenText,
            plainStart: plainText.length,
            plainEnd: plainText.length + tokenText.length,
            foreground,
            intensity,
        });
        plainText += tokenText;
    }

    return { tokens, plainText };
}

function getTrailingPunctuationPattern(kind: "url" | "filepath"): RegExp {
    if (kind === "url") return TRAILING_URL_PUNCTUATION;
    return TRAILING_PATH_PUNCTUATION;
}

function getBracketOpener(closingBracket: string): string {
    if (closingBracket === ")") return "(";
    if (closingBracket === "]") return "[";
    return "{";
}

function trimMatchEnd(text: string, kind: "url" | "filepath"): string {
    const trimmed = text.replace(getTrailingPunctuationPattern(kind), "");
    let result = trimmed;
    while (result.length > 0) {
        const last = result.at(-1);
        if (last !== ")" && last !== "]" && last !== "}") break;

        const opener = getBracketOpener(last);
        const openingCount = result.split(opener).length - 1;
        const closingCount = result.split(last).length - 1;
        if (closingCount <= openingCount) break;

        result = result.slice(0, -1);
    }

    return result;
}

function overlapsRange(ranges: readonly HighlightRange[], start: number, end: number): boolean {
    return ranges.some((range) => start < range.end && end > range.start);
}

function addHighlightRange(ranges: HighlightRange[], range: HighlightRange): void {
    if (range.end <= range.start) return;
    if (overlapsRange(ranges, range.start, range.end)) return;

    ranges.push(range);
}

function getLinePrefix(text: string, end: number): string {
    const lineStart = text.lastIndexOf("\n", Math.max(0, end - 1)) + 1;
    return text.slice(lineStart, end);
}

function isBareExtensionFilepath(text: string): boolean {
    if (text.includes("/")) return false;
    return BARE_EXTENSION_FILEPATH_REGEX.test(text);
}

function isCodeValueContext(plainText: string, start: number): boolean {
    const prefix = getLinePrefix(plainText, start);
    if (prefix.trimStart().length === 0) return false;
    return CODE_VALUE_PREFIX_PATTERN.test(prefix);
}

function shouldSkipFilepathMatch(plainText: string, start: number, filepath: string): boolean {
    if (!isBareExtensionFilepath(filepath)) return false;
    return isCodeValueContext(plainText, start);
}

function addRange(
    ranges: HighlightRange[],
    start: number,
    rawText: string,
    kind: "url" | "filepath",
    style: string,
): void {
    const text = trimMatchEnd(rawText, kind);
    if (text.length === 0) return;

    const end = start + text.length;
    addHighlightRange(ranges, { start, end, style });
}

export function collectHighlightRanges(
    plainText: string,
    styles: HighlightStyles,
): HighlightRange[] {
    const ranges: HighlightRange[] = [];

    for (const match of plainText.matchAll(URL_REGEX)) {
        addRange(ranges, match.index, match[0], "url", styles.url);
    }

    for (const match of plainText.matchAll(FILEPATH_REGEX)) {
        const prefix = match.at(1) ?? "";
        const filepath = match.at(2);
        if (filepath === undefined) continue;

        const start = match.index + prefix.length;
        if (shouldSkipFilepathMatch(plainText, start, filepath)) continue;
        addRange(ranges, start, filepath, "filepath", styles.filepath);
    }

    return ranges.sort((left, right) => left.start - right.start);
}

export function plainTextFromAnsi(text: string): string {
    return tokenizeAnsi(text).plainText;
}

function restoreForeground(foreground: string | undefined): string {
    return foreground ?? DEFAULT_FOREGROUND;
}

function appendTextWithHighlights(
    output: string[],
    token: TextToken,
    ranges: readonly HighlightRange[],
): void {
    let tokenOffset = 0;

    for (const range of ranges) {
        if (range.end <= token.plainStart) continue;
        if (range.start >= token.plainEnd) break;

        const highlightStart = Math.max(range.start, token.plainStart) - token.plainStart;
        const highlightEnd = Math.min(range.end, token.plainEnd) - token.plainStart;

        if (highlightStart > tokenOffset) {
            output.push(token.text.slice(tokenOffset, highlightStart));
        }

        output.push(range.style);
        output.push(token.text.slice(highlightStart, highlightEnd));
        output.push(restoreForeground(token.foreground));
        output.push(restoreIntensity(range.style, token.intensity));
        tokenOffset = highlightEnd;
    }

    if (tokenOffset < token.text.length) {
        output.push(token.text.slice(tokenOffset));
    }
}

export function highlightMessageLineRanges(
    line: string,
    ranges: readonly HighlightRange[],
): string {
    if (line.length === 0 || ranges.length === 0) return line;

    const { tokens } = tokenizeAnsi(line);
    const output: string[] = [];
    for (const token of tokens) {
        if (token.kind === "control") {
            output.push(token.text);
        } else {
            appendTextWithHighlights(output, token, ranges);
        }
    }

    return output.join("");
}

export function highlightMessageLine(line: string, styles: HighlightStyles): string {
    if (line.length === 0) return line;

    const plainText = plainTextFromAnsi(line);
    const ranges = collectHighlightRanges(plainText, styles);
    return highlightMessageLineRanges(line, ranges);
}

function leadingSpaceLength(text: string): number {
    let index = 0;
    while (text[index] === " ") {
        index += 1;
    }

    return index;
}

function getLineContent(line: string, lineIndex: number): LineContent {
    const text = plainTextFromAnsi(line).trimEnd();
    const lineTextStart = leadingSpaceLength(text);
    return {
        lineIndex,
        lineTextStart,
        text: text.slice(lineTextStart),
    };
}

function trailingToken(text: string): string {
    const match = /\S+$/.exec(text);
    return match?.[0] ?? "";
}

function tokenCanContinueIntoSlash(token: string): boolean {
    if (token.includes("/")) return true;
    if (token.startsWith("http://")) return true;
    if (token.startsWith("https://")) return true;
    if (token.startsWith("~")) return true;
    return token.startsWith(".");
}

function getWrappedLineJoiners(previousText: string, nextText: string): readonly string[] {
    if (!nextText.startsWith("/")) return DEFAULT_WRAPPED_LINE_JOINERS;

    const previousToken = trailingToken(previousText);
    if (tokenCanContinueIntoSlash(previousToken)) return DEFAULT_WRAPPED_LINE_JOINERS;

    return SPACE_WRAPPED_LINE_JOINER;
}

function buildJoinedLineVariants(contents: readonly LineContent[]): JoinedLineVariant[] {
    const first = contents.at(0);
    if (first === undefined) return [];

    let variants: JoinedLineVariant[] = [
        {
            text: first.text,
            chunks: [
                {
                    ...first,
                    joinedStart: 0,
                    joinedEnd: first.text.length,
                },
            ],
        },
    ];

    for (let index = 1; index < contents.length; index += 1) {
        const previousContent = contents.at(index - 1);
        const content = contents.at(index);
        if (previousContent === undefined || content === undefined) continue;

        const joiners = getWrappedLineJoiners(previousContent.text, content.text);
        const nextVariants: JoinedLineVariant[] = [];
        for (const variant of variants) {
            for (const joiner of joiners) {
                const joinedStart = variant.text.length + joiner.length;

                nextVariants.push({
                    text: `${variant.text}${joiner}${content.text}`,
                    chunks: [
                        ...variant.chunks,
                        {
                            ...content,
                            joinedStart,
                            joinedEnd: joinedStart + content.text.length,
                        },
                    ],
                });
            }
        }

        variants = nextVariants;
    }

    return variants;
}

function rangeSpansMultipleChunks(
    range: HighlightRange,
    chunks: readonly JoinedLineContent[],
): boolean {
    let overlapCount = 0;
    for (const chunk of chunks) {
        if (range.start < chunk.joinedEnd && range.end > chunk.joinedStart) {
            overlapCount += 1;
        }

        if (overlapCount > 1) return true;
    }

    return false;
}

function isWrappedHighlightCandidate(text: string): boolean {
    if (text.includes("/")) return true;
    if (text.startsWith("http://")) return true;
    return text.startsWith("https://");
}

function addWrappedRangeToLines(
    lineRanges: HighlightRange[][],
    range: HighlightRange,
    variant: JoinedLineVariant,
): void {
    for (const chunk of variant.chunks) {
        const start = Math.max(range.start, chunk.joinedStart);
        const end = Math.min(range.end, chunk.joinedEnd);
        if (end <= start) continue;

        const ranges = lineRanges.at(chunk.lineIndex);
        if (ranges === undefined) continue;

        addHighlightRange(ranges, {
            start: chunk.lineTextStart + start - chunk.joinedStart,
            end: chunk.lineTextStart + end - chunk.joinedStart,
            style: range.style,
        });
    }
}

function addWrappedHighlightRanges(
    lineRanges: HighlightRange[][],
    contents: readonly LineContent[],
    styles: HighlightStyles,
): void {
    for (let startIndex = 0; startIndex < contents.length; startIndex += 1) {
        const windowContents: LineContent[] = [];
        for (
            let endIndex = startIndex;
            endIndex < contents.length && windowContents.length < MAX_WRAPPED_HIGHLIGHT_LINES;
            endIndex += 1
        ) {
            const content = contents.at(endIndex);
            if (content === undefined || content.text.length === 0) break;

            windowContents.push(content);

            if (windowContents.length < 2) continue;

            for (const variant of buildJoinedLineVariants(windowContents)) {
                const ranges = collectHighlightRanges(variant.text, styles);
                for (const range of ranges) {
                    if (!rangeSpansMultipleChunks(range, variant.chunks)) continue;

                    const matchedText = variant.text.slice(range.start, range.end);
                    if (!isWrappedHighlightCandidate(matchedText)) continue;
                    addWrappedRangeToLines(lineRanges, range, variant);
                }
            }
        }
    }
}

export function highlightMessageLines(lines: readonly string[], styles: HighlightStyles): string[] {
    const contents = lines.map((line, index) => getLineContent(line, index));
    const lineRanges = contents.map((content) =>
        collectHighlightRanges(content.text, styles).map((range) => ({
            start: content.lineTextStart + range.start,
            end: content.lineTextStart + range.end,
            style: range.style,
        })),
    );

    addWrappedHighlightRanges(lineRanges, contents, styles);

    return lines.map((line, index) => {
        const ranges = lineRanges[index] ?? [];

        ranges.sort((left, right) => left.start - right.start);

        return highlightMessageLineRanges(line, ranges);
    });
}

export function getStylePrefix(styleFn: (text: string) => string): string {
    const sentinel = "\u0000";
    const styled = styleFn(sentinel);
    const sentinelIndex = styled.indexOf(sentinel);
    if (sentinelIndex < 0) return "";
    return styled.slice(0, sentinelIndex);
}
