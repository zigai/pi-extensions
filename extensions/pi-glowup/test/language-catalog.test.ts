import { bundledLanguages, bundledLanguagesAlias } from "shiki";
import { describe, expect, it } from "vitest";

import { BUNDLED_SYNTAX_LANGUAGE_NAMES } from "../src/syntax/bundled-language-names.ts";
import { isBundledSyntaxLanguage } from "../src/syntax/language.ts";

function sorted(values: Iterable<string>): string[] {
    return [...values].sort();
}

describe("startup-safe Shiki language catalog", () => {
    it("matches every installed Shiki language and alias without importing Shiki at startup", () => {
        const expected = new Set([
            ...Object.keys(bundledLanguages),
            ...Object.keys(bundledLanguagesAlias),
        ]);
        expect(sorted(BUNDLED_SYNTAX_LANGUAGE_NAMES)).toEqual(sorted(expected));
        for (const name of expected) expect(isBundledSyntaxLanguage(name)).toBe(true);
        expect(isBundledSyntaxLanguage("not-a-shiki-language")).toBe(false);
    });
});
