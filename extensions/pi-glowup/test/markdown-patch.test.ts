import { describe, expect, it } from "vitest";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { configureMarkdownSyntaxPatch } from "../src/syntax/markdown-patch.ts";

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

function isMarkdownThemeWithHighlight(value: unknown): value is MarkdownTheme & {
    readonly highlightCode: NonNullable<MarkdownTheme["highlightCode"]>;
} {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "highlightCode") === "function"
    );
}

describe("markdown syntax patch", () => {
    it("restores the original render method when disabled", () => {
        const prototype = {
            render(): string[] {
                return ["original"];
            },
        };
        const originalRender = Reflect.get(prototype, "render");

        configureMarkdownSyntaxPatch(true, prototype);
        configureMarkdownSyntaxPatch(false, prototype);

        expect(Reflect.get(prototype, "render")).toBe(originalRender);
    });

    it("does not clobber render wrappers installed later", () => {
        const prototype: { render(width: number): string[] } = {
            render(_width: number): string[] {
                return ["original"];
            },
        };
        configureMarkdownSyntaxPatch(true, prototype);
        const originalRender = Reflect.get(prototype, "render");
        if (typeof originalRender !== "function") {
            throw new Error("expected Glowup markdown wrapper");
        }
        prototype.render = function renderWithLaterWrapper(width: number): string[] {
            return originalRender.call(this, width);
        };
        const laterRender = Reflect.get(prototype, "render");

        configureMarkdownSyntaxPatch(false, prototype);

        expect(Reflect.get(prototype, "render")).toBe(laterRender);
        expect(prototype.render(80)).toEqual(["original"]);
    });

    it("temporarily injects one shared highlighter into fresh Markdown theme objects", () => {
        const highlightedFunctions: Array<NonNullable<MarkdownTheme["highlightCode"]>> = [];
        const prototype = {
            render(this: object, _width: number): string[] {
                const theme = Reflect.get(this, "theme");
                if (isMarkdownThemeWithHighlight(theme)) {
                    highlightedFunctions.push(theme.highlightCode);
                }
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
            render(this: object, _width: number): string[] {
                const renderTheme = Reflect.get(this, "theme");
                if (!isMarkdownThemeWithHighlight(renderTheme)) {
                    return ["missing highlighter"];
                }
                return renderTheme.highlightCode("code", "ts");
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
