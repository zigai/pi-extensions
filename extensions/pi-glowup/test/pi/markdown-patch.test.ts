import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import {
    initializeSyntaxHighlighting,
    disposeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../src/rendering/syntax/highlighter.ts";
import { configureMarkdownSyntaxPatch } from "../../src/pi/patches/markdown-syntax.ts";

function makeMarkdownTheme(): MarkdownTheme {
    return {
        heading: (text) => text,
        link: (text) => text,
        linkUrl: (text) => text,
        code: (text) => text,
        codeBlock: (text) => text,
        codeBlockBorder: (text) => text,
        quote: (text) => text,
        quoteBorder: (text) => text,
        hr: (text) => text,
        listBullet: (text) => text,
        bold: (text) => text,
        italic: (text) => text,
        strikethrough: (text) => text,
        underline: (text) => text,
    };
}

type FakeMarkdownInstance = {
    readonly theme?: MarkdownTheme;
};

describe("markdown syntax patch", () => {
    it("loads and repaints a language not preloaded for a real Markdown fence", async () => {
        onTestFinished(async () => {
            configureMarkdownSyntaxPatch(false);
            await disposeSyntaxHighlighting();
        });
        await initializeSyntaxHighlighting(
            { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
            { preloadLanguages: ["javascript"] },
        );
        configureMarkdownSyntaxPatch(true);
        const markdown = new Markdown(
            "```sql\nSELECT item FROM entries WHERE item = 1;\n```",
            0,
            0,
            makeMarkdownTheme(),
        );
        expect(markdown.render(80).join("\n")).not.toContain("38;2");
        await vi.waitFor(() => expect(markdown.render(80).join("\n")).toContain("38;2"));
    });

    it("repaints a cached real Markdown block after full long-line colors complete", async () => {
        onTestFinished(async () => {
            configureMarkdownSyntaxPatch(false);
            await disposeSyntaxHighlighting();
        });
        await initializeSyntaxHighlighting(
            { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
            { preloadLanguages: ["javascript"] },
        );
        configureMarkdownSyntaxPatch(true);
        const code = `const before = 1;\n/* ${"note ".repeat(1_800)}\nconst hidden = 2;\n*/ const after = 3;`;
        const markdown = new Markdown(
            `\`\`\`javascript\n${code}\n\`\`\``,
            0,
            0,
            makeMarkdownTheme(),
        );
        const first = markdown.render(120).join("\n");
        expect(first).not.toContain("\u001b[38;2;86;156;214mconst");
        await settleSyntaxHighlights();
        const colored = markdown.render(120).join("\n");
        expect(colored).toContain("\u001b[38;2;106;153;85mconst hidden");
        expect(colored).toContain("\u001b[38;2;86;156;214mconst");
        expect(colored).toContain("after");
    });

    it("does not repaint replaced real Markdown source with an obsolete worker result", async () => {
        onTestFinished(async () => {
            configureMarkdownSyntaxPatch(false);
            await disposeSyntaxHighlighting();
        });
        await initializeSyntaxHighlighting(
            { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
            { preloadLanguages: ["javascript"] },
        );
        configureMarkdownSyntaxPatch(true);
        const markdown = new Markdown(
            `\`\`\`javascript\nconst stale = "${"note ".repeat(1_800)}";\n\`\`\``,
            0,
            0,
            makeMarkdownTheme(),
        );
        markdown.render(120);
        markdown.setText("```javascript\nconst fresh = 1;\n```");
        markdown.render(120);
        await settleSyntaxHighlights();
        const colored = markdown.render(120).join("\n");
        expect(colored).toContain("\u001b[38;2;86;156;214mconst");
        expect(colored).toContain("fresh");
        expect(colored).not.toContain("stale");
    });

    it("stops injecting a highlighter when disabled", () => {
        const prototype = {
            render(this: FakeMarkdownInstance): string[] {
                return [this.theme?.highlightCode === undefined ? "no highlighter" : "highlighted"];
            },
        };
        const theme = makeMarkdownTheme();

        configureMarkdownSyntaxPatch(true, prototype);
        expect(prototype.render.call({ theme })).toEqual(["highlighted"]);
        configureMarkdownSyntaxPatch(false, prototype);

        expect(prototype.render.call({ theme })).toEqual(["no highlighter"]);
    });

    it("does not clobber render wrappers installed later", () => {
        const prototype = {
            render(this: FakeMarkdownInstance, _width: number): string[] {
                return [this.theme?.highlightCode === undefined ? "no highlighter" : "highlighted"];
            },
        };
        configureMarkdownSyntaxPatch(true, prototype);
        const wrapped = { ...prototype };
        prototype.render = function renderWithLaterWrapper(
            this: FakeMarkdownInstance,
            width: number,
        ) {
            return ["foreign", ...wrapped.render.call(this, width)];
        };
        const theme = makeMarkdownTheme();
        expect(prototype.render.call({ theme }, 80)).toEqual(["foreign", "highlighted"]);

        configureMarkdownSyntaxPatch(false, prototype);

        expect(prototype.render.call({ theme }, 80)).toEqual(["foreign", "no highlighter"]);
    });

    it("temporarily injects one shared highlighter into fresh Markdown theme objects", () => {
        const highlightedFunctions: Array<NonNullable<MarkdownTheme["highlightCode"]>> = [];
        const prototype = {
            render(this: FakeMarkdownInstance, _width: number): string[] {
                const highlightCode = this.theme?.highlightCode;
                if (highlightCode === undefined) throw new Error("expected injected highlighter");

                highlightedFunctions.push(highlightCode);

                return ["rendered"];
            },
        };
        const themes = Array.from({ length: 20 }, () => makeMarkdownTheme());

        configureMarkdownSyntaxPatch(true, prototype);

        for (const theme of themes) {
            prototype.render.call({ theme }, 80);
        }

        expect(highlightedFunctions).toHaveLength(themes.length);
        expect(themes.every((theme) => theme.highlightCode === undefined)).toBe(true);
    });

    it("restores an existing Markdown theme highlighter after render", () => {
        const originalHighlight: NonNullable<MarkdownTheme["highlightCode"]> = () => ["original"];
        const theme = {
            ...makeMarkdownTheme(),
            highlightCode: originalHighlight,
        };
        const prototype = {
            render(this: FakeMarkdownInstance, _width: number): string[] {
                const highlightCode = this.theme?.highlightCode;
                if (highlightCode === undefined) return ["missing highlighter"];
                return highlightCode("code", "ts");
            },
        };

        configureMarkdownSyntaxPatch(true, prototype);
        const rendered = prototype.render.call({ theme }, 80);
        configureMarkdownSyntaxPatch(false, prototype);

        expect(rendered).toEqual(["code"]);
        expect(theme.highlightCode("test", "ts")).toEqual(["original"]);
        expect(prototype.render.call({ theme }, 80)).toEqual(["original"]);
    });
});
