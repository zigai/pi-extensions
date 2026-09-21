import { hasNonWhitespaceText } from "../../../text-boundaries.ts";

export type ScriptInvocation = {
    readonly label: string;
    readonly language: string;
    readonly code: string;
};

const heredocOpenPattern =
    /(?<operator><<-?)\s*(?:"(?<doubleMarker>[A-Za-z_][A-Za-z0-9_]*)"|'(?<singleMarker>[A-Za-z_][A-Za-z0-9_]*)'|(?<bareMarker>[A-Za-z_][A-Za-z0-9_]*))/u;

type ScriptInterpreter = {
    readonly displayName: string;
    readonly language: string;
};

function stripShellQuotedValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
        return trimmed;
    }

    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first !== "'" && first !== '"') || first !== last) {
        return trimmed;
    }

    const inner = trimmed.slice(1, -1);
    if (first === "'") {
        return inner.replace(/'\\''/g, "'");
    }

    return inner.replace(/\\(["\\$`])/g, "$1");
}

function stripShellWrapper(command: string | undefined): string {
    const normalized = (command ?? "").trim();
    const wrapperMatch = /^(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh|fish)\s+-lc\s+([\s\S]+)$/u.exec(
        normalized,
    );
    if (!wrapperMatch) {
        return normalized;
    }

    return stripShellQuotedValue(wrapperMatch[1] ?? "");
}

function decodeShellWord(word: string): string {
    let decoded = "";
    let quote: "'" | '"' | "$'" | undefined;
    let escaped = false;

    for (let index = 0; index < word.length; index += 1) {
        const char = word[index] ?? "";

        if (quote === "$'") {
            if (escaped) {
                if (char === "n") decoded += "\n";
                else if (char === "r") decoded += "\r";
                else if (char === "t") decoded += "\t";
                else if (char === "\\" || char === "'" || char === '"') decoded += char;
                else decoded += `\\${char}`;
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === "'") {
                quote = undefined;
            } else {
                decoded += char;
            }
            continue;
        }

        if (quote === "'") {
            if (char === "'") {
                quote = undefined;
            } else {
                decoded += char;
            }
            continue;
        }

        if (quote === '"') {
            if (escaped) {
                decoded += ['"', "\\", "$", "`"].includes(char) ? char : `\\${char}`;
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === '"') {
                quote = undefined;
            } else {
                decoded += char;
            }
            continue;
        }

        if (escaped) {
            decoded += char;
            escaped = false;
            continue;
        }

        if (char === "\\") {
            escaped = true;
            continue;
        }

        if (char === "$" && word[index + 1] === "'") {
            quote = "$'";
            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
        } else {
            decoded += char;
        }
    }

    if (escaped) {
        decoded += "\\";
    }

    return decoded;
}

function unquoteCommandWord(word: string): string {
    return decodeShellWord(word).replace(/,$/, "");
}

function scriptInterpreterForWord(word: string): ScriptInterpreter | undefined {
    const basename = commandBasename(word);
    if (basename === "py" || /^(?:python|pypy)(?:\d+(?:\.\d+)?)?$/u.test(basename)) {
        return { displayName: "Python", language: "python" };
    }

    if (basename === "node" || basename === "nodejs") {
        return { displayName: "Node", language: "javascript" };
    }

    if (basename === "deno") {
        return { displayName: "Deno", language: "typescript" };
    }

    if (basename === "bun") {
        return { displayName: "Bun", language: "typescript" };
    }

    if (basename === "tsx" || basename === "ts-node") {
        return { displayName: "TypeScript", language: "typescript" };
    }

    if (basename === "ruby") {
        return { displayName: "Ruby", language: "ruby" };
    }

    if (basename === "perl") {
        return { displayName: "Perl", language: "perl" };
    }

    if (basename === "php") {
        return { displayName: "PHP", language: "php" };
    }

    if (basename === "bash" || basename === "sh" || basename === "zsh") {
        return { displayName: "Shell", language: "bash" };
    }

    return undefined;
}

export function detectScriptInterpreter(prefix: string): ScriptInterpreter | undefined {
    return directScriptInterpreter(tokenizeShellWords(prefix))?.interpreter;
}

function normalizeCodeForDisplay(code: string): string {
    return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");
}

type HeredocOpening = {
    readonly prefix: string;
    readonly suffix: string;
    readonly marker: string;
    readonly bodyStart: number;
    readonly stripLeadingTabs: boolean;
};

type HeredocClosing =
    | {
          readonly code: string;
          readonly hasTrailingShell: false;
      }
    | {
          readonly hasTrailingShell: true;
      };

function parseHeredocScriptInvocation(displayCommand: string): ScriptInvocation | undefined {
    const opening = parseHeredocOpening(displayCommand);
    if (opening === undefined) {
        return undefined;
    }

    const body = displayCommand.slice(opening.bodyStart);
    const closing = findHeredocClosing(body, opening.marker, opening.stripLeadingTabs);
    if (closing?.hasTrailingShell === true) {
        return undefined;
    }

    return buildScriptInvocationForHeredoc(opening.prefix, opening.suffix, closing?.code ?? body);
}

function parseHeredocOpening(displayCommand: string): HeredocOpening | undefined {
    const firstLineEnd = firstLineEndIndex(displayCommand);
    const firstLine = displayCommand.slice(0, firstLineEnd);
    const match = heredocOpenPattern.exec(firstLine);
    const groups = match?.groups;
    if (match === null || groups === undefined) {
        return undefined;
    }

    const suffix = firstLine.slice(match.index + match[0].length);
    if (hasShellControlOperator(suffix)) {
        return undefined;
    }

    return {
        prefix: firstLine.slice(0, match.index),
        suffix,
        marker: groups.doubleMarker ?? groups.singleMarker ?? groups.bareMarker ?? "",
        bodyStart: nextLineStartIndex(displayCommand, firstLineEnd),
        stripLeadingTabs: groups.operator === "<<-",
    };
}

function firstLineEndIndex(text: string): number {
    for (let index = 0; index < text.length; index += 1) {
        const charCode = text.charCodeAt(index);
        if (charCode === 10 || charCode === 13) {
            return index;
        }
    }

    return text.length;
}

function nextLineStartIndex(text: string, lineEnd: number): number {
    if (lineEnd >= text.length) {
        return text.length;
    }

    if (text.charCodeAt(lineEnd) === 13 && text.charCodeAt(lineEnd + 1) === 10) {
        return lineEnd + 2;
    }

    return lineEnd + 1;
}

function hasShellControlOperator(text: string): boolean {
    const pipeInterpreter =
        /^\s*\|\s*(?:[A-Za-z_][A-Za-z0-9_]*[\\/])?(?:python|python\d+(?:\.\d+)?|node|nodejs|bun|deno|ruby|perl|php)\b/iu.test(
            text,
        );
    let quote: "'" | '"' | undefined;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index] ?? "";
        if (quote !== undefined) {
            if (quote === '"' && escaped) {
                escaped = false;
                continue;
            }

            if (quote === '"' && char === "\\") {
                escaped = true;
                continue;
            }

            if (char === quote) {
                quote = undefined;
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === "\\") {
            escaped = true;
            continue;
        }

        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }

        if (char === "|" && pipeInterpreter) {
            continue;
        }

        if (["|", ";", "&"].includes(char)) {
            return true;
        }
    }

    return false;
}

function findHeredocClosing(
    body: string,
    marker: string,
    stripLeadingTabs: boolean,
): HeredocClosing | undefined {
    if (marker.length === 0) {
        return undefined;
    }

    let lineStart = 0;
    for (let index = 0; index <= body.length; index += 1) {
        if (index < body.length) {
            const charCode = body.charCodeAt(index);
            if (charCode !== 10 && charCode !== 13) {
                continue;
            }
        }

        if (heredocDelimiterMatches(body, lineStart, index, marker, stripLeadingTabs)) {
            const trailingStart = nextLineStartIndex(body, index);
            if (hasNonWhitespaceText(body.slice(trailingStart))) {
                return { hasTrailingShell: true };
            }

            return {
                code: body.slice(0, heredocCodeEndIndex(body, lineStart)),
                hasTrailingShell: false,
            };
        }

        if (
            index < body.length &&
            body.charCodeAt(index) === 13 &&
            body.charCodeAt(index + 1) === 10
        ) {
            index += 1;
        }

        lineStart = index + 1;
    }

    return undefined;
}

function heredocCodeEndIndex(body: string, closingLineStart: number): number {
    if (closingLineStart === 0) {
        return 0;
    }

    if (body.charCodeAt(closingLineStart - 2) === 13) {
        return closingLineStart - 2;
    }

    return closingLineStart - 1;
}

function heredocDelimiterMatches(
    text: string,
    start: number,
    end: number,
    expected: string,
    stripLeadingTabs: boolean,
): boolean {
    let markerStart = start;

    if (stripLeadingTabs) {
        while (markerStart < end && text.charCodeAt(markerStart) === 9) {
            markerStart += 1;
        }
    }

    if (end - markerStart !== expected.length) {
        return false;
    }

    for (let index = 0; index < expected.length; index += 1) {
        if (text.charCodeAt(markerStart + index) !== expected.charCodeAt(index)) {
            return false;
        }
    }

    return true;
}

function buildScriptInvocationForInterpreter(
    interpreter: ScriptInterpreter,
    code: string,
): ScriptInvocation {
    return {
        label: interpreter.displayName,
        language: interpreter.language,
        code: normalizeCodeForDisplay(code),
    };
}

function buildScriptInvocationForHeredoc(
    prefix: string,
    suffix: string,
    code: string,
): ScriptInvocation | undefined {
    const pipeMatch = /^\s*\|\s*(?<pipedCmd>.+)$/u.exec(suffix);
    if (pipeMatch?.groups?.pipedCmd !== undefined) {
        const interpreter = detectScriptInterpreter(pipeMatch.groups.pipedCmd);
        if (interpreter !== undefined) {
            return buildScriptInvocationForInterpreter(interpreter, code);
        }
    }

    const interpreter = detectScriptInterpreter(prefix);
    if (interpreter !== undefined) {
        return buildScriptInvocationForInterpreter(interpreter, code);
    }

    return undefined;
}

type ShellLexeme = {
    readonly kind: "word" | "separator" | "redirection";
    readonly source: string;
    readonly start: number;
    readonly end: number;
};

export function tokenizeShellLexemes(command: string): ShellLexeme[] {
    const lexemes: ShellLexeme[] = [];
    let wordStart: number | undefined;
    let quote: "'" | '"' | "$'" | undefined;
    let escaped = false;
    let expectRedirectionTarget = false;

    const pushWord = (end: number): void => {
        if (wordStart !== undefined) {
            lexemes.push({
                kind: expectRedirectionTarget ? "redirection" : "word",
                source: command.slice(wordStart, end),
                start: wordStart,
                end,
            });
            wordStart = undefined;
            expectRedirectionTarget = false;
        }
    };

    for (let index = 0; index < command.length; index += 1) {
        const char = command[index] ?? "";
        if (quote !== undefined) {
            if (quote === "$'") {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === "\\") {
                    escaped = true;
                    continue;
                }
                if (char === "'") quote = undefined;
                continue;
            }

            if (quote === '"' && escaped) {
                escaped = false;
                continue;
            }

            if (quote === '"' && char === "\\") {
                escaped = true;
                continue;
            }

            if (char === quote) {
                quote = undefined;
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === "\\") {
            wordStart ??= index;
            escaped = true;
            continue;
        }

        if (quote === undefined && char === "$" && command[index + 1] === "'") {
            wordStart ??= index;
            quote = "$'";
            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            wordStart ??= index;
            quote = char;
            continue;
        }

        if (/\s/u.test(char)) {
            pushWord(index);

            if (char === "\n" || char === "\r") {
                lexemes.push({ kind: "separator", source: char, start: index, end: index + 1 });
            }
            continue;
        }

        if (["|", ";", "&", "<", ">", "(", ")"].includes(char)) {
            const redirectionMatch = /^(?:[012]?>&[012]|&>|>>|2>|1>|>|<|<<-?)/u.exec(
                command.slice(index, index + 6),
            );
            if (redirectionMatch !== null) {
                const redirText = redirectionMatch[0];
                pushWord(index);
                lexemes.push({
                    kind: "redirection",
                    source: redirText,
                    start: index,
                    end: index + redirText.length,
                });
                expectRedirectionTarget = !redirText.includes("&");
                index += redirText.length - 1;
                continue;
            }

            pushWord(index);
            lexemes.push({
                kind: "separator",
                source: char,
                start: index,
                end: index + 1,
            });
            continue;
        }

        wordStart ??= index;
    }

    pushWord(command.length);

    return lexemes;
}

function tokenizeShellWords(command: string): string[] {
    return tokenizeShellLexemes(command)
        .filter((lexeme) => lexeme.kind === "word")
        .map((lexeme) => lexeme.source);
}

function hasDynamicShellExpansion(command: string): boolean {
    let quote: "'" | '"' | "$'" | undefined;
    let escaped = false;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index] ?? "";
        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === "\\" && quote !== "'") {
            escaped = true;
            continue;
        }

        if (quote === undefined && char === "$" && command[index + 1] === "'") {
            quote = "$'";
            index += 1;
            continue;
        }

        if (char === "'" || char === '"') {
            if (quote === undefined) quote = char;
            else if (quote === char) quote = undefined;
            continue;
        }

        if (quote === "$'" && char === "'") {
            quote = undefined;
            continue;
        }

        if (quote !== "'" && quote !== "$'" && (char === "$" || char === "`")) return true;
    }

    return false;
}

