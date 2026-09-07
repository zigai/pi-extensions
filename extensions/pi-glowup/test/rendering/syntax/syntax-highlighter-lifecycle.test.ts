import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component } from "@earendil-works/pi-tui";
import type { HighlighterGeneric } from "shiki";
import Type from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { renderScriptCall } from "../../../src/tools/built-in/bash/script-renderer.ts";
import { type GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import { renderWriteCallPreview } from "../../../src/tools/built-in/write-preview.ts";
import { scheduleCodeOutputSyntaxLoad } from "../../../src/rendering/syntax/code-component.ts";
import {
    createSyntaxHighlighter,
    disposeSyntaxHighlighting,
    clearSyntaxHighlightCache,
    getLoadedSyntaxHighlighterForLanguage,
    getSyntaxHighlighterForLanguage,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
    loadSyntaxLanguageIfReady,
    refreshSyntaxHighlighting,
    reinitializeSyntaxHighlighting,
    syntaxHighlightCacheStats,
    syntaxHighlighterDiagnostics,
    type SyntaxHighlighterFactory,
} from "../../../src/rendering/syntax/highlighter.ts";

const plainTheme: GlowupRenderTheme = {
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

async function fakeHighlighter(
    options: FakeHighlighterOptions = {},
): Promise<HighlighterGeneric<string, string>> {
    const highlighter = await createSyntaxHighlighter({
        themes: [],
        langs: [...(options.loadedLanguages ?? [])],
    });
    const dispose = highlighter.dispose.bind(highlighter);
    const loadLanguage = highlighter.loadLanguage.bind(highlighter);
    highlighter.dispose = () => {
        dispose();
        options.dispose?.();
    };
    highlighter.loadLanguage = async (...languages) => {
        for (const language of stringLanguageNames(languages)) {
            await options.loadLanguage?.(language);
        }

        await loadLanguage(...languages);
    };

    return highlighter;
}

const languageNameSchema = Type.String();
const languageNamesSchema = Type.Array(languageNameSchema);

function stringLanguageNames(languages: ReadonlyArray<unknown> | undefined): string[] {
    return Value.Parse(
        languageNamesSchema,
        (languages ?? []).filter((language) => Value.Check(languageNameSchema, language)),
    );
}

async function waitForCondition(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("timed out waiting for condition");
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });
    }
}

