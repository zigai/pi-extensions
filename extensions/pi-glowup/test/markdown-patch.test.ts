import { describe, expect, it } from "vitest";
import { configureMarkdownSyntaxPatch } from "../src/syntax/markdown-patch.ts";

describe("markdown syntax patch", () => {
    it("restores the original render method when disabled", () => {
        const prototype = {
            render(): string[] {
                return ["original"];
            },
        };
        const originalRender = prototype.render;

        configureMarkdownSyntaxPatch(true, prototype);
        configureMarkdownSyntaxPatch(false, prototype);

        expect(prototype.render).toBe(originalRender);
    });
});
