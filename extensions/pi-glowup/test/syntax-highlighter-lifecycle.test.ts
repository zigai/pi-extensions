import type { Highlighter } from "shiki";
import { afterEach, describe, expect, it } from "vitest";
import {
    disposeSyntaxHighlighting,
    getSyntaxHighlighterForLanguage,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
    type SyntaxHighlighterFactory,
} from "../src/syntax/highlighter.ts";

type FakeHighlighterOptions = {
    readonly loadedLanguages?: readonly string[];
    readonly dispose?: () => void;
    readonly loadLanguage?: (language: string) => Promise<void>;
};

function fakeHighlighter(options: FakeHighlighterOptions = {}): Highlighter {
    // SAFETY: These lifecycle tests exercise only the Highlighter methods called by
    // initializeSyntaxHighlighting(), disposeSyntaxHighlighting(), and
    // getSyntaxHighlighterForLanguage(). The unsupported methods are never reached.
    return {
        dispose() {
            options.dispose?.();
        },
        getLoadedLanguages() {
            return [...(options.loadedLanguages ?? [])];
        },
        async loadLanguage(...languages: string[]) {
            for (const language of languages) {
                await options.loadLanguage?.(language);
            }
        },
    } as unknown as Highlighter;
}

describe("syntax highlighter lifecycle", () => {
    afterEach(async () => {
        await disposeSyntaxHighlighting();
    });

    it("disposes a highlighter that resolves after disposal", async () => {
        let releaseFactory: (() => void) | undefined;
        let resolveFactoryStarted: (() => void) | undefined;
        let disposedCount = 0;
        const factoryStarted = new Promise<void>((resolve) => {
            resolveFactoryStarted = resolve;
        });
        const factory: SyntaxHighlighterFactory = async () => {
            resolveFactoryStarted?.();
            await new Promise<void>((resolveFactory) => {
                releaseFactory = resolveFactory;
            });
            return fakeHighlighter({
                loadedLanguages: ["typescript"],
                dispose() {
                    disposedCount += 1;
                },
            });
        };

        const initialization = initializeSyntaxHighlighting({}, { createHighlighter: factory });
        await factoryStarted;
        await disposeSyntaxHighlighting();
        releaseFactory?.();
        const state = await initialization;

        expect(state.status).toBe("disabled");
        if (state.status === "disabled") {
            expect(state.reason).toBe("disposed");
        }
        expect(disposedCount).toBe(1);
        expect(isSyntaxHighlightingReady()).toBe(false);
    });

    it("does not return a highlighter after disposal during language loading", async () => {
        let releaseLoad: (() => void) | undefined;
        let disposedCount = 0;
        const loadStarted = new Promise<void>((resolveStarted) => {
            const factory: SyntaxHighlighterFactory = async () =>
                fakeHighlighter({
                    loadedLanguages: ["typescript"],
                    dispose() {
                        disposedCount += 1;
                    },
                    async loadLanguage() {
                        resolveStarted();
                        await new Promise<void>((resolveLoad) => {
                            releaseLoad = resolveLoad;
                        });
                    },
                });
            void initializeSyntaxHighlighting({}, { createHighlighter: factory });
        });

        const loading = getSyntaxHighlighterForLanguage("go");
        await loadStarted;
        await disposeSyntaxHighlighting();
        releaseLoad?.();

        await expect(loading).resolves.toBeUndefined();
        expect(disposedCount).toBe(1);
    });

    it("disposes and resets highlighter state between sessions", async () => {
        await initializeSyntaxHighlighting();
        expect(isSyntaxHighlightingReady()).toBe(true);
        expect(highlightSyntaxCode("const value = 1;", "typescript").join("\n")).toContain(
            "\u001b[",
        );

        await disposeSyntaxHighlighting();

        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(highlightSyntaxCode("const value = 1;", "typescript")).toEqual(["const value = 1;"]);

        await initializeSyntaxHighlighting({ PI_CODEX_LOOK_SYNTAX: "off" });

        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(highlightSyntaxCode("const value = 1;", "typescript")).toEqual(["const value = 1;"]);
    });
});
