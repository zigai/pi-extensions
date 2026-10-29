import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// Keep every control sequence in its original order. Only ordinary padding spaces may
// be replaced; a wide grapheme, tab, or other non-space content is never overwritten.
const escape = String.fromCharCode(27);
const bell = String.fromCharCode(7);
const controls = new RegExp(
    `${escape}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${bell}${escape}]*(?:${bell}|${escape}\\\\)|_[^${escape}]*${escape}\\\\)`,
    "gy",
);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type Token = { text: string; width: number; space: boolean };

function tokenize(line: string): Token[] | undefined {
    const tokens: Token[] = [];
    let offset = 0;
    while (offset < line.length) {
        if (line[offset] === "\x1b") {
            controls.lastIndex = offset;
            const match = controls.exec(line);
            if (!match) return undefined;

            tokens.push({ text: match[0], width: 0, space: false });
            offset = controls.lastIndex;
            continue;
        }

        const next = line.indexOf("\x1b", offset);
        let end = next;
        if (end < 0) end = line.length;

        for (const { segment } of segmenter.segment(line.slice(offset, end))) {
            if (/\p{Cc}/u.test(segment)) return undefined;

            tokens.push({ text: segment, width: visibleWidth(segment), space: segment === " " });
        }

        offset = end;
    }

    return tokens;
}

export type TimestampRender = { lines: string[]; hit?: TimestampHit };
export type TimestampHit = { x: number; y: number; width: number; renderWidth: number };

export function isDivider(line: string, width: number): boolean {
    const content = stripTerminalSequences(line).trim();
    return /^─{2,}$/u.test(content) && visibleWidth(content) === width;
}

/** Add a label to the first message line without changing the number of lines. */
export function renderTimestamp(lines: string[], width: number, label: string): TimestampRender {
    const unchanged = { lines };

    if (!label || !Number.isInteger(width) || width <= 0 || /\p{Cc}/u.test(label)) return unchanged;

    const index = lines.findIndex(
        (line) => stripTerminalSequences(line).trim().length > 0 && !isDivider(line, width),
    );
    if (index < 0) return unchanged;

    const line = lines.at(index);
    if (line === undefined) return unchanged;

    const tokens = tokenize(line);
    if (!tokens) return unchanged;

    const labelWidth = visibleWidth(label);
    const start = width - labelWidth - 1;
    if (labelWidth <= 0 || start < 1) return unchanged;

    const lineWidth = tokens.reduce((total, token) => total + token.width, 0);
    if (lineWidth > width) return unchanged;

    let position = 0;
    for (const token of tokens) {
        if (token.width > 0 && position + token.width > start - 1 && !token.space) return unchanged;

        position += token.width;
    }

    if (lineWidth < width)
        tokens.push({ text: " ".repeat(width - lineWidth), width: width - lineWidth, space: true });

    let output = "";

    position = 0;

    let inserted = false;
    for (const token of tokens) {
        if (token.space && position + token.width > start) {
            const before = Math.max(0, start - position);
            output += " ".repeat(before);
            if (!inserted) {
                output += `\x1b[2m${label}\x1b[22m`;
                inserted = true;
            }

            const after = Math.max(
                0,
                position + token.width - Math.max(position, start + labelWidth),
            );
            output += " ".repeat(after);
        } else {
            output += token.text;
        }

        position += token.width;
    }

    if (!inserted) return unchanged;

    const result = lines.slice();
    result[index] = output;
    return { lines: result, hit: { x: start, y: index, width: labelWidth, renderWidth: width } };
}
