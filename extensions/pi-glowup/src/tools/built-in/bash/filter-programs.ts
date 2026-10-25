import {
    commandBasename,
    decodeShellWord,
    tokenizeShellLexemes,
    wrappedCommandIndex,
} from "./invocation.ts";

export type FilterLanguage = "awk" | "jq";

/** An inline awk/jq program word inside a Bash command; `start`/`end` exclude the quotes. */
export type FilterProgram = {
    readonly start: number;
    readonly end: number;
    readonly language: FilterLanguage;

    /** Single-quoted words are literal; double-quoted ones are only highlighted. */
    readonly quote: "single" | "double";
};

const AWK_COMMANDS = new Set(["awk", "gawk", "mawk", "nawk"]);

// Options consuming the following word. Attached forms such as `-F:` need no lookahead.
const AWK_OPTIONS_WITH_VALUES = new Set([
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

// The program comes from a file; any later operand is input data.
const AWK_FILE_PROGRAM_OPTIONS = new Set(["-f", "-E", "--file", "--exec"]);
const AWK_SOURCE_OPTIONS = new Set(["-e", "--source"]);
const JQ_OPTIONS_WITH_ONE_VALUE = new Set(["--indent", "-L", "--library-path"]);
const JQ_OPTIONS_WITH_TWO_VALUES = new Set(["--arg", "--argjson", "--slurpfile", "--rawfile"]);
const JQ_FILE_PROGRAM_OPTIONS = new Set(["-f", "--from-file"]);

/** Cheap pre-check before the per-segment shell scan. */
export function mayContainFilterProgram(command: string): boolean {
    return /(?:^|[\s/|;&(`])(?:[gmn]?awk|jq)(?=[\s'"]|$)/mu.test(command);
}

function filterLanguageForWord(word: string): FilterLanguage | undefined {
    const basename = commandBasename(word);
    if (AWK_COMMANDS.has(basename)) return "awk";
    if (basename === "jq") return "jq";
    return undefined;
}

function awkProgramIndex(words: readonly string[], start: number): number | undefined {
    let program: number | undefined;
    for (let index = start; index < words.length; index += 1) {
        const value = decodeShellWord(words[index] ?? "");
        if (value === "--") {
            if (program !== undefined) return program;
            if (index + 1 < words.length) return index + 1;
            return undefined;
        }

        if (AWK_FILE_PROGRAM_OPTIONS.has(value) || /^-f./u.test(value)) return undefined;
        if (/^--(?:file|exec)=/u.test(value)) return undefined;

        if (AWK_SOURCE_OPTIONS.has(value)) {
            // Several -e fragments form one program; none of them is a complete unit.
            if (program !== undefined) return undefined;

            program = index + 1;
            index += 1;
            continue;
        }

        if (AWK_OPTIONS_WITH_VALUES.has(value)) {
            index += 1;
            continue;
        }

        if (value.startsWith("-") && value !== "-" && !isQuoted(words[index] ?? "")) continue;

        return program ?? index;
    }

    if (program !== undefined && program < words.length) return program;
    return undefined;
}

function jqProgramIndex(words: readonly string[], start: number): number | undefined {
    for (let index = start; index < words.length; index += 1) {
        const value = decodeShellWord(words[index] ?? "");
        if (value === "--") {
            if (index + 1 < words.length) return index + 1;
            return undefined;
        }

        if (JQ_FILE_PROGRAM_OPTIONS.has(value)) return undefined;

        if (JQ_OPTIONS_WITH_TWO_VALUES.has(value)) {
            index += 2;
            continue;
        }

        if (JQ_OPTIONS_WITH_ONE_VALUE.has(value)) {
            index += 1;
            continue;
        }

        if (value.startsWith("-") && value !== "-" && !isQuoted(words[index] ?? "")) {
            // Combined short flags such as `-rf` still read the filter from a file.
            if (/^-[a-zA-Z]*f[a-zA-Z]*$/u.test(value) && !value.startsWith("--")) return undefined;
            continue;
        }

        return index;
    }

    return undefined;
}

function isQuoted(word: string): boolean {
    return word.startsWith("'") || word.startsWith('"');
}

function programWord(word: string): FilterProgram["quote"] | undefined {
    if (word.length < 2) return undefined;

    const inner = word.slice(1, -1);
    if (word.startsWith("'") && word.endsWith("'") && !inner.includes("'")) return "single";

    // Without expansions or escapes, the double-quoted text is the literal program.
    if (word.startsWith('"') && word.endsWith('"') && !/["$`\\]/u.test(inner)) return "double";

    return undefined;
}

function filterProgramIn(
    words: readonly string[],
): { readonly language: FilterLanguage; readonly index: number } | undefined {
    const commandIndex = wrappedCommandIndex(
        words,
        (word) => filterLanguageForWord(word) !== undefined,
    );
    if (commandIndex === undefined) return undefined;

    const language = filterLanguageForWord(words[commandIndex] ?? "");
    let index: number | undefined;
    if (language === "awk") index = awkProgramIndex(words, commandIndex + 1);
    if (language === "jq") index = jqProgramIndex(words, commandIndex + 1);
    if (language === undefined || index === undefined) return undefined;

    return { language, index };
}

/** Locates inline awk/jq programs in each simple command of a composed Bash command. */
export function embeddedFilterPrograms(command: string): FilterProgram[] {
    if (!mayContainFilterProgram(command) || command.includes("<<")) return [];

    return scanFilterPrograms(command);
}

/**
 * Programs on the rows up to the first heredoc operator, for diagnostics only: heredoc bodies
 * are not shell words, and programs after them are not located.
 */
export function filterProgramsBeforeHeredoc(command: string): FilterProgram[] {
    const operator = command.indexOf("<<");
    if (operator < 0) return embeddedFilterPrograms(command);

    let end = command.indexOf("\n", operator);
    if (end < 0) end = command.length;

    const prefix = command.slice(0, end);
    if (!mayContainFilterProgram(prefix)) return [];

    return scanFilterPrograms(prefix);
}

function scanFilterPrograms(command: string): FilterProgram[] {
    const programs: FilterProgram[] = [];
    let words: { readonly source: string; readonly start: number; readonly end: number }[] = [];

    const collect = (): void => {
        const sources = words.map((word) => word.source);
        const program = filterProgramIn(sources);
        const word = words[program?.index ?? -1];
        if (word !== undefined && program !== undefined) {
            const quote = programWord(word.source);
            if (quote !== undefined)
                programs.push({
                    start: word.start + 1,
                    end: word.end - 1,
                    language: program.language,
                    quote,
                });
        }

        words = [];
    };

    for (const lexeme of tokenizeShellLexemes(command)) {
        if (lexeme.kind === "separator") collect();
        else if (lexeme.kind === "word") words.push(lexeme);
    }

    collect();

    return programs;
}
