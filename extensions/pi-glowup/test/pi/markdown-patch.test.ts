import { describe, expect, it } from "vitest";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
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
    it("restores the original render method when disabled", () => {
        const prototype = {
            render: (): string[] => ["original"],
        };
        const originalRender = prototype.render;

        configureMarkdownSyntaxPatch(true, prototype);
        configureMarkdownSyntaxPatch(false, prototype);

        expect(prototype.render).toBe(originalRender);
    });

    it("does not clobber render wrappers installed later", () => {
        const prototype = {
            render: (_width: number): string[] => ["original"],
        };
        configureMarkdownSyntaxPatch(true, prototype);
        const originalRender = prototype.render;
        prototype.render = (width: number): string[] => originalRender(width);
        const laterRender = prototype.render;

        configureMarkdownSyntaxPatch(false, prototype);

        expect(prototype.render).toBe(laterRender);
        expect(prototype.render(80)).toEqual(["original"]);
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

        expect(new Set(highlightedFunctions).size).toBe(1);
        const firstHighlight = highlightedFunctions[0];
        if (firstHighlight === undefined) {
            throw new Error("expected Markdown themes to receive a shared highlight function");
        }
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
        expect(theme.highlightCode).toBe(originalHighlight);
        expect(prototype.render.call({ theme }, 80)).toEqual(["original"]);
    });
});
