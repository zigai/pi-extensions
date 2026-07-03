import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildPierreDiffPayload, buildUnifiedDiffRows } from "../src/pierre-diff.ts";
import { renderPierreDiff, shouldRenderSideBySideDiff } from "../src/pierre-diff-renderer.ts";
import { loadHighlightedDiff } from "../src/pierre-highlight.ts";
import { getPierrePalette } from "../src/pierre-theme.ts";

type ThemeBackgroundColors = ConstructorParameters<typeof Theme>[1];

const fgColors = {
    dim: "#777777",
    muted: "#888888",
    toolDiffAdded: "#00ff00",
    toolDiffContext: "#cccccc",
    toolDiffRemoved: "#ff0000",
} as Record<ThemeColor, string>;
const bgColors = {
    toolErrorBg: "#220000",
    toolSuccessBg: "#002200",
} as ThemeBackgroundColors;
const testTheme = new Theme(fgColors, bgColors, "truecolor", { name: "pierre-dark" });

function expectLinesWithinWidth(lines: ReadonlyArray<string>, width: number): void {
    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
}

function stripAnsi(text: string): string {
    return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}

describe("Pierre diff rendering", () => {
    it("builds compact replayable metadata without storing snapshots", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const value = 1;\n",
            newContent: "const value = 2;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });

        expect(payload?.path).toBe("src/example.ts");
        expect(payload?.stats.added).toBe(1);
        expect(payload?.stats.removed).toBe(1);
        expect(JSON.stringify(payload)).not.toContain("oldContent");
        expect(JSON.stringify(payload)).not.toContain("newContent");
    });

    it("skips Pierre payloads when snapshot capture was not safe", () => {
        const payload = buildPierreDiffPayload({
            path: "large.txt",
            oldContent: "",
            newContent: "changed",
            oldSizeBytes: 800_000,
            newSizeBytes: 7,
            canBuildPierreDiff: false,
        });

        expect(payload).toBeUndefined();
    });

    it("switches side-by-side rendering only for expanded wide terminals", () => {
        expect(shouldRenderSideBySideDiff(139)).toBe(false);
        expect(shouldRenderSideBySideDiff(140)).toBe(true);
        expect(shouldRenderSideBySideDiff(180, false)).toBe(false);
    });

    it("keeps cached rendered lines across identical component updates", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "alpha\nold\nomega\n",
            newContent: "alpha\nnew\nomega\n",
            oldSizeBytes: 16,
            newSizeBytes: 16,
            canBuildPierreDiff: true,
        });
        if (!payload) {
            throw new Error("expected Pierre payload");
        }

        const component = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, invalidate() {} },
        );
        const firstLines = component.render(80);
        const reused = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: component },
        );
        const secondLines = reused.render(80);

        expect(reused).toBe(component);
        expect(secondLines).toBe(firstLines);
        expect(secondLines).toEqual(firstLines);
    });

    it("renders inline unless expanded width has room for side-by-side", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "alpha\nold\nomega\n",
            newContent: "alpha\nnew\nomega\n",
            oldSizeBytes: 16,
            newSizeBytes: 16,
            canBuildPierreDiff: true,
        });
        if (!payload) {
            throw new Error("expected Pierre payload");
        }

        const context = { lastComponent: undefined, invalidate() {} };
        const narrow = renderPierreDiff(payload, testTheme, { expanded: true }, context).render(80);
        const collapsedWide = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            context,
        ).render(180);
        const expandedWide = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            context,
        ).render(180);

        expect(stripAnsi(narrow.join("\n"))).not.toContain(" │ ");
        expect(stripAnsi(collapsedWide.join("\n"))).not.toContain(" │ ");
        expect(stripAnsi(expandedWide.join("\n"))).toContain(" │ ");
        expectLinesWithinWidth(narrow, 80);
        expectLinesWithinWidth(collapsedWide, 180);
        expectLinesWithinWidth(expandedWide, 180);
    });

    it("hides edge collapsed markers but keeps middle collapsed markers", () => {
        const oldLines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
        const newLines = [...oldLines];
        newLines[19] = "changed line 20";
        newLines[79] = "changed line 80";
        const payload = buildPierreDiffPayload({
            path: "src/example.txt",
            oldContent: `${oldLines.join("\n")}\n`,
            newContent: `${newLines.join("\n")}\n`,
            oldSizeBytes: oldLines.join("\n").length + 1,
            newSizeBytes: newLines.join("\n").length + 1,
            canBuildPierreDiff: true,
        });
        if (!payload) {
            throw new Error("expected Pierre payload");
        }

        const rows = buildUnifiedDiffRows(
            payload.metadata,
            { deletionLines: [], additionLines: [] },
            getPierrePalette(testTheme),
        );

        expect(rows[0]?.kind).not.toBe("collapsed");
        expect(rows.at(-1)?.kind).not.toBe("collapsed");
        expect(rows.some((row) => row.kind === "collapsed")).toBe(true);
    });

    it("renders source blank lines as one compact numbered row after highlighting", async () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.py",
            oldContent: "",
            newContent: "from pathlib import Path\n\ndef greet():\n    return 'hello'\n",
            oldSizeBytes: 0,
            newSizeBytes: 58,
            canBuildPierreDiff: true,
        });
        if (!payload) {
            throw new Error("expected Pierre payload");
        }

        await loadHighlightedDiff(payload.metadata);
        const component = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, invalidate() {} },
        );
        const plainLines = component.render(100).map((line) => stripAnsi(line).trimEnd());

        expect(plainLines).toContain("+  2");
        expect(plainLines).not.toContain("");
        expect(plainLines[plainLines.indexOf("+  2") + 1]).toContain("+  3 def greet():");
    });

    it("fills added blank rows with the insertion background", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.py",
            oldContent: "alpha\nomega\n",
            newContent: "alpha\n\nomega\n",
            oldSizeBytes: 12,
            newSizeBytes: 13,
            canBuildPierreDiff: true,
        });
        if (!payload) {
            throw new Error("expected Pierre payload");
        }

        const width = 80;
        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, invalidate() {} },
        ).render(width);
        const blankAddition = lines.find((line) => stripAnsi(line).trimEnd() === "+  2");

        expect(blankAddition).toBeDefined();
        expect(blankAddition).toContain("48;2;0;34;0");
        expect(visibleWidth(blankAddition ?? "")).toBe(width - 1);
    });

    it("keeps context blank rows compact to avoid autowrap blanks", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.py",
            oldContent: "from pathlib import Path\n\n\ndef greet():\n    return 'hello'\n",
            newContent: "from pathlib import Path\n\n\ndef greet():\n    return 'hello!'\n",
            oldSizeBytes: 58,
            newSizeBytes: 59,
            canBuildPierreDiff: true,
        });
        if (!payload) {
            throw new Error("expected Pierre payload");
        }

        const width = 80;
        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, invalidate() {} },
        ).render(width);

        expect(lines.length).toBeGreaterThan(1);
        expect(lines.some((line) => stripAnsi(line).trimEnd() === "   2")).toBe(true);
        expect(lines.every((line) => visibleWidth(line) < width)).toBe(true);
    });
});