describe("syntax highlighter lifecycle", () => {
    afterEach(async () => {
        await disposeSyntaxHighlighting();
    });

    it("owns custom registered names and rejects unsupported names through Shiki", async () => {
        const state = await initializeSyntaxHighlighting({}, { preloadLanguages: [] });
        expect(state.status).toBe("ready");

        if (state.status !== "ready") {
            throw new Error("expected the real shared highlighter");
        }

        const { highlighter } = state;
        await highlighter.loadLanguage({
            name: "glowup-custom-language",
            scopeName: "source.glowup-custom",
            repository: {},
            patterns: [{ match: "hello", name: "keyword.glowup-custom" }],
        });
        await highlighter.loadTheme({
            name: "glowup-custom-theme",
            settings: [
                { settings: { foreground: "#ffffff", background: "#000000" } },
                { scope: "keyword.glowup-custom", settings: { foreground: "#123456" } },
            ],
        });
        expect(
            highlighter.codeToTokensBase("hello", {
                lang: "glowup-custom-language",
                theme: "glowup-custom-theme",
            }),
        ).toEqual([[expect.objectContaining({ content: "hello", color: "#123456" })]]);
        expect(getLoadedSyntaxHighlighterForLanguage("text")?.highlighter).toBe(highlighter);
        expect((await getSyntaxHighlighterForLanguage("typescript"))?.highlighter).toBe(
            highlighter,
        );
        expect(() =>
            highlighter.codeToTokensBase("hello", {
                lang: "glowup-missing-language",
                theme: "glowup-custom-theme",
            }),
        ).toThrow(/not found|not loaded/);
        expect(() =>
            highlighter.codeToTokensBase("hello", {
                lang: "glowup-custom-language",
                theme: "glowup-missing-theme",
            }),
        ).toThrow(/not found|not loaded/);

        // Bundle resolution throws synchronously; own any unexpected returned promise too.
        const pendingLoads: Promise<void>[] = [];
        try {
            expect(() => {
                pendingLoads.push(highlighter.loadLanguage("glowup-missing-language"));
            }).toThrow(/not included/);
            expect(() => {
                pendingLoads.push(highlighter.loadTheme("glowup-missing-theme"));
            }).toThrow(/not included/);
        } finally {
            await Promise.allSettled(pendingLoads);
        }

        await expect(
            createSyntaxHighlighter({
                langs: ["glowup-missing-language"],
                themes: [],
            }),
        ).rejects.toThrow(/not included/);
        await expect(
            createSyntaxHighlighter({
                langs: [],
                themes: ["glowup-missing-theme"],
            }),
        ).rejects.toThrow(/not included/);
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

        expect(state).toMatchObject({ status: "disabled", reason: "disposed" });
        expect(disposedCount).toBe(1);
        expect(isSyntaxHighlightingReady()).toBe(false);
    });

    it("keeps the current highlighter ready until its replacement is available", async () => {
        let releaseReplacement: (() => void) | undefined;
        let resolveReplacementStarted: (() => void) | undefined;
        let oldDisposedCount = 0;
        const replacementStarted = new Promise<void>((resolve) => {
            resolveReplacementStarted = resolve;
        });
        const oldHighlighter = await fakeHighlighter({
            loadedLanguages: ["typescript"],
            dispose() {
                oldDisposedCount += 1;
            },
        });
        const newHighlighter = await fakeHighlighter({ loadedLanguages: ["typescript", "python"] });

        await initializeSyntaxHighlighting(
            {},
            { createHighlighter: async () => oldHighlighter, preloadLanguages: ["typescript"] },
        );
        const replacement = reinitializeSyntaxHighlighting(
            {},
            {
                createHighlighter: async () => {
                    resolveReplacementStarted?.();
                    await new Promise<void>((resolve) => {
                        releaseReplacement = resolve;
                    });

                    return newHighlighter;
                },
                preloadLanguages: ["typescript", "python"],
            },
        );
        await replacementStarted;

        expect(isSyntaxHighlightingReady()).toBe(true);
        expect(getLoadedSyntaxHighlighterForLanguage("typescript")?.highlighter).toBe(
            oldHighlighter,
        );
        expect(oldDisposedCount).toBe(0);

        releaseReplacement?.();
        await replacement;

        expect(getLoadedSyntaxHighlighterForLanguage("typescript")?.highlighter).toBe(
            newHighlighter,
        );
        expect(oldDisposedCount).toBe(1);
    });

    it("reuses the highlighter until syntax inputs change", async () => {
        let factoryCalls = 0;
        const factory: SyntaxHighlighterFactory = async () => {
            factoryCalls += 1;
            return fakeHighlighter({ loadedLanguages: ["typescript", "python"] });
        };

        await initializeSyntaxHighlighting(
            {},
            { createHighlighter: factory, preloadLanguages: ["typescript"] },
        );
        await refreshSyntaxHighlighting(
            {},
            { createHighlighter: factory, preloadLanguages: ["typescript"] },
        );
        expect(factoryCalls).toBe(1);

        await refreshSyntaxHighlighting(
            {},
            { createHighlighter: factory, preloadLanguages: ["typescript", "python"] },
        );
        expect(factoryCalls).toBe(2);
    });

    it.each([
        ["initialize", initializeSyntaxHighlighting],
        ["reinitialize", reinitializeSyntaxHighlighting],
        ["refresh", refreshSyntaxHighlighting],
    ])(
        "captures one configuration for %s installation and refresh identity",
        async (_name, initialize) => {
            const directory = mkdtempSync(join(tmpdir(), "pi-glowup-theme-snapshot-"));
            const path = join(directory, "theme.json");
            const missingPath = join(directory, "missing.json");
            let configurationReads = 0;
            const env: NodeJS.ProcessEnv = {
                get PI_GLOWUP_SYNTAX_THEME() {
                    configurationReads += 1;
                    return configurationReads === 1 ? path : missingPath;
                },
            };
            const installed = await fakeHighlighter();
            const options = { createHighlighter: async () => installed, preloadLanguages: [] };
            try {
                writeFileSync(
                    path,
                    JSON.stringify({ tokenColors: [], colors: { "editor.foreground": "#123456" } }),
                );
                const state = await initialize(env, options);

                expect(state.status).toBe("ready");

                if (state.status !== "ready") throw new Error("theme snapshot was not installed");
                expect(state.theme.path).toBe(path);
                expect(state.theme.registration.colors?.["editor.foreground"]).toBe("#123456");
                expect(configurationReads).toBe(1);
                expect(
                    await refreshSyntaxHighlighting({ PI_GLOWUP_SYNTAX_THEME: path }, options),
                ).toBe(state);
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    );

    it("refreshes from changed bytes after the installed snapshot was captured", async () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-glowup-theme-refresh-"));
        const path = join(directory, "theme.json");
        const env = { PI_GLOWUP_SYNTAX_THEME: path };
        const theme = (color: string) =>
            JSON.stringify({ tokenColors: [], colors: { "editor.foreground": color } });
        let factoryCalls = 0;
        const options = {
            preloadLanguages: [],
            createHighlighter: async () => {
                factoryCalls += 1;
                if (factoryCalls === 1) writeFileSync(path, theme("#abcdef"));
                return fakeHighlighter();
            },
        };
        try {
            writeFileSync(path, theme("#123456"));
            const first = await initializeSyntaxHighlighting(env, options);
            expect(first.status).toBe("ready");

            if (first.status !== "ready") throw new Error("initial theme was not installed");
            expect(first.theme.registration.colors?.["editor.foreground"]).toBe("#123456");

            const second = await refreshSyntaxHighlighting(env, options);
            expect(second.status).toBe("ready");

            if (second.status !== "ready") throw new Error("replacement theme was not installed");
            expect(second.theme.registration.colors?.["editor.foreground"]).toBe("#abcdef");
            expect(second).not.toBe(first);
            expect(await refreshSyntaxHighlighting(env, options)).toBe(second);
            expect(factoryCalls).toBe(2);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("retains failed-source identity and recovers when missing or malformed theme bytes change", async () => {
        const directory = mkdtempSync(join(tmpdir(), "pi-glowup-theme-errors-"));
        const path = join(directory, "theme.json");
        const env = { PI_GLOWUP_SYNTAX_THEME: path };
        const options = { createHighlighter: async () => fakeHighlighter(), preloadLanguages: [] };
        try {
            const missing = await initializeSyntaxHighlighting(env, options);
            expect(missing.status).toBe("failed");
            expect(await refreshSyntaxHighlighting(env, options)).toBe(missing);

            writeFileSync(path, "{}");
            const malformed = await refreshSyntaxHighlighting(env, options);
            expect(malformed).toMatchObject({
                status: "failed",
                reason: "Syntax theme JSON must include tokenColors",
            });
            expect(await refreshSyntaxHighlighting(env, options)).toBe(malformed);
            writeFileSync(path, "{ }");
            const changedMalformed = await refreshSyntaxHighlighting(env, options);
            expect(changedMalformed).toEqual(malformed);
            expect(changedMalformed).not.toBe(malformed);

            writeFileSync(path, '{"tokenColors":[]}');
            expect((await refreshSyntaxHighlighting(env, options)).status).toBe("ready");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it.each([
        [null],
        [{ scope: "source.ts" }],
        [{ settings: { foreground: 123 } }],
        [{ scope: ["source.ts", 123], settings: {} }],
    ])("rejects malformed token color settings before invoking Shiki: %j", async (entry) => {
        const directory = mkdtempSync(join(tmpdir(), "pi-glowup-invalid-theme-"));
        const path = join(directory, "theme.json");
        let factoryCalls = 0;
        try {
            writeFileSync(path, JSON.stringify({ tokenColors: [entry] }));
            const state = await initializeSyntaxHighlighting(
                { PI_GLOWUP_SYNTAX_THEME: path },
                {
                    createHighlighter: async () => {
                        factoryCalls += 1;
                        return fakeHighlighter();
                    },
                },
            );
            expect(state.status).toBe("failed");
            expect(factoryCalls).toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("does not publish a refresh whose source read outlives disposal", async () => {
        const refresh = refreshSyntaxHighlighting(
            {},
            {
                createHighlighter: async () => fakeHighlighter(),
            },
        );
        await disposeSyntaxHighlighting();
        expect(await refresh).toMatchObject({ status: "disabled", reason: "disposed" });
        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(syntaxHighlighterDiagnostics().status).toBe("uninitialized");
    });

    it("invalidates previews queued before syntax initialization completes", async () => {
        let invalidations = 0;

        scheduleCodeOutputSyntaxLoad({ path: "src/example.ts" }, () => {
            invalidations += 1;
        });
        expect(invalidations).toBe(0);

        await initializeSyntaxHighlighting(
            {},
            {
                createHighlighter: async () => fakeHighlighter({ loadedLanguages: ["typescript"] }),
                preloadLanguages: ["typescript"],
            },
        );
        await waitForCondition(() => invalidations === 1);

        expect(invalidations).toBe(1);
    });

    it.each([
        { name: "highlighter lookup", load: getSyntaxHighlighterForLanguage, expected: undefined },
        { name: "ready language load", load: loadSyntaxLanguageIfReady, expected: false },
    ])(
        "settles $name as cancelled after disposal during language loading",
        async ({ load, expected }) => {
            let disposedCount = 0;
            let markLoadStarted: (() => void) | undefined;
            let releaseLoad: (() => void) | undefined;
            const loadStarted = new Promise<void>((resolve) => {
                markLoadStarted = resolve;
            });
            const blockedLoad = new Promise<void>((resolve) => {
                releaseLoad = resolve;
            });
            const factory: SyntaxHighlighterFactory = async () =>
                fakeHighlighter({
                    loadedLanguages: ["typescript"],
                    dispose() {
                        disposedCount += 1;
                    },
                    async loadLanguage() {
                        markLoadStarted?.();
                        await blockedLoad;
                    },
                });

            await initializeSyntaxHighlighting({}, { createHighlighter: factory });
            const loading = load("go");
            await loadStarted;
            await disposeSyntaxHighlighting();
            releaseLoad?.();

            await expect(loading).resolves.toBe(expected);
            expect(disposedCount).toBe(1);
        },
    );

    it("preserves failures from the active highlighter", async () => {
        await initializeSyntaxHighlighting(
            {},
            {
                createHighlighter: async () =>
                    fakeHighlighter({
                        loadedLanguages: ["typescript"],
                        async loadLanguage() {
                            throw new Error("active language load failed");
                        },
                    }),
            },
        );
        await expect(getSyntaxHighlighterForLanguage("go")).rejects.toThrow(
            "active language load failed",
        );
        await expect(loadSyntaxLanguageIfReady("python")).rejects.toThrow(
            "active language load failed",
        );
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
                reportWarning: (message) => {
                    reportedWarnings.push(message);
                },
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
        const directory = mkdtempSync(join(tmpdir(), "pi-glowup-languages-"));
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
            const diagnostics = syntaxHighlighterDiagnostics();
            expect(diagnostics.projectLanguageDetectionEnabled).toBe(true);
            expect(diagnostics.detectedProjectLanguages).toEqual(
                expect.arrayContaining(["docker", "python", "typescript"]),
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
        const diagnostics = syntaxHighlighterDiagnostics();
        expect(diagnostics.loadedLanguages).toEqual(
            expect.arrayContaining(["markdown", "typescript"]),
        );
        expect(diagnostics.dynamicLanguages).toEqual(["typescript"]);
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

        await initializeSyntaxHighlighting({ PI_GLOWUP_SYNTAX: "off" });

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
