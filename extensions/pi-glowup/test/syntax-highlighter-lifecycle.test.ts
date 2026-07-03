import { afterEach, describe, expect, it } from "vitest";
import {
    disposeSyntaxHighlighting,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    isSyntaxHighlightingReady,
} from "../src/syntax/highlighter.ts";

describe("syntax highlighter lifecycle", () => {
    afterEach(async () => {
        await disposeSyntaxHighlighting();
    });

    it("disposes and resets highlighter state between sessions", async () => {
        await initializeSyntaxHighlighting();
        expect(isSyntaxHighlightingReady()).toBe(true);
        expect(highlightSyntaxCode("const value = 1;", "typescript").join("\n")).toContain(
            "\u001b[",
        );

        await disposeSyntaxHighlighting();

        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(highlightSyntaxCode("const value = 1;", "typescript")).toEqual([
            "const value = 1;",
        ]);

        await initializeSyntaxHighlighting({ PI_CODEX_LOOK_SYNTAX: "off" });

        expect(isSyntaxHighlightingReady()).toBe(false);
        expect(highlightSyntaxCode("const value = 1;", "typescript")).toEqual([
            "const value = 1;",
        ]);
    });
});
