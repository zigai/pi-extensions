import { parentPort } from "node:worker_threads";
import type {
    CodeToTokensBaseOptions,
    HighlighterGeneric,
    ThemedToken,
    ThemeRegistration,
} from "shiki";
import { tokensToAnsiLines } from "./ansi.ts";
import { configureBracketPairColoring } from "./brackets.ts";
import { syntaxLanguageInput, type SyntaxLanguage } from "./language.ts";
import { compactPythonStructuralBlankRows } from "../../tools/built-in/bash/python-blank-rows.ts";

export type TokenizeRequest =
    | {
          readonly operation: "highlight";
          readonly id: number;
          readonly code: string;
          readonly language: SyntaxLanguage;
          readonly theme: ThemeRegistration;
          readonly brackets: boolean;
      }
    | {
          readonly operation: "compact-python";
          readonly id: number;
          readonly code: string;
      };

export type TokenizeInitialization = {
    readonly type: "initialize";
    readonly language: SyntaxLanguage;
    readonly theme: ThemeRegistration | undefined;
};

export type TokenizeResponse =
    | { readonly type: "ready" }
    | { readonly id: number; readonly lines: string[] }
    | { readonly id: number; readonly error: string };

const INPUT_END_ERROR_SCOPE = "invalid.illegal.newline";
const port = parentPort;
if (port === null) throw new Error("Syntax worker requires a parent port");

const { createBundledHighlighter, bundledLanguages, bundledThemes, createOnigurumaEngine } =
    await import("shiki");
// String-keyed like the main highlighter, so vendored grammars such as jq can register.
const createHighlighter = createBundledHighlighter<string, string>({
    langs: bundledLanguages,
    themes: bundledThemes,
    engine: async () => createOnigurumaEngine(import("shiki/wasm")),
});
let highlighter: Awaited<ReturnType<typeof createHighlighter>> | undefined;

async function initialize(request: TokenizeInitialization): Promise<void> {
    const themes: ThemeRegistration[] = [];
    if (request.theme !== undefined) themes.push(request.theme);

    highlighter = await createHighlighter({
        themes,
        langs: [syntaxLanguageInput(request.language)],
    });
}

async function tokenize(request: TokenizeRequest): Promise<TokenizeResponse> {
    try {
        const syntax = highlighter;
        if (syntax === undefined) throw new Error("Syntax worker is not initialized");

        if (request.operation === "compact-python") {
            await syntax.loadLanguage("python");
            return {
                id: request.id,
                lines: compactPythonStructuralBlankRows(
                    request.code,
                    syntax.getLanguage("python"),
                ).split("\n"),
            };
        }

        await syntax.loadLanguage(syntaxLanguageInput(request.language));
        configureBracketPairColoring(request.brackets);

        const tokens = tokenizeCode(syntax, request.code, request.language, request.theme);
        return { id: request.id, lines: tokensToAnsiLines(tokens, request.language) };
    } catch (cause: unknown) {
        return {
            id: request.id,
            error: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

// Streamed code often stops inside a string. JavaScript-family grammars then mark its final
// character as an illegal newline, which themes paint as an error. Only the last line can end
// without a newline, so only it is tokenized with scopes, continuing the preceding grammar state.
function tokenizeCode(
    syntax: HighlighterGeneric<string, string>,
    code: string,
    language: SyntaxLanguage,
    theme: ThemeRegistration,
): ThemedToken[][] {
    const options: CodeToTokensBaseOptions = {
        lang: language,
        theme,
        tokenizeMaxLineLength: 0,
        tokenizeTimeLimit: 0,
    };
    const tailOptions: CodeToTokensBaseOptions = {
        ...options,
        includeExplanation: "scopeName",
    };
    const lastBreak = code.lastIndexOf("\n");
    if (lastBreak === -1)
        return syntax.codeToTokensBase(code, tailOptions).map(withoutInputEndErrors);

    const head = syntax.codeToTokensBase(code.slice(0, lastBreak), options);
    const grammarState = syntax.getLastGrammarState(head);
    if (grammarState !== undefined) tailOptions.grammarState = grammarState;

    const tail = syntax.codeToTokensBase(code.slice(lastBreak + 1), tailOptions);
    return [...head, ...tail.map(withoutInputEndErrors)];
}

function withoutInputEndErrors(row: ThemedToken[]): ThemedToken[] {
    return row.map((token, index) => {
        const { explanation, ...plain } = token;
        const inputEnd =
            index === row.length - 1 &&
            explanation !== undefined &&
            explanation.length > 0 &&
            explanation.every((part) =>
                part.scopes.some((scope) => scope.scopeName.startsWith(INPUT_END_ERROR_SCOPE)),
            );
        if (!inputEnd) return plain;

        const surrounding = row[index - 1]?.color;
        const recolored: ThemedToken = { ...plain };
        if (surrounding === undefined) delete recolored.color;
        else recolored.color = surrounding;

        return recolored;
    });
}

port.on("message", (request: TokenizeRequest | TokenizeInitialization) => {
    if ("type" in request) {
        void initialize(request)
            .then(() => port.postMessage({ type: "ready" } satisfies TokenizeResponse))
            .catch(() => port.close());

        return;
    }

    void tokenize(request)
        .then((response) => {
            port.postMessage(response);
        })
        .catch(() => {
            port.close();
        });
});
