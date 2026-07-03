import { describe, expect, it } from "vitest";
import { configureMarkdownSyntaxPatch } from "../src/syntax/markdown-patch.ts";

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
        const codexRender = Reflect.get(prototype, "render");
        if (typeof codexRender !== "function") {
            throw new Error("expected Codex-look markdown wrapper");
        }
        prototype.render = function renderWithLaterWrapper(width: number): string[] {
            return codexRender.call(this, width);
        };
        const laterRender = Reflect.get(prototype, "render");

        configureMarkdownSyntaxPatch(false, prototype);

        expect(Reflect.get(prototype, "render")).toBe(laterRender);
        expect(prototype.render(80)).toEqual(["original"]);
    });
});
