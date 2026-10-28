import { Buffer } from "node:buffer";
import {
    parse,
    type Command,
    type Node,
    type ParsedScript,
    type Redirect,
    type Word,
    type WordPart,
} from "unbash";

export type EmbeddedProgram = {
    readonly language: string;
    readonly origin: "inline" | "heredoc" | "file-heredoc";
    readonly start: number;
    readonly end: number;
    readonly code: string;
    readonly quoted: boolean;
    readonly expandable: boolean;
    readonly localStart: number;
    readonly localEnd: number;
    readonly parent?: EmbeddedProgram;
    readonly delimiter?: string;
    readonly stripTabs?: boolean;
    readonly incomplete?: true;
    readonly splitString?: true;
    readonly characters?: readonly SourceSpan[];
    readonly localCharacters?: readonly SourceSpan[];
    readonly standalone?: { readonly label: string; readonly launcher: string };
};

function staticPart(part: WordPart): boolean {
    if (part.type === "SingleQuoted") return true;

    if (part.type === "AnsiCQuoted") {
        for (let index = 2; index < part.text.length - 1; index++) {
            if (part.text[index] !== "\\") continue;

            const escape = /^\\(?:x([\da-fA-F]{1,2})|([0-7]{1,3})|[\s\S])/u.exec(
                part.text.slice(index),
            );
            if (escape === null) return false;
            if (escape[1] !== undefined && Number.parseInt(escape[1], 16) >= 128) return false;
            if (escape[2] !== undefined && Number.parseInt(escape[2], 8) >= 128) return false;

            index += escape[0].length - 1;
        }

        return true;
    }

    if (part.type === "Literal") {
        for (let index = 0; index < part.text.length; index++) {
            if (part.text[index] === "\\") index++;
            else if (["*", "?", "["].includes(part.text[index] ?? "")) return false;
        }

        return true;
    }

    if (part.type === "DoubleQuoted") return part.parts.every((child) => child.type === "Literal");
    return false;
}

function staticWord(word: Word | undefined): string | undefined {
    if (
        word === undefined ||
        word.value.includes("\0") ||
        Buffer.from(word.value, "utf8").toString("utf8") !== word.value ||
        (word.parts !== undefined && !word.parts.every(staticPart))
    )
        return undefined;

    if (word.text.startsWith("~")) return undefined;
    if (
        word.parts === undefined &&
        !staticPart({ type: "Literal", text: word.text, value: word.value })
    )
        return undefined;

    return word.value;
}

function basename(word: Word | undefined): string | undefined {
    const value = staticWord(word);
    return value
        ?.split("/")
        .at(-1)
        ?.toLowerCase()
        .replace(/\.exe$/u, "");
}

function label(name: string | undefined, kind: string): string {
    if (kind === "python") return "Python";
    if (name === "node" || name === "nodejs") return "Node";
    if (name === "deno") return "Deno";
    if (name === "bun") return "Bun";
    if (kind === "typescript") return "TypeScript";
    if (kind === "ruby") return "Ruby";
    if (kind === "perl") return "Perl";
    if (kind === "php") return "PHP";
    return "Shell";
}

function language(name: string | undefined): string | undefined {
    if (name === "py" || /^(?:python|pypy)(?:\d+(?:\.\d+)?)?$/u.test(name ?? "")) return "python";
    if (name === "node" || name === "nodejs") return "javascript";
    if (["bun", "deno", "tsx", "ts-node"].includes(name ?? "")) return "typescript";
    if (["bash", "sh", "zsh"].includes(name ?? "")) return "bash";
    if (["awk", "gawk", "mawk", "nawk"].includes(name ?? "")) return "awk";
    if (["jq", "sed", "perl", "ruby", "php"].includes(name ?? "")) return name;
    return undefined;
}

const valueOptions = new Map<string, ReadonlySet<string>>([
    ["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"])],
    [
        "sudo",
        new Set([
            "-u",
            "--user",
            "-g",
            "--group",
            "-h",
            "--host",
            "-p",
            "--prompt",
            "-C",
            "--close-from",
            "-D",
            "--chdir",
            "-R",
            "--chroot",
            "-T",
            "--command-timeout",
            "-r",
            "--role",
            "-t",
            "--type",
        ]),
    ],
    ["doas", new Set(["-u", "-C"])],
    ["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
    [
        "xvfb-run",
        new Set([
            "-n",
            "--server-num",
            "-s",
            "--server-args",
            "-f",
            "--auth-file",
            "-e",
            "--error-file",
        ]),
    ],
    [
        "uv",
        new Set([
            "-C",
            "--directory",
            "--project",
            "--python",
            "-p",
            "--with",
            "--with-editable",
            "--with-requirements",
            "--env-file",
            "--package",
            "--extra",
            "--group",
            "--index",
            "--extra-index",
            "--find-links",
        ]),
    ],
    ["npx", new Set(["-p", "--package", "--workspace", "-w", "--cache", "--registry"])],
    ["bunx", new Set(["--package", "-p"])],
    [
        "uvx",
        new Set(["--from", "--python", "-p", "--with", "--with-editable", "--with-requirements"]),
    ],
    [
        "ssh",
        new Set([
            "-p",
            "-o",
            "-i",
            "-l",
            "-F",
            "-J",
            "-b",
            "-c",
            "-D",
            "-E",
            "-L",
            "-m",
            "-O",
            "-Q",
            "-R",
            "-W",
            "-w",
        ]),
    ],
]);

