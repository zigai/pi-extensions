import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Highlighter } from "shiki";
import { afterEach, describe, expect, it } from "vitest";
import {
    disposeSyntaxHighlighting,
    clearSyntaxHighlightCache,
    getSyntaxHighlighterForLanguage,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
    syntaxHighlightCacheStats,
    syntaxHighlighterDiagnostics,
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

function stringLanguageNames(languages: ReadonlyArray<unknown> | undefined): string[] {
    const names: string[] = [];
    for (const language of languages ?? []) {
        if (typeof language === "string") {
            names.push(language);
        }
    }
    return names;
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

    it("preloads configured languages and reports invalid language names", async () => {
        let requestedLanguages: string[] = [];
        const reportedWarnings: string[] = [];
        const factory: SyntaxHighlighterFactory = async (options) => {
            requestedLanguages = stringLanguageNames(options.langs);
            return fakeHighlighter({ loadedLanguages: requestedLanguages });
        };

        await initializeSyntaxHighlighting(
            {},
            {
                createHighlighter: factory,
                preloadLanguages: ["markdown", "ts", "not-real", "text"],
                reportWarning: (message) => reportedWarnings.push(message),
            },
        );

        expect(requestedLanguages).toEqual(["markdown", "typescript"]);
        expect(reportedWarnings).toEqual([
            expect.stringContaining('Ignoring unknown syntax preload language "not-real"'),
            expect.stringContaining('Ignoring unknown syntax preload language "text"'),
        ]);
        expect(syntaxHighlighterDiagnostics()).toEqual(
            expect.objectContaining({
                configuredPreloadLanguages: ["markdown", "ts", "not-real", "text"],
                preloadLanguages: ["markdown", "typescript"],
                ignoredPreloadLanguages: ["not-real", "text"],
            }),
        );
    });

    it("adds project-detected languages to configured preloads", async () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-codex-look-languages-"));
        let requestedLanguages: string[] = [];
        const factory: SyntaxHighlighterFactory = async (options) => {
            requestedLanguages = stringLanguageNames(options.langs);
            return fakeHighlighter({ loadedLanguages: requestedLanguages });
        };

        try {
            mkdirSync(join(directory, "src"));
            mkdirSync(join(directory, "node_modules"));
            writeFileSync(join(directory, "src", "index.ts"), "const value = 1;\n");
            writeFileSync(join(directory, "script.py"), "print('ok')\n");
            writeFileSync(join(directory, "Dockerfile"), "FROM node\n");
            writeFileSync(join(directory, "node_modules", "ignored.rb"), "puts 'ignored'\n");

            await initializeSyntaxHighlighting(
                {},
                {
                    createHighlighter: factory,
                    preloadLanguages: ["markdown"],
                    projectLanguageDetection: { enabled: true, cwd: directory },
                },
            );

            expect(requestedLanguages).toEqual(
                expect.arrayContaining(["markdown", "typescript", "python", "docker"]),
            );
            expect(requestedLanguages).not.toContain("ruby");
            expect(syntaxHighlighterDiagnostics()).toEqual(
                expect.objectContaining({
                    projectLanguageDetectionEnabled: true,
                    detectedProjectLanguages: expect.arrayContaining([
                        "docker",
                        "python",
                        "typescript",
                    ]),
                }),
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("dynamically loads bundled languages without a preload cap", async () => {
        const loadedLanguages: string[] = [];
        const factory: SyntaxHighlighterFactory = async () =>
            fakeHighlighter({
                loadedLanguages: ["typescript"],
                async loadLanguage(language) {
                    loadedLanguages.push(language);
                },
            });

        await initializeSyntaxHighlighting({}, { createHighlighter: factory });

        await expect(getSyntaxHighlighterForLanguage("vue")).resolves.toEqual(
            expect.objectContaining({ language: "vue" }),
        );
        expect(loadedLanguages).toEqual(["vue"]);
    });

    it("disposes and resets highlighter state between sessions", async () => {
        await initializeSyntaxHighlighting();
        expect(isSyntaxHighlightingReady()).toBe(true);
        expect(highlightSyntaxCode("import sys", "python").join("\n")).toContain("\u001b[");
        expect(syntaxHighlightCacheStats().entries).toBeGreaterThan(0);

        await disposeSyntaxHighlighting();

        expect(syntaxHighlightCacheStats()).toEqual({ entries: 0, bytes: 0 });
        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(highlightSyntaxCode("import sys", "python")).toEqual(["import sys"]);

        await initializeSyntaxHighlighting({ PI_CODEX_LOOK_SYNTAX: "off" });

        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(highlightSyntaxCode("import sys", "python")).toEqual(["import sys"]);
    });

    it("does not cache highlights when cache is disabled", async () => {
        await initializeSyntaxHighlighting();
        clearSyntaxHighlightCache();

        highlightSyntaxCode("streamed = 1", "python", { cache: false });

        expect(syntaxHighlightCacheStats()).toEqual({ entries: 0, bytes: 0 });

        highlightSyntaxCode("final_value = 1", "python");

        expect(syntaxHighlightCacheStats().entries).toBe(1);
        expect(syntaxHighlightCacheStats().bytes).toBeGreaterThan(0);
    });
});
