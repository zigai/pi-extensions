import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { Highlighter } from "shiki";
import { afterEach, describe, expect, it } from "vitest";
import { renderScriptCall, type CodexRenderTheme } from "../src/rendering/core.ts";
import { renderWriteCallPreview } from "../src/rendering/write-rendering.ts";
import {
    disposeSyntaxHighlighting,
    clearSyntaxHighlightCache,
    getSyntaxHighlighterForLanguage,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
    loadSyntaxLanguageIfReady,
    syntaxHighlightCacheStats,
    syntaxHighlighterDiagnostics,
    type SyntaxHighlighterFactory,
} from "../src/syntax/highlighter.ts";

const plainTheme: CodexRenderTheme = {
    fg(_token: string, text: string): string {
        return text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

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

async function waitForCondition(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for condition");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
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

    it("loads extra languages only after the central highlighter is ready", async () => {
        const loadedLanguages: string[] = [];

        await expect(loadSyntaxLanguageIfReady("typescript")).resolves.toBe(false);

        const factory: SyntaxHighlighterFactory = async () =>
            fakeHighlighter({
                loadedLanguages: ["markdown"],
                async loadLanguage(language) {
                    loadedLanguages.push(language);
                },
            });

        await initializeSyntaxHighlighting({}, { createHighlighter: factory });

        await expect(loadSyntaxLanguageIfReady("typescript")).resolves.toBe(true);
        expect(loadedLanguages).toEqual(["typescript"]);
        expect(syntaxHighlighterDiagnostics()).toEqual(
            expect.objectContaining({
                loadedLanguages: expect.arrayContaining(["markdown", "typescript"]),
                dynamicLanguages: ["typescript"],
            }),
        );
    });

    it("dynamically loads syntax for write previews in new-language projects", async () => {
        await initializeSyntaxHighlighting(process.env, { preloadLanguages: ["markdown"] });
        let invalidations = 0;
        let lastComponent: Component | undefined = renderWriteCallPreview(
            { path: "src/index.ts", content: "const value = 1;\n" },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                invalidate() {
                    invalidations += 1;
                },
            },
        );
        lastComponent.render(120);

        await waitForCondition(() => invalidations > 0);

        lastComponent = renderWriteCallPreview(
            { path: "src/index.ts", content: "const value = 1;\n" },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                lastComponent,
                invalidate() {
                    invalidations += 1;
                },
            },
        );

        const rendered = lastComponent.render(120).join("\n");

        expect(rendered).toContain("\u001b[");
        expect(rendered).toContain("const");
    });

    it("dynamically loads syntax for script previews in new-language projects", async () => {
        await initializeSyntaxHighlighting(process.env, { preloadLanguages: ["markdown"] });
        let invalidations = 0;
        const code = [
            "await disposeSyntaxHighlighting();",
            "const theme = new Theme({ toolTitle: '#ffffff' });",
        ].join("\n");
        let component: Component = renderScriptCall(
            plainTheme,
            { label: "Node", language: "javascript", code },
            {
                state: "success",
                expanded: false,
                invalidate() {
                    invalidations += 1;
                },
            },
        );

        expect(component.render(120).join("\n")).not.toContain("\u001b[");
        await waitForCondition(() => invalidations > 0);

        component = renderScriptCall(
            plainTheme,
            { label: "Node", language: "javascript", code },
            {
                state: "success",
                expanded: false,
                invalidate() {
                    invalidations += 1;
                },
            },
        );

        const rendered = component.render(120).join("\n");

        expect(rendered).toContain("\u001b[");
        expect(rendered).toContain("const");
    });

    it("invalidates every preview waiting on the same dynamic language", async () => {
        let releaseLoad: (() => void) | undefined;
        let resolveLoadStarted: (() => void) | undefined;
        const loadStarted = new Promise<void>((resolve) => {
            resolveLoadStarted = resolve;
        });
        const factory: SyntaxHighlighterFactory = async () =>
            fakeHighlighter({
                loadedLanguages: ["markdown"],
                async loadLanguage() {
                    resolveLoadStarted?.();
                    await new Promise<void>((resolve) => {
                        releaseLoad = resolve;
                    });
                },
            });
        await initializeSyntaxHighlighting({}, { createHighlighter: factory });

        let firstInvalidations = 0;
        let secondInvalidations = 0;
        const preview = { label: "Node", language: "javascript", code: "const value = 1;" };
        renderScriptCall(plainTheme, preview, {
            state: "success",
            expanded: false,
            invalidate() {
                firstInvalidations += 1;
            },
        });
        await loadStarted;
        renderScriptCall(plainTheme, preview, {
            state: "success",
            expanded: false,
            invalidate() {
                secondInvalidations += 1;
            },
        });

        releaseLoad?.();
        await waitForCondition(() => firstInvalidations > 0 && secondInvalidations > 0);

        expect(firstInvalidations).toBe(1);
        expect(secondInvalidations).toBe(1);
    });

    it("dynamically loads syntax for TypeScript embedded in bash heredocs", async () => {
        await initializeSyntaxHighlighting(process.env, { preloadLanguages: ["bash"] });
        let invalidations = 0;
        const code = [
            "NODE_PATH=\"$pkg:./node_modules\" tsx - <<'TS'",
            "const value: string = 'ok';",
            "TS",
        ].join("\n");
        let component: Component = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code },
            {
                state: "success",
                expanded: false,
                invalidate() {
                    invalidations += 1;
                },
            },
        );

        expect(component.render(120).join("\n")).not.toContain("\u001b[");
        await waitForCondition(() => invalidations > 0);

        component = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code },
            {
                state: "success",
                expanded: false,
                invalidate() {
                    invalidations += 1;
                },
            },
        );

        const rendered = component.render(120).join("\n");

        expect(rendered).toContain("\u001b[");
        expect(rendered).toContain("const");
        expect(syntaxHighlighterDiagnostics()).toEqual(
            expect.objectContaining({ dynamicLanguages: ["typescript"] }),
        );
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