const flagOptions = new Map<string, ReadonlySet<string>>([
    ["env", new Set(["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"])],
    [
        "sudo",
        new Set([
            "-n",
            "--non-interactive",
            "-E",
            "--preserve-env",
            "-H",
            "--set-home",
            "-S",
            "--stdin",
            "-b",
            "--background",
        ]),
    ],
    ["doas", new Set(["-n", "-s"])],
    ["timeout", new Set(["--foreground", "--preserve-status", "-v", "--verbose"])],
    ["xvfb-run", new Set(["-a", "--auto-servernum", "-l", "--listen-tcp"])],
    ["npx", new Set(["-y", "--yes", "--no", "--offline", "--prefer-offline"])],
    ["bunx", new Set(["-y", "--yes", "--bun"])],
    [
        "uv",
        new Set([
            "-q",
            "--quiet",
            "-v",
            "--verbose",
            "--offline",
            "--no-project",
            "--no-config",
            "--isolated",
        ]),
    ],
    ["uvx", new Set(["-q", "--quiet", "-v", "--verbose", "--offline", "--no-config"])],
    ["command", new Set(["-p"])],
    ["exec", new Set(["-c", "-l"])],
    [
        "ssh",
        new Set([
            "-4",
            "-6",
            "-A",
            "-a",
            "-C",
            "-f",
            "-G",
            "-g",
            "-K",
            "-k",
            "-M",
            "-N",
            "-n",
            "-q",
            "-s",
            "-T",
            "-t",
            "-V",
            "-v",
            "-X",
            "-x",
            "-Y",
            "-y",
        ]),
    ],
]);

function afterOptions(words: readonly Word[], start: number, command: string): number {
    let index = start;
    while (index < words.length) {
        const value = staticWord(words[index]);
        if (value === undefined) return words.length;
        if (value === "--") return index + 1;
        if (!value.startsWith("-") || value === "-") return index;

        if (
            command === "env" &&
            (value === "-S" || value === "--split-string" || value.startsWith("--split-string="))
        )
            return words.length;

        const options = valueOptions.get(command);
        if (options?.has(value) === true) index += 2;
        else if (flagOptions.get(command)?.has(value) === true) index++;
        else if (
            options !== undefined &&
            [...options].some((option) => option.startsWith("--") && value.startsWith(`${option}=`))
        )
            index++;
        else return words.length;
    }

    return index;
}

function commandIndex(words: readonly Word[]): number {
    let index = 0;
    while (index < words.length) {
        const name = basename(words[index]);
        if (
            [
                "env",
                "command",
                "exec",
                "nohup",
                "sudo",
                "doas",
                "xvfb-run",
                "npx",
                "bunx",
                "uvx",
            ].includes(name ?? "")
        ) {
            index = afterOptions(words, index + 1, name ?? "");
            while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(staticWord(words[index]) ?? "")) index++;
            continue;
        }

        if (name === "timeout") {
            index = afterOptions(words, index + 1, name) + 1;
            continue;
        }

        if (name === "uv") {
            index = afterOptions(words, index + 1, name);
            if (staticWord(words[index]) !== "run") return words.length;

            index = afterOptions(words, index + 1, name);
            continue;
        }

        if (name !== undefined && ["npm", "pnpm", "yarn"].includes(name)) {
            index = afterOptions(words, index + 1, name);
            if (!["exec", "dlx", "x"].includes(staticWord(words[index]) ?? "")) return words.length;

            index = afterOptions(words, index + 1, name);
            continue;
        }

        return index;
    }

    return index;
}