function hasComposedShellSyntax(command: string): boolean {
    return (
        tokenizeShellLexemes(command).some((lexeme) => lexeme.kind === "separator") ||
        hasDynamicShellExpansion(command)
    );
}

type DirectScriptInterpreter = {
    readonly interpreter: ScriptInterpreter;
    readonly index: number;
};

const wrapperOptionsWithValues = new Set([
    "--directory",
    "--env-file",
    "--exclude-newer",
    "--extra",
    "--extra-index",
    "--find-links",
    "--group",
    "--index",
    "--only-group",
    "--package",
    "--project",
    "--python",
    "--python-platform",
    "--resolution",
    "--with",
    "--with-editable",
    "--with-requirements",
    "-C",
    "-p",
    "-u",
]);

function commandBasename(word: string): string {
    const cleanWord = unquoteCommandWord(word);
    const parts = cleanWord.replace(/\\/g, "/").split("/");
    return (parts[parts.length - 1] ?? cleanWord).toLowerCase().replace(/\.exe$/u, "");
}

function isEnvironmentAssignment(word: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(decodeShellWord(word));
}

function commandIndexAfterOptions(words: readonly string[], start: number): number | undefined {
    let index = start;
    while (index < words.length) {
        const value = decodeShellWord(words[index] ?? "");

        if (isEnvironmentAssignment(words[index] ?? "")) {
            index += 1;
            continue;
        }

        if (value === "--") return words[index + 1] === undefined ? undefined : index + 1;
        if (!value.startsWith("-") || value === "-") return index;

        if (!value.includes("=") && wrapperOptionsWithValues.has(value)) index += 2;
        else index += 1;
    }

    return undefined;
}

