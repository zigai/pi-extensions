import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildLargeDiffSummaryPayload,
    buildPierreDiffPayload,
    buildPierreDiffPayloadsFromPatch,
    buildUnifiedDiffRows,
    createEditSnapshot,
} from "../src/diffs/diff.ts";
import {
    clearQueuedDiffHighlights,
    getPierreDiffPayloadFromDetails,
    pierreDiffHighlightStats,
    renderPierreDiff,
    shouldRenderSideBySideDiff,
} from "../src/diffs/renderer.ts";
import {
    cleanDiffLine,
    flattenHighlightedLine,
    loadHighlightedDiff,
} from "../src/diffs/highlight.ts";
import { pairReplacementLines } from "../src/diffs/layout.ts";
import { getPierreAppearance, getPierrePalette } from "../src/diffs/theme.ts";
import type { UnifiedDiffRow } from "../src/diffs/types.ts";
import { configureRenderingAppearance } from "../src/rendering/core.ts";
import { stringParser } from "../src/json-scalar.ts";
import { reinitializeSyntaxHighlighting } from "../src/syntax/highlighter.ts";
import { VirtualTerminal } from "./support/virtual-terminal.ts";

function createReadCountingArray(lines: string[]) {
    let count = 0;
    const proxy = new Proxy(lines, {
        get(target, prop) {
            if (stringParser.parse(prop) !== undefined && !Number.isNaN(Number(prop))) {
                count += 1;
            }
            // SAFETY: Array index property lookup on target array.
            return target[Number(prop)] ?? "";
        },
    });
    return { array: proxy, accessCount: () => count };
}
import { DEFAULT_MUTATION_SETTINGS } from "../src/mutations/settings.ts";
import {
    TEST_THEME_BACKGROUND_COLORS,
    TEST_THEME_COLORS,
    type TestThemeBackgroundColors,
} from "./support/theme-colors.ts";

const fgColors = {
    ...TEST_THEME_COLORS,
    text: "#cccccc",
    dim: "#777777",
    muted: "#888888",
    thinkingXhigh: "#777777",
    toolDiffAdded: "#00ff00",
    toolDiffContext: "#cccccc",
    toolDiffRemoved: "#ff0000",
} satisfies Record<ThemeColor, string>;
const bgColors = {
    ...TEST_THEME_BACKGROUND_COLORS,
    toolErrorBg: "#220000",
    toolSuccessBg: "#002200",
} satisfies TestThemeBackgroundColors;
const testTheme = new Theme(fgColors, bgColors, "truecolor", { name: "pierre-dark" });
const defaultAppearance = {
    diffBackgroundStyle: "two-tone",
    diffLineNumberStyle: "dual",
    narrowDiffLayout: "paired",
    sideBySideLayout: "content-aware",
    addedRowBackground: null,
    deletedRowBackground: null,
    addedContentBackground: null,
    deletedContentBackground: null,
    instructionPathColor: null,
    dimUnchangedDiffText: false,
} as const;

function expectLinesWithinWidth(lines: ReadonlyArray<string>, width: number): void {
    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
}

function stripAnsi(text: string): string {
    return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"), "");
}