function inlineIndex(
    words: readonly Word[],
    index: number,
    kind: string,
): { index: number; offset: number } | undefined {
    const flags = new Set<string>();
    if (kind === "python" || kind === "bash") flags.add("-c");

    if (["javascript", "typescript", "perl", "ruby"].includes(kind)) {
        flags.add("-e");
        flags.add("--eval");
    }

    if (kind === "php") flags.add("-r");
    if (basename(words[index]) === "deno") flags.add("eval");

    if (kind === "javascript") {
        flags.add("-p");
        flags.add("--print");
    }

    const optionsWithValues = new Set([
        "-W",
        "-X",
        "--input-type",
        "--import",
        "--loader",
        "--require",
        "-r",
        "-o",
        "-O",
        "--rcfile",
        "--init-file",
        "--ext",
    ]);
    for (let i = index + 1; i < words.length; i++) {
        const value = staticWord(words[i]);
        if (value === undefined) return undefined;
        if (flags.has(value) || (kind === "bash" && /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(value)))
            return { index: i + 1, offset: 0 };

        const raw = words[i]?.text ?? "";
        let attached: string | undefined;
        if (kind === "python") attached = /^-[bBdEhiIOPqRsStuvV]*c/u.exec(raw)?.[0];
        if (kind === "ruby" || kind === "perl") attached = /^-[npw]*e/u.exec(raw)?.[0];

        if (kind === "javascript" || kind === "typescript") {
            attached = /^(?:-e|--eval=)/u.exec(raw)?.[0];
            if (kind === "javascript") attached ??= /^(?:-p|--print=)/u.exec(raw)?.[0];
        }

        if (attached !== undefined) {
            if (raw.length === attached.length) return { index: i + 1, offset: 0 };

            return { index: i, offset: attached.length };
        }

        if (value === "--" || !value.startsWith("-") || value === "-") return undefined;
        if (optionsWithValues.has(value)) i++;
    }

    return undefined;
}

function filterIndex(words: readonly Word[], index: number, kind: string): number | undefined {
    let one = new Set(["--indent", "-L", "--library-path"]);
    if (kind === "awk")
        one = new Set([
            "-F",
            "-v",
            "-W",
            "-i",
            "-l",
            "--field-separator",
            "--assign",
            "--include",
            "--load",
        ]);

    const two = new Set(["--arg", "--argjson", "--slurpfile", "--rawfile"]);
    let explicit: number | undefined;
    for (let i = index + 1; i < words.length; i++) {
        const value = staticWord(words[i]);
        if (value === undefined) return undefined;
        if (value === "--") return explicit ?? i + 1;

        if (
            (kind === "awk" && ["-e", "--source"].includes(value)) ||
            (kind === "sed" && ["-e", "--expression"].includes(value))
        ) {
            if (explicit !== undefined || words[i + 1] === undefined) return undefined;

            explicit = i + 1;
            i++;
            continue;
        }

        if (
            value === "-f" ||
            value.startsWith("--file=") ||
            value === "--file" ||
            value === "--from-file" ||
            /^-f./u.test(value) ||
            (kind === "jq" && /^-[a-zA-Z]*f[a-zA-Z]*$/u.test(value))
        )
            return undefined;

        if (one.has(value)) {
            i++;
            continue;
        }

        if (kind === "jq" && two.has(value)) {
            i += 2;
            continue;
        }

        if (value.startsWith("-") && value !== "-") {
            if (
                kind === "sed" &&
                ![
                    "-n",
                    "--quiet",
                    "--silent",
                    "-E",
                    "-r",
                    "--regexp-extended",
                    "-s",
                    "--separate",
                    "-u",
                    "--unbuffered",
                    "-z",
                    "--null-data",
                ].includes(value)
            )
                return undefined;
            continue;
        }

        return explicit ?? i;
    }

    return explicit;
}

function stdinSource(words: readonly Word[], index: number, kind: string | undefined): boolean {
    if (kind !== "python" && kind !== "javascript" && kind !== "bash") return false;

    const withValues = new Set([
        "-W",
        "-X",
        "--input-type",
        "--import",
        "--loader",
        "--require",
        "-r",
        "-o",
        "-O",
    ]);
    for (let i = index + 1; i < words.length; i++) {
        const value = staticWord(words[i]);
        if (value === undefined) return false;
        if (value === "-") return true;
        if (value === "--") return words[i + 1] === undefined || staticWord(words[i + 1]) === "-";

        if (
            value === "-c" ||
            value === "-e" ||
            value === "--eval" ||
            value === "-m" ||
            (kind === "python" && /^-[bBdEhiIOPqRsStuvV]*c/u.test(value)) ||
            (kind === "javascript" && /^(?:-e|-p|--eval=|--print=)/u.test(value)) ||
            (kind === "javascript" && (value === "-p" || value === "--print")) ||
            (kind === "bash" && /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(value)) ||
            !value.startsWith("-")
        )
            return false;

        if (withValues.has(value)) i++;
    }

    return true;
}

function affectsStdout(redirect: Redirect): boolean {
    if (redirect.operator === "&>" || redirect.operator === "&>>") return true;
    if (redirect.fileDescriptor !== undefined) return redirect.fileDescriptor === 1;
    return [">", ">>", ">|", ">&"].includes(redirect.operator);
}