function directScriptInterpreterFrom(
    words: readonly string[],
    initialStart: number,
    depth: number,
): DirectScriptInterpreter | undefined {
    if (depth > 4) return undefined;

    let start = initialStart;
    while (isEnvironmentAssignment(words[start] ?? "")) start += 1;

    const executable = commandBasename(words[start] ?? "");
    const direct = scriptInterpreterForWord(words[start] ?? "");
    if (direct !== undefined) return { interpreter: direct, index: start };

    let commandIndex: number | undefined;
    if (executable === "env" || executable === "command" || executable === "exec") {
        commandIndex = commandIndexAfterOptions(words, start + 1);
    } else if (executable === "uv") {
        const runIndex = words.findIndex(
            (word, index) => index > start && decodeShellWord(word) === "run",
        );
        if (runIndex >= 0) commandIndex = commandIndexAfterOptions(words, runIndex + 1);
    } else if (executable === "uvx" || executable === "npx") {
        commandIndex = commandIndexAfterOptions(words, start + 1);
    } else if (["npm", "pnpm", "yarn"].includes(executable)) {
        const execIndex = words.findIndex(
            (word, index) => index > start && ["dlx", "exec", "x"].includes(decodeShellWord(word)),
        );
        if (execIndex >= 0) commandIndex = commandIndexAfterOptions(words, execIndex + 1);
    }

    if (commandIndex === undefined) return undefined;

    return directScriptInterpreterFrom(words, commandIndex, depth + 1);
}