describe("Pierre diff rendering", () => {
    beforeEach(() => configureRenderingAppearance(defaultAppearance));

    it("accepts valid persisted summaries and rejects malformed payload details", () => {
        const validSummary = {
            version: 1,
            kind: "summary",
            path: "src/large.ts",
            stats: { added: 4, removed: 2, lineCount: 6, sizeBytes: 4_096 },
            summary: { reason: "too-large", maxLines: 1_000, maxBytes: null },
        };

        expect(getPierreDiffPayloadFromDetails({ pierreDiff: validSummary })).toMatchObject(
            validSummary,
        );
        expect(
            getPierreDiffPayloadFromDetails({
                pierreDiff: {
                    ...validSummary,
                    summary: { reason: "unknown", maxLines: 1_000, maxBytes: null },
                },
            }),
        ).toBeUndefined();
        expect(
            getPierreDiffPayloadFromDetails({
                pierreDiff: {
                    ...validSummary,
                    summary: { reason: "too-large", maxLines: -1, maxBytes: null },
                },
            }),
        ).toBeUndefined();
        expect(getPierreDiffPayloadFromDetails({ pierreDiff: "not-an-object" })).toBeUndefined();
    });

    it("downgrades corrupted restored hunk metadata to a bounded summary", () => {
        const payload = buildPierreDiffPayload({
            path: "src/restored.ts",
            oldContent: "old\n",
            newContent: "new\n",
            oldSizeBytes: 4,
            newSizeBytes: 4,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");
        const restored = structuredClone(payload);
        const firstHunk = restored.metadata.hunks[0];
        if (firstHunk === undefined) throw new Error("expected hunk");
        Reflect.set(firstHunk, "additionCount", Number.MAX_SAFE_INTEGER);

        expect(getPierreDiffPayloadFromDetails({ pierreDiff: restored })).toMatchObject({
            kind: "summary",
            summary: { reason: "metadata-invalid" },
        });
        const normalized = getPierreDiffPayloadFromDetails({ pierreDiff: restored });
        if (normalized === undefined) throw new Error("expected bounded fallback");
        expect(
            stripAnsi(
                renderPierreDiff(
                    normalized,
                    testTheme,
                    { expanded: false },
                    {
                        lastComponent: undefined,
                    },
                )
                    .render(100)
                    .join("\n"),
            ),
        ).toContain("generated diff metadata was invalid");
    });

    it("accepts Pierre's -1 empty-side indexes for new and deleted files", () => {
        const cases = [
            { path: "new.ts", oldContent: "", newContent: "one\ntwo\n", type: "new" },
            { path: "deleted.ts", oldContent: "one\ntwo\n", newContent: "", type: "deleted" },
        ] as const;

        for (const input of cases) {
            const payload = buildPierreDiffPayload({
                ...input,
                oldSizeBytes: Buffer.byteLength(input.oldContent),
                newSizeBytes: Buffer.byteLength(input.newContent),
                canBuildPierreDiff: true,
            });
            expect(payload).toMatchObject({ kind: "renderable", metadata: { type: input.type } });
            const restored = getPierreDiffPayloadFromDetails({
                pierreDiff: structuredClone(payload),
            });
            expect(restored).toMatchObject({
                kind: "renderable",
                metadata: { type: input.type },
            });
        }
    });

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

    it("marks extensionless uv Python script diffs for Python highlighting", () => {
        const oldContent = "#!/usr/bin/env -S uv run --script\nvalue = 1\n";
        const newContent = "#!/usr/bin/env -S uv run --script\nvalue = 2\n";
        const payload = buildPierreDiffPayload({
            path: "bin/serve-model",
            oldContent,
            newContent,
            oldSizeBytes: Buffer.byteLength(oldContent),
            newSizeBytes: Buffer.byteLength(newContent),
            canBuildPierreDiff: true,
        });

        expect(payload).toMatchObject({
            kind: "renderable",
            metadata: { lang: "python" },
        });
    });

    it("builds a replayable edit diff from pre- and post-execution snapshots", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-edit-snapshot-"));
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

    it("honors configurable edit snapshot capture limits", async () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-edit-limit-"));
        const filePath = join(root, "sample.ts");
        try {
            writeFileSync(filePath, "const value = 'before';\n");

            const bounded = await createEditSnapshot(root, "sample.ts", {
                maxBytes: 8,
                maxLines: null,
            });
            const unbounded = await createEditSnapshot(root, "sample.ts", {
                maxBytes: null,
                maxLines: null,
            });
            writeFileSync(filePath, "const value = 'after';\n");

            expect(buildPierreDiffPayload(await bounded.finish())?.kind).toBe("summary");
            expect(
                buildPierreDiffPayload(await unbounded.finish(), {
                    maxBytes: null,
                    maxLines: null,
                })?.kind,
            ).toBe("renderable");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
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

    it("renders every available mutation row in the default full view", () => {
        const newContent = Array.from(
            { length: 20 },
            (_value, index) => `export const value${index + 1} = ${index + 1};`,
        ).join("\n");
        const payload = buildPierreDiffPayload({
            path: "src/generated.ts",
            oldContent: "",
            newContent,
            oldSizeBytes: 0,
            newSizeBytes: Buffer.byteLength(newContent, "utf8"),
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        const rendered = stripAnsi(
            renderPierreDiff(
                payload,
                testTheme,
                { expanded: false, mutationSettings: DEFAULT_MUTATION_SETTINGS },
                { lastComponent: undefined },
            )
                .render(100)
                .join("\n"),
        );

        expect(rendered).toContain("value1 = 1");
        expect(rendered).toContain("value10 = 10");
        expect(rendered).toContain("value20 = 20");
        expect(rendered).not.toContain("to expand");
        expect(rendered).not.toContain("more lines");
    });

    it("honors configurable diff byte and line limits", () => {
        const snapshot = {
            path: "src/generated.ts",
            oldContent: "",
            newContent: "one\ntwo\nthree\n",
            oldSizeBytes: 0,
            newSizeBytes: 14,
            canBuildPierreDiff: true,
        } as const;

        expect(buildPierreDiffPayload(snapshot, { maxBytes: null, maxLines: 2 })?.kind).toBe(
            "summary",
        );
        expect(buildPierreDiffPayload(snapshot, { maxBytes: 4, maxLines: null })?.kind).toBe(
            "summary",
        );
        expect(buildPierreDiffPayload(snapshot, { maxBytes: null, maxLines: null })?.kind).toBe(
            "renderable",
        );
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

    it("honors the exact width contract below 24 columns", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const value = 1;\n",
            newContent: "const value = 2;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");

        const component = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        );

        for (const width of [1, 8, 23]) {
            expectLinesWithinWidth(component.render(width), width);
        }

        const summary = buildLargeDiffSummaryPayload({
            path: "large.ts",
            diffText: `${"+1 value\n".repeat(5_001)}`,
        });
        if (summary === undefined) throw new Error("expected summary payload");
        for (const width of [1, 8, 23]) {
            expectLinesWithinWidth(
                renderPierreDiff(
                    summary,
                    testTheme,
                    { expanded: false },
                    { lastComponent: undefined, invalidate() {} },
                ).render(width),
                width,
            );
        }
    });

    it("neutralizes terminal controls embedded in diff content", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const value = 'old';\n",
            newContent: "const value = 'before\u001b[2Jafter\u001b]2;owned\u0007';\n",
            oldSizeBytes: 21,
            newSizeBytes: 42,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");

        const rendered = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        )
            .render(120)
            .join("\n");

        expect(stripAnsi(rendered)).toContain("before␛[2Jafter␛]2;owned␇");
        expect(rendered).not.toContain("\u001b[2J");
        expect(rendered).not.toContain("\u001b]2;owned");
        expect(rendered).not.toContain("\u0007");
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

    it("falls back to unified when the dual-number split gutter would wrap a changed row", () => {
        const before = `${"a".repeat(54)}x\n`;
        const after = `${"a".repeat(54)}y\n`;
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: before,
            newContent: after,
            oldSizeBytes: before.length,
            newSizeBytes: after.length,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        expect(shouldRenderSideBySideDiff(120, payload.metadata, "content-aware")).toBe(false);
        const rendered = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        )
            .render(120)
            .map(stripAnsi);
        expect(rendered.join("\n")).not.toContain(" │ ");
        expect(rendered.every((line) => visibleWidth(line) <= 120)).toBe(true);
    });

    it("falls back to unified when an unchanged context row would wrap in either pane", () => {
        const context = "context-".repeat(8);
        const oldContent = `${context}\nold\nomega\n`;
        const newContent = `${context}\nnew\nomega\n`;
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent,
            newContent,
            oldSizeBytes: oldContent.length,
            newSizeBytes: newContent.length,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");

        expect(shouldRenderSideBySideDiff(120, payload.metadata, "content-aware")).toBe(false);
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

    it("never reuses highlighted source for same-sized replacement content", async () => {
        const firstPayload = buildPierreDiffPayload({
            path: "src/identity.ts",
            oldContent: "return oldValue;\n",
            newContent: "return newValue;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });
        const secondPayload = buildPierreDiffPayload({
            path: "src/identity.ts",
            oldContent: "return fooValue;\n",
            newContent: "return barValue;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });
        if (firstPayload?.kind !== "renderable" || secondPayload?.kind !== "renderable") {
            throw new Error("expected renderable Pierre payloads");
        }
        await loadHighlightedDiff(firstPayload.metadata);
        const component = renderPierreDiff(
            firstPayload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, toolCallId: "identity" },
        );
        expect(stripAnsi(component.render(100).join("\n"))).toContain("newValue");

        const updated = renderPierreDiff(
            secondPayload,
            testTheme,
            { expanded: true },
            { lastComponent: component, toolCallId: "identity" },
        );
        const rendered = stripAnsi(updated.render(100).join("\n"));

        expect(secondPayload.modelKey).not.toBe(firstPayload.modelKey);
        expect(rendered).toContain("barValue");
        expect(rendered).not.toContain("newValue");
    });

    it("bounds a 20,000-line replacement before reading hidden source rows", () => {
        const payload = buildPierreDiffPayload({
            path: "src/huge.ts",
            oldContent: "old\n",
            newContent: "new\n",
            oldSizeBytes: 4,
            newSizeBytes: 4,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");
        const originalHunk = payload.metadata.hunks[0];
        if (originalHunk === undefined) throw new Error("expected hunk");

        const rawDeletions = Array.from({ length: 20_000 }, (_, index) => `old ${index}`);
        const rawAdditions = Array.from({ length: 20_000 }, (_, index) => `new ${index}`);
        const deletionAccess = createReadCountingArray(rawDeletions);
        const additionAccess = createReadCountingArray(rawAdditions);

        const metadata = {
            ...payload.metadata,
            deletionLines: deletionAccess.array,
            additionLines: additionAccess.array,
            splitLineCount: 20_000,
            unifiedLineCount: 40_000,
            hunks: [
                {
                    ...originalHunk,
                    additionCount: 20_000,
                    additionLines: 20_000,
                    deletionCount: 20_000,
                    deletionLines: 20_000,
                    splitLineCount: 20_000,
                    unifiedLineCount: 40_000,
                    hunkContent: [
                        {
                            type: "change" as const,
                            additions: 20_000,
                            deletions: 20_000,
                            additionLineIndex: 0,
                            deletionLineIndex: 0,
                        },
                    ],
                },
            ],
        };
        let builtRows = 0;

        const rows = buildUnifiedDiffRows(
            metadata,
            { deletionLines: [], additionLines: [] },
            getPierrePalette(testTheme),
            {
                maxRows: 6,
                narrowLayout: "paired",
                onRowBuilt() {
                    builtRows += 1;
                },
            },
        );

        expect(rows).toHaveLength(6);
        expect(builtRows).toBe(6);
        expect(deletionAccess.accessCount()).toBeLessThan(20);
        expect(additionAccess.accessCount()).toBeLessThan(20);

        // Verify one-sided addition-only paired diff
        const oneSidedAdditionAccess = createReadCountingArray(rawAdditions);
        const oneSidedMetadata = {
            ...payload.metadata,
            deletionLines: [],
            additionLines: oneSidedAdditionAccess.array,
            splitLineCount: 20_000,
            unifiedLineCount: 20_000,
            hunks: [
                {
                    ...originalHunk,
                    additionCount: 20_000,
                    additionLines: 20_000,
                    deletionCount: 0,
                    deletionLines: 0,
                    splitLineCount: 20_000,
                    unifiedLineCount: 20_000,
                    hunkContent: [
                        {
                            type: "change" as const,
                            additions: 20_000,
                            deletions: 0,
                            additionLineIndex: 0,
                            deletionLineIndex: 0,
                        },
                    ],
                },
            ],
        };
        const oneSidedRows = buildUnifiedDiffRows(
            oneSidedMetadata,
            { deletionLines: [], additionLines: [] },
            getPierrePalette(testTheme),
            { maxRows: 6, narrowLayout: "paired" },
        );
        expect(oneSidedRows).toHaveLength(6);
        expect(oneSidedAdditionAccess.accessCount()).toBeLessThan(20);
    });

    it("expands tabs at terminal stops across token and wide-character boundaries", () => {
        expect(cleanDiffLine("a\tb")).toBe("a   b");
        expect(cleanDiffLine("abc\tb")).toBe("abc b");
        const spans = flattenHighlightedLine(
            {
                type: "element",
                properties: {},
                children: [
                    { type: "text", value: "界" },
                    { type: "text", value: "\tb" },
                ],
            },
            "dark",
            "",
            "",
        );
        expect(spans.map((span) => span.text).join("")).toBe("界  b");
    });

    it("settles empty highlighted metadata without scheduling retries", async () => {
        clearQueuedDiffHighlights();
        const [payload] = buildPierreDiffPayloadsFromPatch(
            "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
            { maxBytes: null, maxLines: null },
        );
        if (payload?.kind !== "renderable") throw new Error("expected rename payload");
        let invalidations = 0;
        const component = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            {
                lastComponent: undefined,
                toolCallId: "rename",
                invalidate() {
                    invalidations += 1;
                },
            },
        );
        component.render(100);
        await vi.waitFor(() => expect(invalidations).toBe(1));
        component.render(100);
        component.render(100);
        expect(invalidations).toBe(1);
    });

    it("uses a stable text-grammar fallback for unsupported languages", async () => {
        const payload = buildPierreDiffPayload({
            path: "src/unsupported.custom",
            oldContent: "before\n",
            newContent: "after\n",
            oldSizeBytes: 7,
            newSizeBytes: 6,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected payload");
        const metadata = { ...payload.metadata, lang: "not-a-real-grammar" };
        const highlighted = await loadHighlightedDiff(metadata);

        expect(highlighted.dark.deletionLines).toHaveLength(1);
        expect(highlighted.dark.additionLines).toHaveLength(1);
        const component = renderPierreDiff(
            { ...payload, metadata, modelKey: `${payload.modelKey}:unsupported` },
            testTheme,
            { expanded: true },
            { lastComponent: undefined, toolCallId: "unsupported" },
        );
        expect(stripAnsi(component.render(100).join("\n"))).toContain("after");
        expect(pierreDiffHighlightStats().queuedHighlights).toBe(0);
    });

    it("eventually highlights 100 restored diffs with one active highlighter", async () => {
        clearQueuedDiffHighlights();
        let invalidations = 0;
        let maximumActive = 0;
        for (let index = 0; index < 100; index += 1) {
            const payload = buildPierreDiffPayload({
                path: `src/restored-${index}.ts`,
                oldContent: `const oldValue = ${index};\n`,
                newContent: `const newValue = ${index + 1};\n`,
                oldSizeBytes: 24,
                newSizeBytes: 24,
                canBuildPierreDiff: true,
            });
            if (payload?.kind !== "renderable") throw new Error("expected restored payload");
            renderPierreDiff(
                payload,
                testTheme,
                { expanded: true },
                {
                    lastComponent: undefined,
                    toolCallId: `restored-${index}`,
                    invalidate() {
                        invalidations += 1;
                    },
                },
            );
            maximumActive = Math.max(maximumActive, pierreDiffHighlightStats().activeHighlights);
        }

        await vi.waitFor(
            () => {
                const stats = pierreDiffHighlightStats();
                maximumActive = Math.max(maximumActive, stats.activeHighlights);
                expect(invalidations).toBe(100);
                expect(stats.queuedHighlights).toBe(0);
                expect(stats.queueRunning).toBe(false);
            },
            { timeout: 10_000 },
        );
        expect(maximumActive).toBeLessThanOrEqual(1);
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
        const narrowAgain = component.render(80);

        expect(stripAnsi(narrow.join("\n"))).not.toContain(" │ ");
        expect(stripAnsi(wide.join("\n"))).toContain(" │ ");
        expect(narrowAgain).toBe(narrow);
        expectLinesWithinWidth(narrow, 80);
        expectLinesWithinWidth(wide, 180);
    });

    it("clears deferred diff highlight timers during shutdown cleanup", () => {
        clearQueuedDiffHighlights();
        vi.useFakeTimers();
        try {
            const payload = buildPierreDiffPayload({
                path: "src/timer-cleanup.ts",
                oldContent: "alpha\ntimer-old\nomega\n",
                newContent: "alpha\ntimer-new\nomega\n",
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

    it("schedules deletion-only intraline highlighting when addition shades match", () => {
        vi.useFakeTimers();
        configureRenderingAppearance({
            ...defaultAppearance,
            addedRowBackground: "#002200",
            addedContentBackground: "#002200",
            deletedRowBackground: "#220000",
            deletedContentBackground: "#440000",
        });
        try {
            const palette = getPierrePalette(testTheme);
            expect(palette.additionSpanBg).toBe(palette.additionRowBg);
            expect(palette.deletionSpanBg).not.toBe(palette.deletionRowBg);

            const payload = buildPierreDiffPayload({
                path: "src/example.rs",
                oldContent: "let removed = 1;\n",
                newContent: "",
                oldSizeBytes: 17,
                newSizeBytes: 0,
                canBuildPierreDiff: true,
            });
            if (payload?.kind !== "renderable") {
                throw new Error("expected renderable Pierre payload");
            }

            renderPierreDiff(
                payload,
                testTheme,
                { expanded: false },
                { lastComponent: undefined, invalidate() {} },
            );

            expect(vi.getTimerCount()).toBeGreaterThan(0);
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

    it("keeps unpaired additions in the right pane at full split width", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "alpha\nold\nomega\n",
            newContent: "alpha\nnew\nextra\nomega\n",
            oldSizeBytes: 16,
            newSizeBytes: 22,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable Pierre payload");
        }

        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        ).render(180);
        const addition = lines.map(stripAnsi).find((line) => line.includes("extra"));
        if (addition === undefined) throw new Error("expected unpaired addition row");

        const dividerIndex = addition.indexOf(" │ ");
        expect(dividerIndex).toBe(88);
        expect(addition.slice(0, dividerIndex).trim()).toBe("");
        expect(addition.indexOf("extra")).toBeGreaterThan(dividerIndex + 3);
        expect(visibleWidth(addition)).toBe(180);
        expect(addition).toContain("3 + extra");
    });

    it("preserves marker-first split gutters in single-number mode", () => {
        configureRenderingAppearance({ ...defaultAppearance, diffLineNumberStyle: "single" });
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "old\n",
            newContent: "new\n",
            oldSizeBytes: 4,
            newSizeBytes: 4,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable Pierre payload");
        }

        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        )
            .render(180)
            .map(stripAnsi);

        expect(lines.some((line) => line.includes("-1 old"))).toBe(true);
        expect(lines.some((line) => line.includes("+1 new"))).toBe(true);
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

    it("keeps the changed token visible before syntax highlighting is ready", () => {
        const prefix = 'export const value = "';
        const payload = buildPierreDiffPayload(
            {
                path: "pathological.ts",
                oldContent: `${prefix}${"a".repeat(12_000)}";\n`,
                newContent: `${prefix}${"b".repeat(12_000)}";\n`,
                oldSizeBytes: 12_025,
                newSizeBytes: 12_025,
                canBuildPierreDiff: true,
            },
            { maxBytes: null, maxLines: null },
        );
        if (payload?.kind !== "renderable") throw new Error("expected renderable payload");
        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined },
        )
            .render(120)
            .map(stripAnsi);

        expect(lines.some((line) => line.includes("aaaa"))).toBe(true);
        expect(lines.some((line) => line.includes("bbbb"))).toBe(true);
        expectLinesWithinWidth(lines, 120);

        configureRenderingAppearance({ ...defaultAppearance, sideBySideLayout: "fixed" });
        const splitLines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined },
        )
            .render(140)
            .map(stripAnsi);
        expect(splitLines.some((line) => line.includes("aaaa") && line.includes("bbbb"))).toBe(
            true,
        );
        expectLinesWithinWidth(splitLines, 140);
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

        expect(plainLines).toContain("  2 +");
        expect(plainLines).not.toContain("");
        expect(plainLines[plainLines.indexOf("  2 +") + 1]).toContain("  3 + def greet():");
    });

    it("shows true old and new coordinates in the compact unified gutter", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "one\ntwo\n",
            newContent: "zero\none\ntwo\n",
            oldSizeBytes: 8,
            newSizeBytes: 13,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");

        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        )
            .render(100)
            .map(stripAnsi);

        expect(lines.some((line) => line.includes("  1 + zero"))).toBe(true);
        expect(lines.some((line) => line.includes("1 2   one"))).toBe(true);
        expect(lines.some((line) => line.includes("2 3   two"))).toBe(true);
    });

    it("invalidates a reused component when the gutter style changes", () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "one\n",
            newContent: "zero\none\n",
            oldSizeBytes: 4,
            newSizeBytes: 9,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");
        const context = {
            lastComponent: undefined,
            toolCallId: "appearance-cache",
            invalidate() {},
        };
        const component = renderPierreDiff(payload, testTheme, { expanded: true }, context);
        const dual = component.render(100).map(stripAnsi);

        configureRenderingAppearance({ ...defaultAppearance, diffLineNumberStyle: "single" });
        const reused = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            {
                ...context,
                lastComponent: component,
            },
        );
        const single = reused.render(100).map(stripAnsi);

        expect(dual.some((line) => line.includes("  1 + zero"))).toBe(true);
        expect(single.some((line) => line.includes("+1 zero"))).toBe(true);
        expect(reused).toBe(component);
    });

    it("invalidates rendered lines when the syntax highlighter is replaced", async () => {
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const value = 1;\n",
            newContent: "const value = 2;\n",
            oldSizeBytes: 17,
            newSizeBytes: 17,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");
        const component = renderPierreDiff(
            payload,
            testTheme,
            { expanded: true },
            { lastComponent: undefined, invalidate() {} },
        );
        const before = component.render(100);

        await reinitializeSyntaxHighlighting(process.env, {
            preloadLanguages: ["typescript"],
        });
        const after = component.render(100);

        expect(after).not.toBe(before);
        expectLinesWithinWidth(after, 100);
    });

    it("uses distinct row and intraline shades without dimming unchanged text by default", async () => {
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
        const palette = getPierrePalette(testTheme);

        expect(palette.deletionRowBg).not.toBe(palette.deletionSpanBg);
        expect(palette.additionRowBg).not.toBe(palette.additionSpanBg);
        expect(deletion).toContain(palette.deletionRowBg);
        expect(deletion).toContain(palette.deletionSpanBg);
        expect(addition).toContain(palette.additionRowBg);
        expect(addition).toContain(palette.additionSpanBg);

        const terminal = new VirtualTerminal(100, 10);
        terminal.write(lines.join("\n"));
        await terminal.settle(0);
        const rows = terminal.interpretedRows();
        const delRow = rows.find((r) => r.text.includes("2000"));
        const addRow = rows.find((r) => r.text.includes("4000"));
        expect(delRow).toBeDefined();
        expect(addRow).toBeDefined();

        const tokenCell2000 = delRow?.cells.find((c) => c.chars === "2");
        const unchangedCellDel = delRow?.cells.find((c) => c.chars === "c");
        expect(tokenCell2000?.background).not.toBe(unchangedCellDel?.background);

        const tokenCell4000 = addRow?.cells.find((c) => c.chars === "4");
        const unchangedCellAdd = addRow?.cells.find((c) => c.chars === "c");
        expect(tokenCell4000?.background).not.toBe(unchangedCellAdd?.background);

        expect(delRow?.cells.some((c) => c.isDim)).toBe(false);
        expect(addRow?.cells.some((c) => c.isDim)).toBe(false);
    });

    it("honors independently configured two-tone shades", () => {
        configureRenderingAppearance({
            ...defaultAppearance,
            addedRowBackground: "#010203",
            deletedRowBackground: "#040506",
            addedContentBackground: "#070809",
            deletedContentBackground: "#0A0B0C",
        });

        const palette = getPierrePalette(testTheme);

        expect(palette.additionRowBg).toContain("48;2;1;2;3");
        expect(palette.deletionRowBg).toContain("48;2;4;5;6");
        expect(palette.additionSpanBg).toContain("48;2;7;8;9");
        expect(palette.deletionSpanBg).toContain("48;2;10;11;12");
    });

    it("derives a distinct intraline shade from 256-color Pi themes", () => {
        const indexedTheme = new Theme(
            {
                ...fgColors,
                toolDiffAdded: 10,
                toolDiffRemoved: 9,
            } satisfies Record<ThemeColor, string | number>,
            {
                ...bgColors,
                toolErrorBg: 52,
                toolSuccessBg: 22,
            } satisfies TestThemeBackgroundColors,
            "256color",
        );

        const palette = getPierrePalette(indexedTheme);

        expect(palette.additionRowBg).toContain("48;5;22");
        expect(palette.deletionRowBg).toContain("48;5;52");
        expect(palette.additionSpanBg).toContain("48;5;");
        expect(palette.deletionSpanBg).toContain("48;5;");
        expect(palette.additionSpanBg).not.toBe(palette.additionRowBg);
        expect(palette.deletionSpanBg).not.toBe(palette.deletionRowBg);
    });

    it("keeps two-tone shades distinct when semantic and row colors are close", () => {
        const closeTheme = new Theme(
            {
                ...fgColors,
                toolDiffAdded: "#002200",
                toolDiffRemoved: "#220000",
            },
            bgColors,
            "truecolor",
        );

        const palette = getPierrePalette(closeTheme);

        expect(palette.additionSpanBg).not.toBe(palette.additionRowBg);
        expect(palette.deletionSpanBg).not.toBe(palette.deletionRowBg);
    });

    it("keeps changed-span-only backgrounds as an option", async () => {
        configureRenderingAppearance({
            ...defaultAppearance,
            diffBackgroundStyle: "changed-spans",
        });
        const payload = buildPierreDiffPayload({
            path: "src/example.ts",
            oldContent: "const limit = 2000;\n",
            newContent: "const limit = 4000;\n",
            oldSizeBytes: 20,
            newSizeBytes: 20,
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") throw new Error("expected renderable Pierre payload");

        await loadHighlightedDiff(payload.metadata);
        const lines = renderPierreDiff(
            payload,
            testTheme,
            { expanded: false },
            { lastComponent: undefined, invalidate() {} },
        ).render(100);

        expect(getPierrePalette(testTheme).deletionRowBg).toBe("");

        const terminal = new VirtualTerminal(100, 10);
        terminal.write(lines.join("\n"));
        await terminal.settle(0);
        const rows = terminal.interpretedRows();
        const delRow = rows.find((r) => r.text.includes("2000"));
        expect(delRow).toBeDefined();

        const tokenCell = delRow?.cells.find((c) => c.chars === "2");
        const unchangedCell = delRow?.cells.find((c) => c.chars === "c");
        expect(tokenCell?.isBackgroundRgb).toBe(true);
        expect(unchangedCell?.isBackgroundDefault).toBe(true);
    });

    it("dims unchanged Pierre replacement text when configured", async () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "changed-spans",
            diffLineNumberStyle: "single",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: null,
            deletedRowBackground: null,
            addedContentBackground: null,
            deletedContentBackground: null,
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
            configureRenderingAppearance(defaultAppearance);
        }
    });

    it("keeps an added blank row compact in changed-span mode", () => {
        configureRenderingAppearance({
            ...defaultAppearance,
            diffBackgroundStyle: "changed-spans",
            diffLineNumberStyle: "single",
        });
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

    it("uses only the row shade for blank additions and deletions in unified and split layouts", () => {
        const cases = [
            { oldContent: "alpha\nomega\n", newContent: "alpha\n\nomega\n", isAddition: true },
            { oldContent: "alpha\n\nomega\n", newContent: "alpha\nomega\n", isAddition: false },
        ] as const;
        const palette = getPierrePalette(testTheme);

        for (const testCase of cases) {
            const payload = buildPierreDiffPayload({
                path: "src/example.py",
                oldContent: testCase.oldContent,
                newContent: testCase.newContent,
                oldSizeBytes: testCase.oldContent.length,
                newSizeBytes: testCase.newContent.length,
                canBuildPierreDiff: true,
            });
            if (!payload) {
                throw new Error("expected Pierre payload");
            }

            const rowBackground = testCase.isAddition
                ? palette.additionRowBg
                : palette.deletionRowBg;
            const contentBackground = testCase.isAddition
                ? palette.additionSpanBg
                : palette.deletionSpanBg;

            for (const width of [80, 180]) {
                const blankChange = renderPierreDiff(
                    payload,
                    testTheme,
                    { expanded: true },
                    { lastComponent: undefined, invalidate() {} },
                )
                    .render(width)
                    .find((line) => line.includes(rowBackground));

                expect(blankChange).toBeDefined();
                expect(blankChange).not.toContain(contentBackground);
                expect(visibleWidth(blankChange ?? "")).toBe(width);
            }
        }
    });

    it("uses only the row shade when one side of a replacement is blank", () => {
        const cases = [
            { oldContent: "alpha\nold\nomega\n", newContent: "alpha\n\nomega\n", marker: "+" },
            { oldContent: "alpha\n\nomega\n", newContent: "alpha\nnew\nomega\n", marker: "-" },
        ] as const;
        const palette = getPierrePalette(testTheme);

        for (const testCase of cases) {
            const payload = buildPierreDiffPayload({
                path: "src/example.py",
                oldContent: testCase.oldContent,
                newContent: testCase.newContent,
                oldSizeBytes: testCase.oldContent.length,
                newSizeBytes: testCase.newContent.length,
                canBuildPierreDiff: true,
            });
            if (!payload) {
                throw new Error("expected Pierre payload");
            }

            const isAddition = testCase.marker === "+";
            const rowBackground = isAddition ? palette.additionRowBg : palette.deletionRowBg;
            const contentBackground = isAddition ? palette.additionSpanBg : palette.deletionSpanBg;
            const blankChange = renderPierreDiff(
                payload,
                testTheme,
                { expanded: true },
                { lastComponent: undefined, invalidate() {} },
            )
                .render(80)
                .find((line) => stripAnsi(line).trimEnd().endsWith(testCase.marker));

            expect(blankChange).toBeDefined();
            expect(blankChange).toContain(rowBackground);
            expect(blankChange).not.toContain(contentBackground);
            expect(visibleWidth(blankChange ?? "")).toBe(80);
        }
    });

    it("keeps full-row Pierre backgrounds as an option", () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "full-row",
            diffLineNumberStyle: "single",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: null,
            deletedRowBackground: null,
            addedContentBackground: null,
            deletedContentBackground: null,
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
            configureRenderingAppearance(defaultAppearance);
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
        expect(lines.some((line) => stripAnsi(line).trimEnd() === "2 2")).toBe(true);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    });
});
