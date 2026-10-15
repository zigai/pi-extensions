import { describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";
import type { Component } from "@earendil-works/pi-tui";
import { createThirdPartyToolRenderer } from "../../../src/tools/renderers.ts";
import { createPlainTheme } from "../../support/plain-theme.ts";
import {
    clearSyntaxHighlightCache,
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    highlightSyntaxCode,
    highlightSyntaxCodeAsync,
    observeSyntaxHighlightSource,
    settleSyntaxHighlights,
    syntaxHighlightCacheStats,
} from "../../../src/rendering/syntax/highlighter.ts";
import { detectStructuredOutputLanguage } from "../../../src/rendering/syntax/code-component.ts";
import { syntaxLanguageFromFile } from "../../../src/rendering/syntax/language.ts";
import { renderGlowupOutput } from "../../../src/rendering/output.ts";

describe("syntax code component helpers", () => {
    it("repaints completed Codemode long lines and retains multiline grammar state without a global large-code cache", async () => {
        await initializeSyntaxHighlighting(process.env, { preloadLanguages: ["javascript"] });
        let component: Component | undefined;
        const code = `const before = 1;\n/* ${"note ".repeat(1_800)}\nconst hidden = 2;\n*/ const after = "end";`;
        const renderer = createThirdPartyToolRenderer("codemode");
        try {
            const createComponent = (): Component =>
                renderer.renderCall({ code }, createPlainTheme(), {
                    args: { code },
                    toolCallId: "long-code",
                    argsComplete: true,
                    executionStarted: true,
                    isPartial: false,
                    expanded: true,
                    showImages: false,
                    isError: false,
                    result: { content: [] },
                    invalidate: () => {
                        component = createComponent();
                    },
                });
            component = createComponent();
            const render = () => component?.render(12_000).join("\n") ?? "";
            const first = render();
            expect(stripVTControlCharacters(first)).toContain("const hidden = 2;");
            await vi.waitUntil(() => render().includes("\u001b[38;2;106;153;85m/* "));
            const colored = render();
            expect(colored).toContain("\u001b[38;2;106;153;85mconst hidden = 2;");
            expect(colored).toContain("\u001b[38;2;86;156;214mconst");
            expect(
                stripVTControlCharacters(colored)
                    .split("\n")
                    .slice(1)
                    .map((line) => line.replace(/^  │ /u, ""))
                    .join("\n"),
            ).toBe(code);

            expect(syntaxHighlightCacheStats().entries).toBe(0);
        } finally {
            await disposeSyntaxHighlighting();
        }
    });

    it("publishes oversized colors to reconstructed output without repeated completion", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const code = `const entries=[${"1,".repeat(18_000)}1];`;
        let invalidations = 0;
        const invalidate = () => {
            invalidations += 1;
        };

        const render = () =>
            renderGlowupOutput(createPlainTheme(), code, {
                expanded: true,
                dimContent: false,
                prefixFirst: "",
                prefixRest: "",
                syntax: { language: "javascript", invalidate },
            }).render(40_000);
        try {
            expect(render()).toEqual([code]);
            await settleSyntaxHighlights();
            const colored = render();
            expect(colored.join("\n")).toContain("\u001b[38;2;86;156;214mconst");
            expect(colored.map(stripVTControlCharacters)).toEqual([code]);
            expect(Buffer.byteLength(colored.join("\n"))).toBeGreaterThan(512 * 1024);
            expect(render()).toEqual(colored);
            await settleSyntaxHighlights();
            expect(render()).toEqual(colored);
            expect(invalidations).toBe(1);
            expect(syntaxHighlightCacheStats()).toEqual({ entries: 0, bytes: 0 });
        } finally {
            await disposeSyntaxHighlighting();
        }
    });

    it("retains active colors across reusable-cache eviction and rejects obsolete ownership", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const code = 'const active = "retained";';
        let invalidations = 0;
        const invalidate = () => {
            invalidations += 1;
        };

        const current = observeSyntaxHighlightSource(code, invalidate);
        try {
            const colored = await highlightSyntaxCodeAsync(code, "javascript", { invalidate });

            for (let index = 0; index < 101; index += 1) {
                await highlightSyntaxCodeAsync(`const entry = ${index};`, "javascript");
            }

            expect(highlightSyntaxCode(code, "javascript", { invalidate })).toEqual(colored);
            await settleSyntaxHighlights();
            expect(invalidations).toBe(1);
            expect(syntaxHighlightCacheStats().entries).toBe(100);
            expect(syntaxHighlightCacheStats().bytes).toBeLessThanOrEqual(512 * 1024);

            const obsolete = highlightSyntaxCodeAsync(
                `/* ${"old ".repeat(3_000)} */`,
                "javascript",
                {
                    invalidate,
                },
            );
            const replacement = 'const replacement = "fresh";';
            observeSyntaxHighlightSource(replacement, invalidate);
            expect(current()).toBe(false);
            await obsolete;
            const fresh = await highlightSyntaxCodeAsync(replacement, "javascript", { invalidate });
            expect(fresh.map(stripVTControlCharacters)).toEqual([replacement]);
            expect(invalidations).toBe(2);
            clearSyntaxHighlightCache();
            expect(highlightSyntaxCode(replacement, "javascript", { invalidate })).toEqual([
                replacement,
            ]);
            await disposeSyntaxHighlighting();
            await settleSyntaxHighlights();
            expect(highlightSyntaxCode(code, "javascript", { invalidate })).toEqual([code]);
            expect(invalidations).toBe(2);
        } finally {
            await disposeSyntaxHighlighting();
        }
    });

    it("adopts warm cache colors on the owner's first render before reusable eviction", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const code = 'const cached = "visible";';
        let invalidations = 0;
        const invalidate = () => {
            invalidations += 1;
        };

        try {
            const colored = await highlightSyntaxCodeAsync(code, "javascript");
            expect(highlightSyntaxCode(code, "javascript", { invalidate })).toEqual(colored);

            for (let index = 0; index < 101; index += 1) {
                await highlightSyntaxCodeAsync(`const entry = ${index};`, "javascript");
            }

            expect(highlightSyntaxCode(code, "javascript", { invalidate })).toEqual(colored);
            await settleSyntaxHighlights();
            expect(invalidations).toBe(0);
        } finally {
            await disposeSyntaxHighlighting();
        }
    });

    it("cancels worker tokenization without publishing or retaining aborted source", async () => {
        await initializeSyntaxHighlighting(process.env, { preloadLanguages: ["markdown"] });
        clearSyntaxHighlightCache();
        const controller = new AbortController();
        const code = `${"[".repeat(900)}${"x".repeat(900)}${"]".repeat(900)}`;
        try {
            const result = highlightSyntaxCodeAsync(code, "markdown", {
                signal: controller.signal,
            });
            controller.abort();
            expect(await result).toEqual([code]);
            expect(syntaxHighlightCacheStats().entries).toBe(0);
        } finally {
            await disposeSyntaxHighlighting();
        }
    });

    it("detects small structured output languages", () => {
        expect(detectStructuredOutputLanguage('{"ok":true}')).toBe("json");
        expect(detectStructuredOutputLanguage("<root><item /></root>")).toBe("xml");
        expect(detectStructuredOutputLanguage("git status --short")).toBe("bash");
    });

    it.each([
        "rg: /work/sample: IO error",
        "git: unknown command",
        "npm ERR! unavailable",
        "npm  ERR! unavailable",
        "node:internal/error",
    ])("keeps command diagnostics plain: %s", (text) => {
        expect(detectStructuredOutputLanguage(text)).toBeUndefined();
    });

    it("skips structured detection for huge outputs", () => {
        const hugeJson = `{${'"value":'.padStart(65 * 1024, " ")}true}`;

        expect(detectStructuredOutputLanguage(hugeJson)).toBeUndefined();
    });

    it.each([
        "#!/usr/bin/python3",
        "#!/usr/bin/env python3",
        "#!/usr/bin/env -S python3 -u",
        "#!/usr/bin/env -S uv run --script",
    ])("detects Python from an extensionless script shebang: %s", (shebang) => {
        expect(syntaxLanguageFromFile("bin/serve-model", `${shebang}\nprint('ready')\n`)).toBe(
            "python",
        );
    });

    it.each([
        ["#!/bin/sh", "bash"],
        ["#!/usr/bin/env -S bash -eu", "bash"],
        ["#!/usr/bin/env zsh", "zsh"],
        ["#!/usr/bin/fish", "fish"],
        ["#!/usr/bin/env node", "javascript"],
        ["#!/usr/bin/env ts-node", "typescript"],
        ["#!/usr/bin/env ruby", "ruby"],
        ["#!/usr/bin/env perl", "perl"],
        ["#!/usr/bin/env php", "php"],
        ["#!/usr/bin/env lua", "lua"],
        ["#!/usr/bin/env pwsh", "powershell"],
    ])("detects common extensionless script shebang %s as %s", (shebang, language) => {
        expect(syntaxLanguageFromFile("bin/script", `${shebang}\nrun\n`)).toBe(language);
    });

    it("skips env options, variable assignments, and unset arguments", () => {
        expect(
            syntaxLanguageFromFile(
                "bin/script",
                "#!/usr/bin/env -i -u OLD_MODE MODE=ci bash -eu\necho ready\n",
            ),
        ).toBe("bash");
    });

    it("prefers a recognized file extension over the shebang", () => {
        expect(
            syntaxLanguageFromFile("bin/example.sh", "#!/usr/bin/python3\nprint('ready')\n"),
        ).toBe("bash");
    });
});