function directScriptInterpreter(words: readonly string[]): DirectScriptInterpreter | undefined {
    return directScriptInterpreterFrom(words, 0, 0);
}

function inlineScriptFlagsForInterpreter(interpreter: ScriptInterpreter): ReadonlySet<string> {
    if (interpreter.language === "python") {
        return new Set(["-c"]);
    }

    if (interpreter.displayName === "Node") {
        return new Set(["-e", "--eval", "-p", "--print"]);
    }

    if (interpreter.displayName === "Deno") {
        return new Set(["eval"]);
    }

    if (interpreter.displayName === "Bun" || interpreter.displayName === "TypeScript") {
        return new Set(["-e", "--eval"]);
    }

    if (interpreter.displayName === "Ruby" || interpreter.displayName === "Perl") {
        return new Set(["-e"]);
    }

    if (interpreter.displayName === "PHP") {
        return new Set(["-r"]);
    }

    return new Set();
}

function isQuotedShellWord(word: string): boolean {
    const trimmed = word.trim();
    if (trimmed.length < 2) {
        return false;
    }

    const first = trimmed[0];
    return (first === "'" || first === '"') && trimmed.endsWith(first);
}

function isUnquotedFlagLikeScriptCode(word: string, code: string): boolean {
    return !isQuotedShellWord(word) && /^-[A-Za-z-]/u.test(code);
}

