import path from "node:path";
import type { BundledLanguage, LanguageRegistration } from "shiki";
import { BUNDLED_SYNTAX_LANGUAGE_NAMES } from "./bundled-language-names.ts";
import { jqGrammar } from "./grammars/jq.ts";

/** Languages Shiki does not bundle, registered from vendored TextMate grammars. */
const CUSTOM_SYNTAX_LANGUAGES = new Map<string, LanguageRegistration>([["jq", jqGrammar]]);

export type CustomSyntaxLanguage = "jq";
export type SyntaxLanguage = BundledLanguage | CustomSyntaxLanguage;

const LANGUAGE_ALIASES = new Map<string, string>([
    ["bash", "bash"],
    ["shell", "bash"],
    ["sh", "bash"],
    ["zsh", "zsh"],
    ["fish", "fish"],
    ["js", "javascript"],
    ["jsx", "jsx"],
    ["mjs", "javascript"],
    ["cjs", "javascript"],
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["mts", "typescript"],
    ["cts", "typescript"],
    ["py", "python"],
    ["rb", "ruby"],
    ["rs", "rust"],
    ["rust", "rust"],
    ["go", "go"],
    ["golang", "go"],
    ["yml", "yaml"],
    ["md", "markdown"],
    ["markdown", "markdown"],
    ["dockerfile", "docker"],
    ["docker", "docker"],
    ["plaintext", "text"],
    ["plain", "text"],
    ["txt", "text"],
    ["text", "text"],
]);

const EXTENSION_LANGUAGES = new Map<string, string>([
    [".bash", "bash"],
    [".c", "c"],
    [".cc", "cpp"],
    [".cjs", "javascript"],
    [".cpp", "cpp"],
    [".cs", "csharp"],
    [".css", "css"],
    [".cts", "typescript"],
    [".fish", "fish"],
    [".go", "go"],
    [".h", "c"],
    [".hpp", "cpp"],
    [".html", "html"],
    [".java", "java"],
    [".js", "javascript"],
    [".json", "json"],
    [".jsonc", "jsonc"],
    [".jsx", "jsx"],
    [".kt", "kotlin"],
    [".kts", "kotlin"],
    [".lua", "lua"],
    [".md", "markdown"],
    [".mjs", "javascript"],
    [".mts", "typescript"],
    [".php", "php"],
    [".py", "python"],
    [".rb", "ruby"],
    [".rs", "rust"],
    [".sh", "bash"],
    [".sql", "sql"],
    [".swift", "swift"],
    [".tf", "hcl"],
    [".toml", "toml"],
    [".ts", "typescript"],
    [".tsx", "tsx"],
    [".xml", "xml"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".zsh", "zsh"],
]);

const SPECIAL_FILE_LANGUAGES = new Map<string, string>([
    ["dockerfile", "docker"],
    ["justfile", "make"],
    ["makefile", "make"],
]);

const SHEBANG_INTERPRETER_LANGUAGES = new Map<string, string>([
    ["awk", "awk"],
    ["bash", "bash"],
    ["bun", "javascript"],
    ["dash", "bash"],
    ["deno", "typescript"],
    ["fish", "fish"],
    ["groovy", "groovy"],
    ["julia", "julia"],
    ["ksh", "bash"],
    ["lua", "lua"],
    ["luajit", "lua"],
    ["node", "javascript"],
    ["nodejs", "javascript"],
    ["perl", "perl"],
    ["php", "php"],
    ["powershell", "powershell"],
    ["pwsh", "powershell"],
    ["rscript", "r"],
    ["ruby", "ruby"],
    ["sh", "bash"],
    ["swift", "swift"],
    ["ts-node", "typescript"],
    ["tsx", "tsx"],
    ["zsh", "zsh"],
]);

const PYTHON_SHEBANG_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)*)?|pypy\d*)$/u;
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Common languages preloaded during extension startup for synchronous TUI rendering. */
export const PRELOADED_SYNTAX_LANGUAGES = [
    "markdown",
    "bash",
    "python",
    "typescript",
    "javascript",
    "json",
] as const satisfies ReadonlyArray<BundledLanguage>;

