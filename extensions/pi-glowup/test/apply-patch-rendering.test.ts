import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";

const plainTheme: CodexRenderTheme = {
    fg(_token: string, text: string): string {
        return text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

const renderContext = {
    args: {},
    toolCallId: "call-apply-patch",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
};

const samplePatch = `*** Begin Patch
*** Update File: README.md
@@
-old heading
+new heading
*** Add File: src/new.ts
+export const answer = 42;
+console.log(answer);
*** End Patch`;

function expectLinesWithinWidth(lines: ReadonlyArray<string>, width: number): void {
    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
}

describe("apply_patch renderer", () => {
    it("renders a Codex-style patch summary and per-file diff", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch");
        const lines = renderer
            .renderCall({ patch: samplePatch }, plainTheme, renderContext)
            .render(100);
        const rendered = lines.join("\n");

        expect(rendered).toContain("• Edited 2 files (+3 -1)");
        expect(rendered).toContain("  └ README.md (+1 -1)");
        expect(rendered).toContain("  └ src/new.ts (+2 -0)");
        expect(rendered).toContain("-old heading");
        expect(rendered).toContain("+new heading");
        expect(rendered).toContain("+export const answer = 42;");
        expectLinesWithinWidth(lines, 100);
    });

    it("leaves successful results empty when the call already rendered the patch", () => {
        const renderer = createThirdPartyToolRenderer("pi-codex-core__apply_patch");
        const result = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: "Success. Updated the following files:\nM README.md\n",
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args: { patch: samplePatch } },
            )
            .render(80);

        expect(result).toEqual([]);
    });

    it("renders failed applications with the Codex failure title", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch");
        const lines = renderer
            .renderResult(
                { content: [{ type: "text", text: "Invalid patch: missing header" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args: { patch: "bad" }, isError: true },
            )
            .render(80);
        const rendered = lines.join("\n");

        expect(rendered).toContain("✘ Failed to apply patch");
        expect(rendered).toContain("Invalid patch: missing header");
        expectLinesWithinWidth(lines, 80);
    });

    it("keeps incomplete streaming patch calls on the cheap fallback path", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch");
        const partialPatch = `${samplePatch.replace("*** End Patch", "")}\n${"+extra\n".repeat(1_000)}`;
        const lines = renderer
            .renderCall({ patch: partialPatch }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100);
        const rendered = lines.join("\n");

        expect(rendered).toContain("• Editing patch (+0 -0)");
        expect(rendered).not.toContain("README.md");
        expect(rendered).not.toContain("+extra");
        expectLinesWithinWidth(lines, 100);
    });

    it("keeps oversized completed patch calls on the cheap fallback path", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch");
        const largePatch = `*** Begin Patch\n*** Add File: huge.txt\n${"+line\n".repeat(20_000)}*** End Patch`;
        const lines = renderer
            .renderCall({ patch: largePatch }, plainTheme, renderContext)
            .render(100);
        const rendered = lines.join("\n");

        expect(rendered).toContain("• Edited 20003 patch lines (+0 -0)");
        expect(rendered).not.toContain("huge.txt");
        expect(rendered).not.toContain("+line");
        expectLinesWithinWidth(lines, 100);
    });
});