type InlineScriptCode = {
    readonly code: string;
    readonly wordIndex: number;
};

function inlineScriptCodeForInterpreter(
    interpreter: ScriptInterpreter,
    words: ReadonlyArray<string>,
    startIndex: number,
): InlineScriptCode | undefined {
    if (interpreter.displayName === "Deno") {
        const evalIndex = words.findIndex(
            (word, index) => index >= startIndex && decodeShellWord(word) === "eval",
        );
        if (evalIndex < 0) return undefined;

        let index = evalIndex + 1;
        while (index < words.length) {
            const value = decodeShellWord(words[index] ?? "");
            if (value === "--ext") {
                index += 2;
                continue;
            }

            if (value.startsWith("-") && !isQuotedShellWord(words[index] ?? "")) {
                index += 1;
                continue;
            }

            return { code: value, wordIndex: index };
        }

        return undefined;
    }

    const flags = inlineScriptFlagsForInterpreter(interpreter);
    if (flags.size === 0) {
        return undefined;
    }

    for (let index = startIndex; index < words.length; index += 1) {
        const rawWord = words[index] ?? "";
        const value = decodeShellWord(rawWord);
        for (const flag of flags) {
            if (value === flag) {
                const codeWord = words[index + 1];
                if (codeWord === undefined) {
                    return undefined;
                }

                const code = decodeShellWord(codeWord);
                return isUnquotedFlagLikeScriptCode(codeWord, code)
                    ? undefined
                    : { code, wordIndex: index + 1 };
            }

            const assignmentPrefix = `${flag}=`;
            if (value.startsWith(assignmentPrefix)) {
                const code = value.slice(assignmentPrefix.length);
                return /^-[A-Za-z-]/u.test(code) ? undefined : { code, wordIndex: index };
            }

            if (rawWord.startsWith(flag) && rawWord.length > flag.length) {
                const rest = rawWord.slice(flag.length);
                if (
                    rest.startsWith("'") ||
                    rest.startsWith('"') ||
                    rest.startsWith("='") ||
                    rest.startsWith('="') ||
                    rest.startsWith("$'")
                ) {
                    const payload = rest.startsWith("=") ? rest.slice(1) : rest;
                    const code = decodeShellWord(payload);
                    return /^-[A-Za-z-]/u.test(code) ? undefined : { code, wordIndex: index };
                }
            }
        }
    }

    return undefined;
}

