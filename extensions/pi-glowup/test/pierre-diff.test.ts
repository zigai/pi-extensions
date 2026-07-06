import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
    buildLargeDiffSummaryPayload,
    buildPierreDiffPayload,
    buildUnifiedDiffRows,
    createWriteSnapshot,
} from "../src/pierre-diff.ts";
import {
    clearQueuedDiffHighlights,
    renderPierreDiff,
    shouldRenderSideBySideDiff,
} from "../src/pierre-diff-renderer.ts";
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

    it("summarizes Pierre payloads when snapshot capture was not safe", () => {
        const payload = buildPierreDiffPayload({
            path: "large.txt",
            oldContent: "",
            newContent: "changed",
            oldSizeBytes: 800_000,
            newSizeBytes: 7,
            canBuildPierreDiff: false,
            summaryReason: "too-large",
        });

        expect(payload?.kind).toBe("summary");
        expect(payload?.path).toBe("large.txt");
        expect(payload?.stats.sizeBytes).toBe(800_007);
    });

    it("summarizes large built-in diff text with exact stats", () => {
        const diffText =
            [
                "+1 added",
                "-2 removed",
                ...Array.from({ length: 4_998 }, (_value, index) => ` ${index + 3} context`),
            ].join("\n") + "\n";

        const payload = buildLargeDiffSummaryPayload({ path: "large.patch", diffText });

        expect(payload?.kind).toBe("summary");
        expect(payload?.stats.added).toBe(1);
        expect(payload?.stats.removed).toBe(1);
        expect(payload?.stats.lineCount).toBe(5_001);
        expect(payload?.stats.sizeBytes).toBe(Buffer.byteLength(diffText, "utf8"));
    });

    it("renders oversized Pierre payloads as compact summaries", () => {
        const payload = buildPierreDiffPayload({
            path: "large.txt",
            oldContent: "",
            newContent: `${"x".repeat(80)}\n`.repeat(5_001),
            oldSizeBytes: 0,
            newSizeBytes: 405_081,
            canBuildPierreDiff: true,
        });
        if (payload === undefined) {
            throw new Error("expected Pierre summary payload");
        }

        const rendered = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        )
            .render(120)
            .map(stripAnsi)
            .join("\n");

        expect(payload.kind).toBe("summary");
        expect(rendered).toContain("large.txt");
        expect(rendered).toContain("Large diff omitted");
        expect(rendered).toContain("5,001 lines");
    });

    it("keeps unreadable existing files out of create-style write diffs", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-codex-look-diff-"));
        const filePath = join(root, "secret.txt");
        writeFileSync(filePath, "secret\n");
        chmodSync(filePath, 0);

        try {
            try {
                readFileSync(filePath, "utf8");
                return;
            } catch {
                // Expected on platforms that enforce the chmod above.
            }

            const payload = buildPierreDiffPayload(
                await createWriteSnapshot(root, "secret.txt", "replacement\n"),
            );
            const rendered = renderPierreDiff(
                payload ?? {
                    version: 1,
                    kind: "summary",
                    path: "secret.txt",
                    stats: { added: 0, removed: 0, lineCount: 0, sizeBytes: 0 },
                    summary: { reason: "not-readable", maxLines: 1, maxBytes: 1 },
                },
                testTheme,
                { expanded: true },
                { lastComponent: undefined, invalidate() {} },
            )
                .render(120)
                .map(stripAnsi)
                .join("\n");

            expect(payload?.kind).toBe("summary");
            expect(payload?.kind === "summary" ? payload.summary.reason : undefined).toBe(
                "not-readable",
            );
            expect(rendered).toContain("could not be read safely");
            expect(rendered).not.toContain("Large diff omitted");
        } finally {
            chmodSync(filePath, 0o600);
        }
    });

    it("switches side-by-side rendering for wide terminals", () => {
        expect(shouldRenderSideBySideDiff(139)).toBe(false);
        expect(shouldRenderSideBySideDiff(140)).toBe(true);
        expect(shouldRenderSideBySideDiff(180)).toBe(true);
    });

    it("keeps cached rendered lines across identical expanded component updates", () => {
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
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        );
        const firstLines = component.render(80);
        const reused = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: component },
        );
        const secondLines = reused.render(80);

        expect(reused).toBe(component);
        expect(secondLines).toBe(firstLines);
        expect(secondLines).toEqual(firstLines);
    });

    it("rerenders a cached expanded diff side-by-side after the terminal widens", () => {
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
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        );
        const narrow = component.render(80);
        const wide = component.render(180);

        expect(stripAnsi(narrow.join("\n"))).not.toContain(" │ ");
        expect(stripAnsi(wide.join("\n"))).toContain(" │ ");
        expectLinesWithinWidth(narrow, 80);
        expectLinesWithinWidth(wide, 180);
    });

    it("clears deferred diff highlight timers during shutdown cleanup", () => {
        vi.useFakeTimers();
        try {
            const payload = buildPierreDiffPayload({
                path: "src/example.ts",
                oldContent: "alpha\nold\nomega\n",
                newContent: "alpha\nnew\nomega\n",
                oldSizeBytes: 16,
                newSizeBytes: 16,
                canBuildPierreDiff: true,
            });
            if (payload?.kind !== "renderable") {
                throw new Error("expected renderable Pierre payload");
            }

            renderPierreDiff(
                payload,
                testTheme,
                { expanded: true },
                { lastComponent: undefined, invalidate() {} },
            );

            expect(vi.getTimerCount()).toBeGreaterThan(0);

            clearQueuedDiffHighlights();

            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
            clearQueuedDiffHighlights();
        }
    });

    it("renders side-by-side whenever width has room", () => {
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
        expect(stripAnsi(collapsedWide.join("\n"))).toContain("expand to inspect");
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
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable Pierre payload");
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
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable Pierre payload");
        }

        await loadHighlightedDiff(payload.metadata);
        const component = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
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
            { expanded: true },
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
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        ).render(width);

        expect(lines.length).toBeGreaterThan(1);
        expect(lines.some((line) => stripAnsi(line).trimEnd() === "   2")).toBe(true);
        expect(lines.every((line) => visibleWidth(line) < width)).toBe(true);
    });
});
