import path from "node:path";
import type { BundledLanguage } from "shiki";
import { BUNDLED_SYNTAX_LANGUAGE_NAMES } from "./bundled-language-names.ts";

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
): BundledLanguage | "text" | undefined {
    const raw = language?.trim().toLowerCase();
    if (raw === undefined || raw.length === 0) {
        return undefined;
    }

    const withoutFenceAttrs = raw.split(/[\s,{]/u)[0] ?? raw;
    const normalized = LANGUAGE_ALIASES.get(withoutFenceAttrs) ?? withoutFenceAttrs;
    if (normalized === "text") {
        return "text";
    }
    return isBundledSyntaxLanguage(normalized) ? normalized : undefined;
}

/** Infers a Shiki language from a file path or basename. */
export function syntaxLanguageFromPath(
    filePath: string | undefined,
): BundledLanguage | "text" | undefined {
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

/** Returns true when Shiki can load the language name or alias. */
export function isBundledSyntaxLanguage(language: string): language is BundledLanguage {
    return BUNDLED_SYNTAX_LANGUAGE_NAMES.has(language);
}
