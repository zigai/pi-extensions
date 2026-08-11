export type ImportPrologueOmission = {
    readonly code: string;
    readonly omittedLines: number;
};

type LexicalBalance = {
    readonly delimiters: number;
    readonly continued: boolean;
};

function lexicalBalance(lines: readonly string[], start: number): LexicalBalance & { end: number } {
    const stack: string[] = [];
    let quote: "'" | '"' | "`" | undefined;
    let escaped = false;
    let blockComment = false;
    let end = start;
    let continued = false;

    for (; end < lines.length; end += 1) {
        const line = lines[end] ?? "";
        let lineComment = false;
        for (let index = 0; index < line.length; index += 1) {
            const character = line[index];
            const next = line[index + 1];
            if (character === undefined) continue;
            if (lineComment) break;
            if (blockComment) {
                if (character === "*" && next === "/") {
                    blockComment = false;
                    index += 1;
                }
                continue;
            }
            if (quote !== undefined) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === quote) quote = undefined;
                continue;
            }
            if (character === "#") {
                lineComment = true;
                break;
            }
            if (character === "/" && next === "/") {
                lineComment = true;
                break;
            }
            if (character === "/" && next === "*") {
                blockComment = true;
                index += 1;
                continue;
            }
            if (character === "'" || character === '"' || character === "`") {
                quote = character;
                continue;
            }
            if (["(", "[", "{"].includes(character)) stack.push(character);
            else if ([")", "]", "}"].includes(character) && stack.length > 0) stack.pop();
        }
        continued = /\\\s*$/u.test(line) || stack.length > 0 || quote !== undefined || blockComment;
        if (!continued) break;
    }

    return { delimiters: stack.length, continued, end: Math.min(lines.length, end + 1) };
}

function pythonImportEnd(lines: readonly string[], start: number): number | undefined {
    const first = (lines[start] ?? "").trimStart();
    if (!/^(?:from\s+\S+\s+import(?:\s|$)|import(?:\s|$))/u.test(first)) return undefined;
    const balance = lexicalBalance(lines, start);
    return balance.delimiters === 0 && !balance.continued ? balance.end : undefined;
}

function javascriptImportEnd(lines: readonly string[], start: number): number | undefined {
    const first = (lines[start] ?? "").trimStart();
    const possibleImport =
        /^import(?!\s*\()(?:\s|["'])/u.test(first) ||
        /^export\s+(?:type\s+)?(?:\{|\*)/u.test(first) ||
        /^(?:const|let|var)\s+/u.test(first);
    if (!possibleImport) return undefined;

    const balance = lexicalBalance(lines, start);
    if (balance.delimiters !== 0 || balance.continued) return undefined;
    const statement = lines.slice(start, balance.end).join("\n");
    if (/^\s*import(?!\s*\()/u.test(statement)) return balance.end;
    if (/^\s*export\s+(?:type\s+)?(?:\{|\*)[\s\S]*?\sfrom\s/u.test(statement)) {
        return balance.end;
    }
    if (/^\s*(?:const|let|var)\s+[\s\S]*?=\s*require\s*\(/u.test(statement)) {
        return balance.end;
    }
    return undefined;
}

function importStatementEnd(
    lines: readonly string[],
    start: number,
    language: string,
): number | undefined {
    if (language === "python") return pythonImportEnd(lines, start);
    if (language === "javascript" || language === "typescript") {
        return javascriptImportEnd(lines, start);
    }
    return undefined;
}

/** Selects a long script's complete leading import prologue without changing short scripts. */
export function omitLeadingImportPrologue(
    code: string,
    language: string,
    maxPreviewLines: number,
): ImportPrologueOmission | undefined {
    const lines = code.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
    if (lines.length <= maxPreviewLines) return undefined;

    let cursor = 0;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) cursor += 1;
    let sawImport = false;
    let prologueEnd = cursor;
    while (cursor < lines.length) {
        const statementEnd = importStatementEnd(lines, cursor, language);
        if (statementEnd === undefined) break;
        sawImport = true;
        cursor = statementEnd;
        while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) cursor += 1;
        prologueEnd = cursor;
    }
    if (!sawImport || !lines.slice(prologueEnd).some((line) => line.trim().length > 0)) {
        return undefined;
    }
    return {
        code: lines.slice(prologueEnd).join("\n"),
        omittedLines: prologueEnd,
    };
}
