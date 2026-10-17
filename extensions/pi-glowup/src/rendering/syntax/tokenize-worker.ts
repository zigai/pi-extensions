import { parentPort } from "node:worker_threads";
import type { BundledLanguage, ThemeRegistration } from "shiki";
import { tokensToAnsiLines } from "./ansi.ts";
import { configureBracketPairColoring } from "./brackets.ts";

export type TokenizeRequest = {
    readonly id: number;
    readonly code: string;
    readonly language: BundledLanguage;
    readonly theme: ThemeRegistration;
    readonly brackets: boolean;
};

export type TokenizeInitialization = {
    readonly type: "initialize";
    readonly language: BundledLanguage;
    readonly theme: ThemeRegistration;
};

export type TokenizeResponse =
    | { readonly type: "ready" }
    | { readonly id: number; readonly lines: string[] }
    | { readonly id: number; readonly error: string };

const port = parentPort;
if (port === null) throw new Error("Syntax worker requires a parent port");

const { createHighlighter } = await import("shiki");
let highlighter: Awaited<ReturnType<typeof createHighlighter>> | undefined;

async function initialize(request: TokenizeInitialization): Promise<void> {
    highlighter = await createHighlighter({ themes: [request.theme], langs: [request.language] });
}

async function tokenize(request: TokenizeRequest): Promise<TokenizeResponse> {
    try {
        const syntax = highlighter;
        if (syntax === undefined) throw new Error("Syntax worker is not initialized");

        await syntax.loadLanguage(request.language);
        configureBracketPairColoring(request.brackets);

        const tokens = syntax.codeToTokensBase(request.code, {
            lang: request.language,
            theme: request.theme,
            tokenizeMaxLineLength: 0,
            tokenizeTimeLimit: 0,
        });
        return { id: request.id, lines: tokensToAnsiLines(tokens, request.language) };
    } catch (cause: unknown) {
        return {
            id: request.id,
            error: cause instanceof Error ? cause.message : String(cause),
        };
    }
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
