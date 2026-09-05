import { describe, expect, it } from "vitest";
import {
    appendGraphemeEllipsis,
    hasNonWhitespaceText,
    normalizedCodeLines,
    neutralizeTerminalControls,
    takeGraphemePrefix,
    takeGraphemeSuffix,
    truncateGraphemeText,
    truncateUtf8ByGrapheme,
} from "../src/text-boundaries.ts";

function expectWellFormed(text: string): void {
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
}

describe("text boundaries", () => {
    it("uses ECMAScript whitespace membership without state between calls", () => {
        const whitespace =
            "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
        expect(hasNonWhitespaceText("")).toBe(false);
        expect(hasNonWhitespaceText(whitespace)).toBe(false);
        for (const text of ["x", "\u200b", "\ud800", "\udc00", "🧪"]) {
            expect(hasNonWhitespaceText(`${whitespace}${text}${whitespace}`)).toBe(true);
            expect(hasNonWhitespaceText(text)).toBe(true);
            expect(hasNonWhitespaceText(whitespace)).toBe(false);
        }
    });

    it.each([
        ["", [""]],
        ["\n", [""]],
        ["a\r\nb\rc\n", ["a", "b", "c"]],
        ["a\n\n", ["a", ""]],
        ["  a  \r\n\r\n", ["  a  ", ""]],
    ])("normalizes code line boundaries for %j", (code, expected) => {
        expect(normalizedCodeLines(code)).toEqual(expected);
    });

    it("keeps extended emoji graphemes intact at prefix and suffix limits", () => {
        const family = "👨‍👩‍👧‍👦";
        const text = `aaaa${family}z`;

        expect(takeGraphemePrefix(text, 5)).toBe("aaaa");
        expect(takeGraphemeSuffix(text, 5)).toBe("z");
        expect(truncateGraphemeText(text, 6)).toBe("aaaa…");
        expect(appendGraphemeEllipsis(text, 6)).toBe("aaaa…");
    });

    it("withholds a trailing incomplete surrogate from streaming prefixes", () => {
        const splitEmoji = `prefix ${"🧪".slice(0, 1)}`;

        const prefix = takeGraphemePrefix(splitEmoji, splitEmoji.length);

        expect(prefix).toBe("prefix ");
        expectWellFormed(prefix);
    });

    it("honors UTF-8 byte limits without splitting an extended grapheme", () => {
        const family = "👨‍👩‍👧‍👦";
        const text = `aaaa${family}z`;

        const truncated = truncateUtf8ByGrapheme(text, 10);

        expect(truncated).toBe("aaaa");
        expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(10);
        expectWellFormed(truncated);
    });

    it("neutralizes terminal controls while retaining SGR styles", () => {
        const text = "before\u001b[31mred\u001b[0m\u001b[2J\u001b]2;owned\u0007\tend\u007f\u009b";

        const sanitized = neutralizeTerminalControls(text);

        expect(sanitized).toContain("\u001b[31mred\u001b[0m");
        expect(sanitized).toContain("␛[2J␛]2;owned␇ end␡‹9B›");
        expect(sanitized).not.toContain("\u001b[2J");
        expect(sanitized).not.toContain("\u0007");
        expect(sanitized).not.toContain("\t");
    });

    it("does not trust unbounded numeric SGR sequences", () => {
        const oversizedSgr = `\u001b[${"1;".repeat(40)}1mtext`;

        const sanitized = neutralizeTerminalControls(oversizedSgr);

        expect(sanitized).toContain("␛[");
        expect(sanitized).not.toContain("\u001b[");
    });
});
