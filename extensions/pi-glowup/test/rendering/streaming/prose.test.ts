import { describe, expect, it } from "vitest";
import { revealProse } from "../../../src/rendering/streaming/prose.ts";

// Failure matrix: token transparency; unconfirmed punctuation; abbreviation/decimal;
// Markdown inline code/link punctuation; paragraph/list/heading grouping; final flush.
describe("prose boundaries", () => {
    it("preserves token mode and flushes every final tail", () => {
        for (const mode of ["token", "sentence", "paragraph"] as const) {
            expect(revealProse("unfinished", mode, true)).toBe("unfinished");
        }

        expect(revealProse(" unfinished ", "token", false)).toBe(" unfinished ");
        expect(revealProse("One.", "sentence", false)).toBe("");
        expect(revealProse("One. Next", "sentence", false)).toBe("One. ");
    });

    it("does not split abbreviations, decimals, inline code or links", () => {
        const source = "Dr. Smith uses 3.14 and e.g. `x. y` with [a. b](https://x.y/a). Next";
        expect(revealProse(source, "sentence", false)).toBe(source.slice(0, -4));

        for (const prefix of ["Dr. Smith", "Value 3.14", "Use `x. y", "See [a. b](https://x. y"]) {
            expect(revealProse(prefix, "sentence", false)).toBe("");
        }
    });

    it("releases complete Markdown blocks without requiring terminal punctuation", () => {
        expect(revealProse("- First item\n- Second item", "sentence", false)).toBe(
            "- First item\n",
        );

        expect(
            revealProse("## Heading\n\nBody without punctuation\n\nTail", "sentence", false),
        ).toBe("## Heading\n\nBody without punctuation\n\n");
    });

    it.each([
        ["你好。 下一句", "你好。 "],
        ["完了！次の文", "完了！"],
        ["Ready? Next", "Ready? "],
    ])("reveals Unicode sentence boundaries in %s", (source, expected) => {
        expect(revealProse(source, "sentence", false)).toBe(expected);
    });

    it("groups heading with content and releases individual list items", () => {
        expect(revealProse("# Heading\n\n", "paragraph", false)).toBe("");
        expect(revealProse("# Heading\n\nBody\n\nTail", "paragraph", false)).toBe(
            "# Heading\n\nBody\n\n",
        );

        expect(revealProse("- First\n  continuation\n- Second", "paragraph", false)).toBe(
            "- First\n  continuation\n",
        );

        expect(revealProse("Paragraph\n\nTail", "paragraph", false)).toBe("Paragraph\n\n");
        expect(revealProse("Paragraph\n\u00a0\nTail", "paragraph", false)).toBe("");
    });
});
