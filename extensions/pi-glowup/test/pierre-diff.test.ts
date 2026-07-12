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
    createEditSnapshot,
    createWriteSnapshot,
} from "../src/diffs/diff.ts";
import {
    clearQueuedDiffHighlights,
    renderPierreDiff,
    shouldRenderSideBySideDiff,
} from "../src/diffs/renderer.ts";
import { loadHighlightedDiff } from "../src/diffs/highlight.ts";
import { pairReplacementLines } from "../src/diffs/layout.ts";
import { getPierreAppearance, getPierrePalette } from "../src/diffs/theme.ts";
import type { UnifiedDiffRow } from "../src/diffs/types.ts";
import { configureRenderingAppearance } from "../src/rendering/core.ts";

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
    it("uses the bundled syntax theme appearance instead of the Pi theme name", () => {
        const misleadingTheme = new Theme(fgColors, bgColors, "truecolor", {
            name: "custom-light",
        });

        expect(getPierreAppearance(misleadingTheme)).toBe("dark");
    });

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

    it("builds a replayable edit diff from pre- and post-execution snapshots", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-codex-look-edit-snapshot-"));
        const filePath = join(root, "sample.ts");
        writeFileSync(filePath, "const limit = 2000;\n");
        const snapshot = await createEditSnapshot(root, "sample.ts");

        writeFileSync(filePath, "const limit = 4000;\n");
        const payload = buildPierreDiffPayload(await snapshot.finish());

        expect(payload?.kind).toBe("renderable");
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable edit snapshot");
        }
        expect(payload.stats).toMatchObject({ added: 1, removed: 1 });
        expect(payload.metadata.deletionLines).toContain("const limit = 2000;\n");
        expect(payload.metadata.additionLines).toContain("const limit = 4000;\n");
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

    it("preserves the fixed 140-column side-by-side policy as an option", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const value = 1;\n",
            newContent: "const value = 2;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        expect(shouldRenderSideBySideDiff(139, payload.metadata, "fixed")).toBe(false);
        expect(shouldRenderSideBySideDiff(140, payload.metadata, "fixed")).toBe(true);
        expect(shouldRenderSideBySideDiff(180, payload.metadata, "fixed")).toBe(true);
    });

    it("uses changed-line fit for content-aware side-by-side selection", () => {
        const shortPayload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const value = 1;\n",
            newContent: "const value = 2;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });
        const longValue = "x".repeat(180);
        const longPayload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: `const value = "${longValue}";\n`,
            newContent: `const value = "${longValue}y";\n`,
            oldSizeBytes: 198,
            newSizeBytes: 199,
            canBuildPierreDiff: true,
        });
        if (shortPayload?.kind !== "renderable" || longPayload?.kind !== "renderable") {
            throw new Error("expected renderable payloads");
        }

        expect(shouldRenderSideBySideDiff(119, shortPayload.metadata, "content-aware")).toBe(false);
        expect(shouldRenderSideBySideDiff(120, shortPayload.metadata, "content-aware")).toBe(true);
        expect(shouldRenderSideBySideDiff(180, longPayload.metadata, "content-aware")).toBe(false);
    });

    it("pairs confidently similar replacement rows in narrow diffs", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: 'const limit = 2000;\nconst separator = ",";\n',
            newContent: 'const limit = 4000;\nconst separator = " | ";\n',
            oldSizeBytes: 45,
            newSizeBytes: 48,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        const rows = buildUnifiedDiffRows(
            payload.metadata,
            { deletionLines: [], additionLines: [] },
            getPierrePalette(testTheme),
            { narrowLayout: "paired" },
        );
        const changed = rows
            .filter(
                (row): row is Extract<UnifiedDiffRow, { readonly kind: "line" }> =>
                    row.kind === "line" && row.lineType !== "context",
            )
            .map((row) => `${row.lineType}:${row.spans.map((span) => span.text).join("")}`);

        expect(changed).toEqual([
            "deletion:const limit = 2000;",
            "addition:const limit = 4000;",
            'deletion:const separator = ",";',
            'addition:const separator = " | ";',
        ]);

        const traditionalTypes = buildUnifiedDiffRows(
            payload.metadata,
            { deletionLines: [], additionLines: [] },
            getPierrePalette(testTheme),
            { narrowLayout: "traditional" },
        )
            .filter((row) => row.kind === "line" && row.lineType !== "context")
            .map((row) => (row.kind === "line" ? row.lineType : "metadata"));
        expect(traditionalTypes).toEqual(["deletion", "deletion", "addition", "addition"]);
    });

    it("declines replacement pairing when line similarity is too low", () => {
        expect(
            pairReplacementLines(["alpha beta", "gamma delta"], ["one two", "three four"]),
        ).toBeUndefined();
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

    it("does not reuse a Pierre component across tool calls", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "old\n",
            newContent: "new\n",
            oldSizeBytes: 4,
            newSizeBytes: 4,
            canBuildPierreDiff: true,
        });
        if (!payload) throw new Error("expected Pierre payload");

        const first = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, toolCallId: "first" },
        );
        const second = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: first, toolCallId: "second" },
        );

        expect(second).not.toBe(first);
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
        expect(stripAnsi(collapsedWide.join("\n"))).toContain(" │ ");
        expect(stripAnsi(collapsedWide.join("\n"))).toContain("old");
        expect(stripAnsi(expandedWide.join("\n"))).toContain(" │ ");
        expectLinesWithinWidth(narrow, 80);
        expectLinesWithinWidth(collapsedWide, 180);
        expectLinesWithinWidth(expandedWide, 180);
    });

    it("keeps collapsed semantic rows to one physical terminal row", () => {
        const payload = buildPierreDiffPayload({
            path: "long.ts",
            oldContent: `${"old ".repeat(100)}\n`,
            newContent: `${"new ".repeat(100)}\n`,
            oldSizeBytes: 401,
            newSizeBytes: 401,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined },
        ).render(40);
        const rendered = stripAnsi(lines.join("\n"));

        expect(lines.length).toBeLessThanOrEqual(7);
        expect(rendered).toContain("old");
        expect(rendered).toContain("new");
        expectLinesWithinWidth(lines, 40);
    });

    it("marks clipped collapsed split-row continuations with an ellipsis", () => {
        const longValue = "x".repeat(140);
        const payload = buildPierreDiffPayload({
            path: "long.ts",
            oldContent: `const value = 1;\nconst context = "${longValue}";\n`,
            newContent: `const value = 2;\nconst context = "${longValue}";\n`,
            oldSizeBytes: longValue.length + 39,
            newSizeBytes: longValue.length + 39,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        const width = 140;
        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined },
        ).render(width);

        expect(lines.some((line) => stripAnsi(line).trimEnd().endsWith("…"))).toBe(true);
        expectLinesWithinWidth(lines, width);
    });

    it("renders collapsed omission metadata only after all visible diff rows", () => {
        const content = Array.from({ length: 40 }, (_value, index) => `line ${index + 1}`).join(
            "\n",
        );
        const payload = buildPierreDiffPayload({
            path: "long.ts",
            oldContent: "",
            newContent: `${content}\n`,
            oldSizeBytes: 0,
            newSizeBytes: Buffer.byteLength(content) + 1,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined },
        )
            .render(80)
            .map(stripAnsi);

        expect(lines.at(-1)).toContain("… +34 lines");
        expect(lines.slice(0, -1).every((line) => !line.includes("… +34 lines"))).toBe(true);
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

        const rendered = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined },
        )
            .render(80)
            .map(stripAnsi);
        expect(rendered.slice(0, -1).every((line) => !line.includes("…"))).toBe(true);
        expect(rendered.at(-1)).toContain("…");
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

        expect(plainLines).toContain("+2");
        expect(plainLines).not.toContain("");
        expect(plainLines[plainLines.indexOf("+2") + 1]).toContain("+3 def greet():");
    });

    it("paints only Pierre intra-line replacement spans without dimming unchanged text by default", async () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const limit = args.limit ?? 2000;\n",
            newContent: "const limit = args.limit ?? 4000;\n",
            oldSizeBytes: 34,
            newSizeBytes: 34,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable Pierre payload");
        }

        await loadHighlightedDiff(payload.metadata);
        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, invalidate() {} },
        ).render(100);
        const deletion = lines.find((line) => stripAnsi(line).includes("2000")) ?? "";
        const addition = lines.find((line) => stripAnsi(line).includes("4000")) ?? "";

        expect(deletion).toContain("48;2;34;0;0");
        expect(addition).toContain("48;2;0;34;0");
        expect(deletion.match(/48;2;34;0;0/gu)).toHaveLength(1);
        expect(addition.match(/48;2;0;34;0/gu)).toHaveLength(1);
        expect(deletion).toContain("\u001b[1m");
        expect(addition).toContain("\u001b[1m");
        expect(deletion).not.toContain("\u001b[2m");
        expect(addition).not.toContain("\u001b[2m");
    });

    it("dims unchanged Pierre replacement text when configured", async () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "changed-spans",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: null,
            deletedRowBackground: null,
            instructionPathColor: null,
            dimUnchangedDiffText: true,
        });
        try {
            const payload = buildPierreDiffPayload({
                path: "src/example.ts",
                oldContent: "const limit = args.limit ?? 2000;\n",
                newContent: "const limit = args.limit ?? 4000;\n",
                oldSizeBytes: 34,
                newSizeBytes: 34,
                canBuildPierreDiff: true,
            });
            if (payload?.kind !== "renderable") {
                throw new Error("expected renderable Pierre payload");
            }

            await loadHighlightedDiff(payload.metadata);
            const lines = renderPierreDiff(
                payload,
                testTheme,
                { expanded: false },
                { lastComponent: undefined, invalidate() {} },
            ).render(100);
            const deletion = lines.find((line) => stripAnsi(line).includes("2000")) ?? "";
            const addition = lines.find((line) => stripAnsi(line).includes("4000")) ?? "";

            expect(deletion).toContain("\u001b[2m");
            expect(addition).toContain("\u001b[2m");
        } finally {
            configureRenderingAppearance({
                diffBackgroundStyle: "changed-spans",
                narrowDiffLayout: "paired",
                sideBySideLayout: "content-aware",
                addedRowBackground: null,
                deletedRowBackground: null,
                instructionPathColor: null,
                dimUnchangedDiffText: false,
            });
        }
    });

    it("keeps an added blank row compact in changed-span mode", () => {
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
        const blankAddition = lines.find((line) => stripAnsi(line).trimEnd() === "+2");

        expect(blankAddition).toBeDefined();
        expect(blankAddition).not.toContain("48;2;0;34;0");
        expect(visibleWidth(blankAddition ?? "")).toBe(width);
    });

    it("keeps full-row Pierre backgrounds as an option", () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "full-row",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: null,
            deletedRowBackground: null,
            instructionPathColor: null,
            dimUnchangedDiffText: false,
        });
        try {
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

            const lines = renderPierreDiff(
                payload,
                testTheme,
                { expanded: true },
                { lastComponent: undefined, invalidate() {} },
            ).render(80);
            const blankAddition = lines.find((line) => stripAnsi(line).trimEnd() === "+2");

            expect(blankAddition).toContain("48;2;0;34;0");
        } finally {
            configureRenderingAppearance({
                diffBackgroundStyle: "changed-spans",
                narrowDiffLayout: "paired",
                sideBySideLayout: "content-aware",
                addedRowBackground: null,
                deletedRowBackground: null,
                instructionPathColor: null,
                dimUnchangedDiffText: false,
            });
        }
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
        expect(lines.some((line) => stripAnsi(line).trimEnd() === " 2")).toBe(true);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    });
});