function outputLanguage(redirects: readonly Redirect[]): string | undefined {
    const output = redirects.filter(affectsStdout).at(-1);
    if (output === undefined || ![">", ">>", ">|", "&>", "&>>"].includes(output.operator))
        return undefined;

    const path = output.target;
    if (path === undefined) return undefined;

    const text = path.text.replace(/["']/gu, "");
    if (/\.(?:py|pyw)$/iu.test(text)) return "python";
    if (/\.(?:js|mjs|cjs|jsx)$/iu.test(text)) return "javascript";
    if (/\.(?:ts|mts|cts)$/iu.test(text)) return "typescript";
    if (/\.tsx$/iu.test(text)) return "tsx";
    if (/\.(?:sh|bash)$/iu.test(text)) return "bash";
    return undefined;
}

export type SourceSpan = { from: number; to: number; start: number; end: number };
type SourceCharacter = { readonly start: number; readonly end: number };

function appendMapping(spans: SourceSpan[], range: SourceCharacter, length: number): void {
    if (length === 0) return;

    const previous = spans.at(-1);
    const from = previous?.to ?? 0;
    if (
        previous !== undefined &&
        previous.end === range.start &&
        previous.end - previous.start === previous.to - previous.from &&
        range.end - range.start === length
    ) {
        previous.to += length;
        previous.end = range.end;
    } else spans.push({ from, to: from + length, start: range.start, end: range.end });
}

export function sourceCharacterAt(
    spans: readonly SourceSpan[],
    index: number,
): SourceCharacter | undefined {
    let low = 0;
    let high = spans.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const span = spans[middle];
        if (span === undefined) return undefined;

        if (index < span.from) high = middle;
        else if (index >= span.to) low = middle + 1;
        else if (span.end - span.start === span.to - span.from)
            return {
                start: span.start + index - span.from,
                end: span.start + index - span.from + 1,
            };
        else return { start: span.start, end: span.end };
    }

    return undefined;
}

function mappedWord(
    word: Word,
    mapping: readonly SourceSpan[] | undefined,
): SourceSpan[] | undefined {
    const result: SourceSpan[] = [];
    let decoded = "";
    let position = word.pos;
    const parts = word.parts ?? [{ type: "Literal" as const, text: word.text, value: word.value }];

    for (const part of parts) {
        if (!["SingleQuoted", "DoubleQuoted", "Literal", "AnsiCQuoted"].includes(part.type))
            return undefined;

        let start = 0;
        let end = part.text.length;
        if (part.type === "SingleQuoted" || part.type === "DoubleQuoted") {
            start = 1;
            end--;
        }

        if (part.type === "AnsiCQuoted") {
            start = 2;
            end--;
        }

        const plain = part.text.slice(start, end);
        if (mapping === undefined && (part.type === "SingleQuoted" || !plain.includes("\\"))) {
            decoded += plain;
            appendMapping(result, { start: position + start, end: position + end }, plain.length);
            position += part.text.length;
            continue;
        }

        for (let i = start; i < end; i++) {
            const characterStart = i;
            let value = part.text[i] ?? "";
            if (value === "\\" && i + 1 < end && part.type !== "SingleQuoted") {
                const next = part.text[i + 1] ?? "";
                if (part.type === "AnsiCQuoted") {
                    const escape =
                        /^\\(?:[0-7]{1,3}|x[\da-fA-F]{0,2}|u[\da-fA-F]{0,4}|U[\da-fA-F]{0,8}|c[\s\S]|[\s\S])/u.exec(
                            part.text.slice(i, end),
                        )?.[0];
                    if (escape === undefined) return undefined;

                    const parsed = parse(`: $'${escape}'`).commands[0]?.command;
                    if (parsed?.type !== "Command" || parsed.suffix[0] === undefined)
                        return undefined;

                    value = parsed.suffix[0].value;
                    i += escape.length - 1;
                } else if (part.type === "Literal" || ['"', "\\", "$", "`", "\n"].includes(next)) {
                    i++;
                    value = next;
                    if (next === "\n") value = "";
                }
            }

            const range = mappedRange(position + characterStart, position + i + 1, mapping);
            if (range === undefined) return undefined;

            decoded += value;
            appendMapping(result, range, value.length);
        }

        position += part.text.length;
    }

    if (decoded === word.value) return result;
    return undefined;
}

function mappedWords(
    words: readonly Word[],
    mapping: readonly SourceSpan[] | undefined,
): SourceSpan[] | undefined {
    const result: SourceSpan[] = [];
    for (const [index, word] of words.entries()) {
        if (index > 0) {
            const previous = words[index - 1];
            let gap;
            if (previous !== undefined) gap = mappedRange(previous.end, word.pos, mapping);
            if (gap === undefined) return undefined;

            appendMapping(result, gap, 1);
        }

        const spans = mappedWord(word, mapping);
        if (spans === undefined) return undefined;

        for (const span of spans) appendMapping(result, span, span.to - span.from);
    }

    return result;
}

function mappedRange(
    start: number,
    end: number,
    mapping: readonly SourceSpan[] | undefined,
): { start: number; end: number } | undefined {
    if (mapping === undefined) return { start, end };

    const first = sourceCharacterAt(mapping, start);
    const last = sourceCharacterAt(mapping, end - 1);
    if (first === undefined || last === undefined) return undefined;

    return { start: first.start, end: last.end };
}

export function bashCompoundRanges(
    source: string,
    complete: boolean,
    syntax?: ParsedScript,
): Array<{ start: number; end: number; settled: boolean }> {
    const script = syntax ?? parse(source);
    const ranges: Array<{ start: number; end: number; settled: boolean }> = [];
    for (const [index, statement] of script.commands.entries()) {
        const pending: Node[] = [statement.command];
        let compound = false;
        while (pending.length > 0) {
            const node = pending.pop();
            if (node === undefined) break;

            if (
                [
                    "If",
                    "For",
                    "ArithmeticFor",
                    "Select",
                    "While",
                    "Case",
                    "Function",
                    "Subshell",
                    "BraceGroup",
                    "Coproc",
                ].includes(node.type)
            ) {
                compound = true;
                break;
            }

            if (node.type === "Pipeline" || node.type === "AndOr") pending.push(...node.commands);
        }

        if (!compound) continue;

        let end = statement.end;
        if (end <= statement.pos) end = source.length;

        const malformed = (script.errors ?? []).some(
            (error) =>
                error.pos >= statement.pos &&
                (error.pos <= end || index === script.commands.length - 1),
        );
        if (malformed && index === script.commands.length - 1) end = source.length;

        const settled =
            statement.end > statement.pos &&
            !malformed &&
            (complete || statement.end < source.length);
        ranges.push({ start: statement.pos, end, settled });
    }

    return ranges;
}

export function extractEmbeddedPrograms(input: string, syntax?: ParsedScript): EmbeddedProgram[] {
    const programs: EmbeddedProgram[] = [];
    const pending: {
        source: string;
        syntax?: ParsedScript;
        mapping?: readonly SourceSpan[];
        localMapping?: readonly SourceSpan[];
        splitString?: true;
        parent?: EmbeddedProgram;
    }[] = [{ source: input, ...(syntax !== undefined && { syntax }) }];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined) break;

        const { source, mapping, localMapping, parent, splitString } = current;
        const script = current.syntax ?? parse(source);
        let errorStart = Infinity;

        for (const error of script.errors ?? []) errorStart = Math.min(errorStart, error.pos);

        const heredocs: {
            redirect: Redirect;
            kind: string | undefined;
            origin: "heredoc" | "file-heredoc";
            standaloneLabel?: string;
        }[] = [];
        let root: Node | undefined;
        if (parent === undefined && errorStart === Infinity && script.commands.length === 1)
            root = script.commands[0]?.command;

        let standaloneCommand: Command | undefined;
        if (root?.type === "Command") standaloneCommand = root;
        if (
            root?.type === "Pipeline" &&
            root.commands.length === 2 &&
            root.commands[0]?.type === "Command"
        )
            standaloneCommand = root.commands[0];

        const stack: Node[] = script.commands
            .filter((statement) => statement.end < errorStart)
            .reverse();
        const pipedSources = new Map<Command, { language: string; label: string }>();
        while (stack.length > 0) {
            const node = stack.pop();
            if (node === undefined) break;

            switch (node.type) {
                case "Statement":
                    stack.push(node.command);
                    break;
                case "Pipeline":
                    for (let i = 0; i + 1 < node.commands.length; i++) {
                        const left = node.commands[i];
                        const right = node.commands[i + 1];
                        if (left?.type !== "Command" || right?.type !== "Command") continue;

                        if (
                            basename(left.name) !== "cat" ||
                            !left.suffix.every((word) =>
                                ["-", "--"].includes(staticWord(word) ?? ""),
                            )
                        )
                            continue;

                        if (left.redirects.some(affectsStdout)) continue;

                        if (
                            right.redirects.some(
                                (redirect) =>
                                    (redirect.fileDescriptor === undefined ||
                                        redirect.fileDescriptor === 0) &&
                                    ["<", "<<", "<<-", "<<<", "<&", "<>"].includes(
                                        redirect.operator,
                                    ),
                            )
                        )
                            continue;

                        let words = right.suffix;
                        if (right.name !== undefined) words = [right.name, ...right.suffix];

                        const index = commandIndex(words);
                        const kind = language(basename(words[index]));
                        if (kind !== undefined && stdinSource(words, index, kind))
                            pipedSources.set(left, {
                                language: kind,
                                label: label(basename(words[index]), kind),
                            });
                    }

                    stack.push(...[...node.commands].reverse());
                    break;
                case "AndOr":
                case "CompoundList":
                    stack.push(...[...node.commands].reverse());
                    break;
                case "If":
                    if (node.else !== undefined) stack.push(node.else);
                    stack.push(node.then, node.clause);
                    break;
                case "While":
                    stack.push(node.body, node.clause);
                    break;
                case "For":
                case "ArithmeticFor":
                case "Select":
                case "Subshell":
                case "BraceGroup":
                case "Function":
                case "Coproc":
                    stack.push(node.body);
                    break;
                case "Case":
                    for (const item of [...node.items].reverse()) stack.push(item.body);
                    break;
                case "Command": {
                    let words = node.suffix;
                    if (node.name !== undefined) words = [node.name, ...node.suffix];

                    const wordParts: WordPart[] = [
                        ...node.prefix.flatMap((prefix) => prefix.value?.parts ?? []),
                        ...words.flatMap((word) => word.parts ?? []),
                    ];
                    while (wordParts.length > 0) {
                        const part = wordParts.pop();
                        if (part === undefined) break;

                        if (
                            (part.type === "CommandExpansion" ||
                                part.type === "ProcessSubstitution") &&
                            part.script !== undefined &&
                            part.script.source === undefined
                        )
                            stack.push(...part.script.commands);

                        if (part.type === "DoubleQuoted" || part.type === "LocaleString")
                            wordParts.push(...part.parts);
                    }

                    if (basename(words[0]) === "env") {
                        let splitIndex = 1;
                        while (
                            flagOptions.get("env")?.has(staticWord(words[splitIndex]) ?? "") ===
                            true
                        )
                            splitIndex++;

                        const option = staticWord(words[splitIndex]);
                        const splitWord = words[splitIndex + 1];
                        const split = staticWord(splitWord);
                        if (
                            (option === "-S" || option === "--split-string") &&
                            splitWord !== undefined &&
                            split !== undefined &&
                            !/[\u0024\\`#;|&<>\r\n]/u.test(split)
                        ) {
                            const parsed = parse(split);
                            const absolute = mappedWord(splitWord, mapping);
                            const local = mappedWord(splitWord, localMapping);
                            if (
                                (parsed.errors?.length ?? 0) === 0 &&
                                parsed.commands.length === 1 &&
                                parsed.commands[0]?.command.type === "Command" &&
                                absolute !== undefined &&
                                local !== undefined
                            )
                                pending.push({
                                    source: split,
                                    syntax: parsed,
                                    mapping: absolute,
                                    localMapping: local,
                                    splitString: true,
                                    ...(parent !== undefined && { parent }),
                                });
                        }
                    }

                    const index = commandIndex(words);
                    const name = basename(words[index]);
                    let kind = language(name);
                    let programIndex: number | undefined;
                    let offset = 0;
                    let remoteWords: readonly Word[] | undefined;

                    if (kind === "awk" || kind === "jq" || kind === "sed")
                        programIndex = filterIndex(words, index, kind);
                    else if (kind !== undefined) {
                        const selection = inlineIndex(words, index, kind);
                        programIndex = selection?.index;
                        offset = selection?.offset ?? 0;
                    } else if (name === "ssh") {
                        const host = afterOptions(words, index + 1, name);
                        programIndex = host + 1;
                        remoteWords = words.slice(programIndex);
                        kind = "bash";
                    }

                    let word;
                    if (programIndex !== undefined) word = words[programIndex];

                    if (word !== undefined && offset > 0) {
                        const payload = word.text.slice(offset);
                        const parsed = parse(`: ${payload}`).commands[0]?.command;
                        let value;
                        if (parsed?.type === "Command") value = parsed.suffix[0];

                        if (value === undefined || value.end !== payload.length + 2)
                            word = undefined;
                        else
                            word = {
                                text: payload,
                                value: value.value,
                                ...(value.parts !== undefined && { parts: value.parts }),
                                pos: word.pos + offset,
                                end: word.end,
                            };
                    }

                    let remoteCode: string | undefined;
                    let remoteMapping: SourceSpan[] | undefined;
                    let remoteLocalMapping: SourceSpan[] | undefined;
                    if (word !== undefined && remoteWords !== undefined && remoteWords.length > 1) {
                        const values = remoteWords.map(staticWord);
                        const last = remoteWords.at(-1);
                        if (last === undefined || values.some((value) => value === undefined))
                            word = undefined;
                        else {
                            remoteCode = values.join(" ");
                            remoteMapping = mappedWords(remoteWords, mapping);
                            remoteLocalMapping = mappedWords(remoteWords, undefined);
                            word = {
                                text: source.slice(word.pos, last.end),
                                value: remoteCode,
                                pos: word.pos,
                                end: last.end,
                            };
                        }
                    }

                    const code = remoteCode ?? staticWord(word);
                    if (word !== undefined && code !== undefined && kind !== undefined) {
                        const range = mappedRange(word.pos, word.end, mapping);
                        let characters;
                        if (remoteWords !== undefined && remoteWords.length > 1)
                            characters = remoteMapping;
                        else characters = mappedWord(word, mapping);

                        let localCharacters = characters;

                        if (localMapping !== undefined)
                            localCharacters = mappedWord(word, localMapping);
                        else if (parent !== undefined) {
                            if (remoteWords !== undefined && remoteWords.length > 1)
                                localCharacters = remoteLocalMapping;
                            else localCharacters = mappedWord(word, undefined);
                        }

                        let standalone: EmbeddedProgram["standalone"];
                        if (
                            splitString !== true &&
                            node === standaloneCommand &&
                            root?.type === "Command" &&
                            !["bash", "awk", "jq", "sed"].includes(kind) &&
                            !node.redirects.some(
                                (redirect) =>
                                    redirect.operator === "<<" || redirect.operator === "<<-",
                            )
                        ) {
                            let launcher = source.slice(0, word.pos);
                            const trailing = source.slice(word.end).trim();
                            if (trailing.length > 0)
                                launcher = `${launcher.trimEnd()} … ${trailing}`;

                            standalone = {
                                label: label(name, kind),
                                launcher: launcher.replace(/\\\r?\n\s*/gu, " ").trim(),
                            };
                        }

                        let program: EmbeddedProgram | undefined;
                        const localRange = mappedRange(word.pos, word.end, localMapping);
                        if (range !== undefined && localRange !== undefined) {
                            program = {
                                language: kind,
                                origin: "inline",
                                ...range,
                                localStart: localRange.start,
                                localEnd: localRange.end,
                                ...(parent !== undefined && { parent }),
                                ...(splitString === true && { splitString: true }),
                                code,
                                quoted: word.text.startsWith("'") || word.text.startsWith('"'),
                                expandable: false,
                                ...(characters !== undefined && { characters }),
                                ...(localCharacters !== undefined && { localCharacters }),
                                ...(standalone !== undefined && { standalone }),
                            };
                            programs.push(program);
                        }

                        if (kind === "bash") {
                            let childMapping = characters;
                            if (
                                childMapping === undefined &&
                                word.text.length >= 2 &&
                                word.text.slice(1, -1) === code &&
                                (word.text.startsWith("'") || word.text.startsWith('"'))
                            ) {
                                childMapping = [];
                                for (let i = 0; i < code.length; i++) {
                                    const childRange = mappedRange(
                                        word.pos + 1 + i,
                                        word.pos + 2 + i,
                                        mapping,
                                    );
                                    if (childRange !== undefined)
                                        appendMapping(childMapping, childRange, 1);
                                }
                            }

                            if (
                                program !== undefined &&
                                childMapping !== undefined &&
                                (childMapping.at(-1)?.to ?? 0) === code.length
                            )
                                pending.push({
                                    source: code,
                                    mapping: childMapping,
                                    ...(splitString === true && { splitString: true }),
                                    parent: program,
                                });
                        }
                    }

                    let hereKind: string | undefined;
                    let standaloneLabel: string | undefined;
                    let origin: "heredoc" | "file-heredoc" = "heredoc";
                    if (stdinSource(words, index, kind)) {
                        hereKind = kind;

                        if (
                            kind !== undefined &&
                            kind !== "bash" &&
                            node === standaloneCommand &&
                            root?.type === "Command"
                        )
                            standaloneLabel = label(name, kind);
                    } else if (
                        name === "cat" &&
                        words
                            .slice(index + 1)
                            .every((word) => ["-", "--"].includes(staticWord(word) ?? ""))
                    ) {
                        const pipe = pipedSources.get(node);
                        hereKind = pipe?.language;

                        if (
                            pipe !== undefined &&
                            node === standaloneCommand &&
                            root?.type === "Pipeline"
                        )
                            standaloneLabel = pipe.label;

                        if (hereKind === undefined) {
                            hereKind = outputLanguage(node.redirects);
                            origin = "file-heredoc";
                        }
                    }

                    const finalInput = node.redirects
                        .filter(
                            (redirect) =>
                                (redirect.fileDescriptor === undefined ||
                                    redirect.fileDescriptor === 0) &&
                                ["<", "<<", "<<-", "<<<", "<&", "<>"].includes(redirect.operator),
                        )
                        .at(-1);
                    for (const redirect of node.redirects) {
                        if (redirect.operator !== "<<" && redirect.operator !== "<<-") continue;

                        let redirectKind = hereKind;
                        if (redirect !== finalInput) redirectKind = undefined;

                        heredocs.push({
                            redirect,
                            kind: redirectKind,
                            origin,
                            ...(redirect === finalInput &&
                                standaloneLabel !== undefined && { standaloneLabel }),
                        });
                    }
                    break;
                }
                case "TestCommand":
                case "ArithmeticCommand":
                    break;
            }
        }

        const ends = new Map<number, number>();
        for (const { redirect, kind, origin, standaloneLabel } of heredocs.sort(
            (a, b) => a.redirect.pos - b.redirect.pos,
        )) {
            const headerEnd = source.indexOf("\n", redirect.end);
            const marker = redirect.target?.value;
            if (headerEnd < 0 || marker === undefined) continue;

            const start = ends.get(headerEnd) ?? headerEnd + 1;
            let lineStart = start;
            let incomplete = false;
            while (lineStart <= source.length) {
                let lineEnd = source.indexOf("\n", lineStart);
                if (lineEnd < 0) lineEnd = source.length;

                let line = source.slice(lineStart, lineEnd);
                if (redirect.operator === "<<-") line = line.replace(/^\t+/u, "");

                const terminated = lineStart < source.length && line === marker;
                if (terminated || lineEnd === source.length) {
                    let bodyEnd = lineStart;

                    if (!terminated) {
                        bodyEnd = source.length;
                        incomplete = true;
                    }

                    ends.set(headerEnd, Math.min(source.length, lineEnd + 1));

                    if (kind !== undefined) {
                        const raw = source.slice(start, bodyEnd);
                        let code = "";
                        const range = mappedRange(start, bodyEnd, mapping);
                        const characters: SourceSpan[] = [];
                        const localCharacters: SourceSpan[] = [];
                        if (
                            mapping === undefined &&
                            (redirect.operator !== "<<-" || !raw.includes("\t")) &&
                            (redirect.heredocQuoted === true || !raw.includes("\\"))
                        ) {
                            code = raw;
                            appendMapping(characters, { start, end: bodyEnd }, raw.length);
                            appendMapping(localCharacters, { start, end: bodyEnd }, raw.length);
                        } else {
                            let lineBeginning = true;
                            for (let i = 0; i < raw.length; i++) {
                                let character = raw[i] ?? "";
                                if (
                                    redirect.operator === "<<-" &&
                                    lineBeginning &&
                                    character === "\t"
                                )
                                    continue;

                                const characterStart = i;

                                if (
                                    redirect.heredocQuoted !== true &&
                                    character === "\\" &&
                                    ["$", "`", "\\", "\n"].includes(raw[i + 1] ?? "")
                                ) {
                                    i++;
                                    character = raw[i] ?? "";
                                    if (character === "\n") character = "";
                                }

                                const characterRange = mappedRange(
                                    start + characterStart,
                                    start + i + 1,
                                    mapping,
                                );
                                if (characterRange !== undefined)
                                    appendMapping(characters, characterRange, character.length);

                                appendMapping(
                                    localCharacters,
                                    { start: start + characterStart, end: start + i + 1 },
                                    character.length,
                                );
                                code += character;
                                lineBeginning = raw[i] === "\n";
                            }
                        }

                        if (range !== undefined) {
                            const program: EmbeddedProgram = {
                                language: kind,
                                origin,
                                ...range,
                                localStart: start,
                                localEnd: bodyEnd,
                                ...(parent !== undefined && { parent }),
                                delimiter: marker,
                                stripTabs: redirect.operator === "<<-",
                                ...(!terminated && { incomplete: true }),
                                characters,
                                localCharacters,
                                code,
                                ...(standaloneLabel !== undefined && {
                                    standalone: {
                                        label: standaloneLabel,
                                        launcher: source.slice(0, headerEnd).trim(),
                                    },
                                }),
                                quoted: redirect.heredocQuoted === true,
                                expandable:
                                    redirect.heredocQuoted !== true &&
                                    redirect.body?.parts?.some(
                                        (part) => part.type !== "Literal",
                                    ) === true,
                            };

                            programs.push(program);

                            if (
                                kind === "bash" &&
                                !program.expandable &&
                                (characters.at(-1)?.to ?? 0) === code.length
                            )
                                pending.push({
                                    source: code,
                                    mapping: characters,
                                    parent: program,
                                });
                        }
                    }
                    break;
                }

                lineStart = lineEnd + 1;
            }

            if (incomplete) break;
        }
    }

    return programs.sort((a, b) => a.start - b.start);
}