/** Normalizes a Markdown/tool language hint to a Shiki bundled language when known. */
export function normalizeSyntaxLanguage(
    language: string | undefined | null,
): SyntaxLanguage | "text" | undefined {
    const raw = language?.trim().toLowerCase();
    if (raw === undefined || raw.length === 0) {
        return undefined;
    }

    const withoutFenceAttrs = raw.split(/[\s,{]/u)[0] ?? raw;
    const normalized = LANGUAGE_ALIASES.get(withoutFenceAttrs) ?? withoutFenceAttrs;
    if (normalized === "text") {
        return "text";
    }

    if (isCustomSyntaxLanguage(normalized)) return normalized;
    return isBundledSyntaxLanguage(normalized) ? normalized : undefined;
}

/** Infers a Shiki language from a file path or basename. */
export function syntaxLanguageFromPath(
    filePath: string | undefined,
): SyntaxLanguage | "text" | undefined {
    if (filePath === undefined || filePath.length === 0) {
        return undefined;
    }

    const basename = path.basename(filePath).toLowerCase();
    const special = SPECIAL_FILE_LANGUAGES.get(basename);
    if (special !== undefined) {
        return normalizeSyntaxLanguage(special);
    }

    return normalizeSyntaxLanguage(EXTENSION_LANGUAGES.get(path.extname(basename)));
}

/** Infers a Shiki language from a common script-interpreter shebang. */
export function syntaxLanguageFromShebang(content: string | undefined): SyntaxLanguage | undefined {
    if (content === undefined || !content.startsWith("#!")) {
        return undefined;
    }

    const firstLineEnd = content.indexOf("\n");
    const shebang = content.slice(2, firstLineEnd === -1 ? undefined : firstLineEnd).trim();
    const words = shebang.split(/\s+/u);
    const executable = words[0];
    if (executable === undefined) {
        return undefined;
    }

    const command =
        path.basename(executable).toLowerCase() === "env"
            ? environmentShebangCommand(words.slice(1))
            : words;
    const interpreter = command[0];
    if (interpreter === undefined) {
        return undefined;
    }

    const interpreterName = path.basename(interpreter).toLowerCase();
    if (PYTHON_SHEBANG_INTERPRETER.test(interpreterName)) {
        return "python";
    }

    if (interpreterName === "uv" && command[1] === "run" && command.includes("--script")) {
        return "python";
    }

    const language = normalizeSyntaxLanguage(SHEBANG_INTERPRETER_LANGUAGES.get(interpreterName));
    return language === "text" ? undefined : language;
}

function environmentShebangCommand(arguments_: ReadonlyArray<string>): ReadonlyArray<string> {
    let commandIndex = 0;
    while (commandIndex < arguments_.length) {
        const argument = arguments_[commandIndex];
        if (argument === undefined) {
            return [];
        }

        if (argument === "-u" || argument === "--unset") {
            commandIndex += 2;
            continue;
        }

        if (
            argument === "-S" ||
            argument === "-i" ||
            argument === "--ignore-environment" ||
            argument.startsWith("--unset=") ||
            ENVIRONMENT_ASSIGNMENT.test(argument)
        ) {
            commandIndex += 1;
            continue;
        }
        break;
    }

    return arguments_.slice(commandIndex);
}

/** Infers syntax from a path first, then an extensionless file's shebang. */
export function syntaxLanguageFromFile(
    filePath: string | undefined,
    content: string | undefined,
): SyntaxLanguage | "text" | undefined {
    return syntaxLanguageFromPath(filePath) ?? syntaxLanguageFromShebang(content);
}

/** Returns true when Shiki can load the language name or alias. */
export function isBundledSyntaxLanguage(language: string): language is BundledLanguage {
    return BUNDLED_SYNTAX_LANGUAGE_NAMES.has(language);
}

function isCustomSyntaxLanguage(language: string): language is CustomSyntaxLanguage {
    return CUSTOM_SYNTAX_LANGUAGES.has(language);
}

/** Returns true when Shiki can load the language, bundled or vendored. */
export function isLoadableSyntaxLanguage(language: string): language is SyntaxLanguage {
    return isBundledSyntaxLanguage(language) || isCustomSyntaxLanguage(language);
}

/** The argument Shiki's `loadLanguage` and `createHighlighter` need for a language. */
export function syntaxLanguageInput(
    language: SyntaxLanguage,
): BundledLanguage | LanguageRegistration {
    if (language === "jq") return jqGrammar;
    return language;
}