function parseInlineScriptInvocation(displayCommand: string): ScriptInvocation | undefined {
    if (hasComposedShellSyntax(displayCommand)) return undefined;

    const words = tokenizeShellWords(displayCommand);
    const direct = directScriptInterpreter(words);
    if (direct === undefined) return undefined;

    const inlineScript = inlineScriptCodeForInterpreter(
        direct.interpreter,
        words,
        direct.index + 1,
    );
    return inlineScript === undefined
        ? undefined
        : buildScriptInvocationForInterpreter(direct.interpreter, inlineScript.code);
}

type EmbeddedInlineScript = {
    readonly start: number;
    readonly end: number;
    readonly language: string;
};

export function embeddedInlineScripts(command: string): EmbeddedInlineScript[] {
    if (heredocOpenPattern.test(command)) return [];

    const lexemes = tokenizeShellLexemes(command);
    const scripts: EmbeddedInlineScript[] = [];
    let segment: ShellLexeme[] = [];

    const collectSegment = (): void => {
        const words = segment.filter((lexeme) => lexeme.kind === "word");
        const direct = directScriptInterpreter(words.map((word) => word.source));
        if (direct === undefined) {
            segment = [];
            return;
        }

        const inlineScript = inlineScriptCodeForInterpreter(
            direct.interpreter,
            words.map((word) => word.source),
            direct.index + 1,
        );
        const codeWord = inlineScript === undefined ? undefined : words[inlineScript.wordIndex];
        if (
            codeWord?.source.startsWith("'") === true &&
            codeWord.source.endsWith("'") &&
            codeWord.source.length >= 2
        ) {
            scripts.push({
                start: codeWord.start + 1,
                end: codeWord.end - 1,
                language: direct.interpreter.language,
            });
        }

        segment = [];
    };

    for (const lexeme of lexemes) {
        if (lexeme.kind === "separator") collectSegment();
        else segment.push(lexeme);
    }

    collectSegment();

    return scripts;
}

export function detectHeredocInterpreter(prefix: string): ScriptInterpreter | undefined {
    const words = tokenizeShellWords(prefix);
    for (let index = words.length - 1; index >= 0; index -= 1) {
        const word = words[index];
        if (word === undefined) {
            continue;
        }

        const interpreter = scriptInterpreterForWord(word);
        if (interpreter && interpreter.language !== "bash") {
            return interpreter;
        }
    }

    return undefined;
}

export function parseScriptInvocation(command: string | undefined): ScriptInvocation | undefined {
    const displayCommand = stripShellWrapper(command);
    return (
        parseHeredocScriptInvocation(displayCommand) ?? parseInlineScriptInvocation(displayCommand)
    );
}
