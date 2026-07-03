import { describe, expect, it } from "vitest";
import { detectStructuredOutputLanguage } from "../src/syntax/code-component.ts";

describe("syntax code component helpers", () => {
    it("detects small structured output languages", () => {
        expect(detectStructuredOutputLanguage('{"ok":true}')).toBe("json");
        expect(detectStructuredOutputLanguage("<root><item /></root>")).toBe("xml");
        expect(detectStructuredOutputLanguage("git status --short")).toBe("bash");
    });

    it("skips structured detection for huge outputs", () => {
        const hugeJson = `{${'"value":'.padStart(65 * 1024, " ")}true}`;

        expect(detectStructuredOutputLanguage(hugeJson)).toBeUndefined();
    });
});
