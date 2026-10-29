type Fence = { marker: string; length: number; quoted: boolean; markdown: boolean };

function stripQuote(line: string): string {
    let rest = line.trimStart();
    while (rest.startsWith(">")) rest = rest.slice(1).trimStart();

    return rest;
}

function stripIndent(line: string): string | undefined {
    let index = 0;
    let columns = 0;
    while (line[index] === " " || line[index] === "\t") {
        if (line[index] === "\t") columns += 4;
        else columns += 1;

        if (columns >= 4) return undefined;

        index++;
    }

    return line.slice(index);
}

function marker(line: string): { marker: string; length: number } | undefined {
    const match = /^(?:`{3,}|~{3,})/.exec(line);
    if (!match) return undefined;

    return { marker: match[0][0], length: match[0].length };
}

function openFence(line: string): Fence | undefined {
    const trimmed = stripIndent(line);
    if (trimmed === undefined) return undefined;

    const quoted = trimmed.startsWith(">");
    const text = stripQuote(trimmed);
    const found = marker(text);
    if (!found) return undefined;

    const info = text.slice(found.length).trim().split(/\s/)[0]?.toLowerCase();
    return { ...found, quoted, markdown: info === "md" || info === "markdown" };
}

function closesFence(line: string, fence: Fence): boolean {
    const trimmed = stripIndent(line);
    if (trimmed === undefined || (fence.quoted && !trimmed.startsWith(">"))) return false;

    let text = trimmed;
    if (fence.quoted) text = stripQuote(trimmed);

    const found = marker(text);

    return (
        found !== undefined &&
        found.marker === fence.marker &&
        found.length >= fence.length &&
        text.slice(found.length).trim() === ""
    );
}

function segments(line: string): string[] | undefined {
    const text = line.trim();
    if (!text) return undefined;

    const outer = text.startsWith("|") || text.endsWith("|");
    let body = text;
    if (body.startsWith("|")) body = body.slice(1);
    if (body.endsWith("|")) body = body.slice(0, -1);

    const cells: string[] = [];
    let start = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === "\\") i++;
        else if (body[i] === "|") {
            cells.push(body.slice(start, i).trim());
            start = i + 1;
        }
    }

    cells.push(body.slice(start).trim());

    if (outer || cells.length > 1) return cells;

    return undefined;
}

function isDelimiter(line: string): boolean {
    const cells = segments(line);

    return cells?.every((cell) => /^:?-{3,}:?$/.test(cell)) === true;
}

function containsTable(body: string, quoted: boolean): boolean {
    let previous: string | undefined;
    let nested: Fence | undefined;
    for (const line of body.split("\n")) {
        let text = line;
        if (quoted) text = stripQuote(line);
        if (nested) {
            if (closesFence(text, nested)) nested = undefined;
            previous = undefined;
            continue;
        }
        const opening = openFence(text);
        if (opening) {
            nested = opening;
            previous = undefined;
            continue;
        }
        text = text.trim();
        if (!text) {
            previous = undefined;
            continue;
        }

        if (
            previous !== undefined &&
            segments(previous)?.some(Boolean) === true &&
            !isDelimiter(previous) &&
            isDelimiter(text) &&
            segments(previous)?.length === segments(text)?.length
        )
            return true;

        previous = text;
    }

    return false;
}

/** Remove only closed Markdown fences containing a table; leave source otherwise intact. */
export function unwrapTableFences(source: string): string {
    if (!source.includes("```") && !source.includes("~~~")) return source;

    const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let output = "";
    let active: { fence: Fence; opening: string; body: string } | undefined;
    for (const line of lines) {
        if (active) {
            if (closesFence(line, active.fence)) {
                if (active.fence.markdown && containsTable(active.body, active.fence.quoted))
                    output += active.body;
                else output += active.opening + active.body + line;

                active = undefined;
            } else active.body += line;
        } else {
            const fence = openFence(line);
            if (fence) active = { fence, opening: line, body: "" };
            else output += line;
        }
    }

    if (active) output += active.opening + active.body;

    return output;
}
