import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { fc } from "@fast-check/vitest";
import { stripVTControlCharacters } from "node:util";
import { clearCompletedLineCache } from "../../../src/rendering/rendered-line-cache.ts";
import { propertyReplayParameters } from "../../support/property-replay.ts";
import { toolExpandHint } from "../../../src/rendering/component.ts";
import {
    configureRenderingAppearance,
    type RenderingAppearance,
} from "../../../src/rendering/theme.ts";
import { textDiffGolden } from "../../support/text-diff-corpus.ts";
import { createPlainTheme } from "../../support/plain-theme.ts";
import { renderGlowupDiff } from "../../../src/rendering/diff/text-renderer.ts";
import type { DiffLineCoordinates } from "../../../src/rendering/diff/text-diff.ts";

// Pi 1.5 closes styled-word ANSI codes before wrapping whitespace. At width 20,
// this removes one stray space before wrapped file statistics; syntax and diff
// cell colors stay intact. The corpus intentionally records that upstream fix.
it("preserves exact plain and syntax-highlighted diff frames through layouts and resizing", async () => {
    expect(await textDiffGolden()).toBe(
        readFileSync(new URL("./golden/text-diff.json", import.meta.url), "utf8"),
    );
});

it("recomputes current rows and coordinates after invalidation and width changes", () => {
    const theme = createPlainTheme();
    const lines = ["+1 old content"];
    const lineCoordinates: Array<DiffLineCoordinates | undefined> = [{ newLine: 1 }];
    const sections = [{ lines, lineCoordinates, added: 1, removed: 0 }];
    const component = renderGlowupDiff(theme, sections, true);
    expect(component.render(80).join("\n")).toContain("old content");

    lines.splice(0, 1, "metadata", "+99 new 界 content", "  … omitted");
    lineCoordinates.splice(0, 1, undefined, { newLine: 99 }, undefined);
    component.invalidate();

    for (const width of [80, 20, 180, 80]) {
        const current = component.render(width);
        expect(current).toEqual(renderGlowupDiff(theme, sections, true).render(width));
        expect(current.join("\n")).not.toContain("old content");
        expect(current.join("\n")).toContain("new");
        expect(current.join("\n")).toContain("界");
    }
});

// Failure cases: large unchanged frames repeatedly parse;
// mutable source/coordinates, style changes and syntax completion reuse stale output;
// callers mutate returned arrays; aggregate line-cache eviction must still allow cold rebuilds.
it("reuses large unchanged diff frames without sharing mutable arrays", () => {
    const section = {
        lines: Array.from({ length: 400 }, (_, i) => `+${i + 1} row ${i}`),
        added: 400,
        removed: 0,
    };
    const sections = [section];
    const component = renderGlowupDiff(createPlainTheme(), sections, true);
    const first = component.render(100);
    const expected = [...first];
    const warm = component.render(100);
    expect(warm).toEqual(expected);
    first[0] = "changed by caller";
    warm[1] = "changed warm result";
    expect(component.render(100)).toEqual(expected);
    section.lines[0] = "+99 new text";
    component.invalidate();
    expect(component.render(100)).toEqual(
        renderGlowupDiff(createPlainTheme(), sections, true).render(100),
    );

    expect(component.render(100).join("\n")).toContain("new text");
});

afterEach(() => {
    vi.unstubAllEnvs();
    clearCompletedLineCache();
});

it("suppresses identical replacement sides even when their counterpart is outside the preview", () => {
    fc.assert(
        fc.property(
            fc.array(fc.constantFrom("same text", "界 é", "let value = 1;"), {
                minLength: 3,
                maxLength: 12,
            }),
            fc.integer({ min: 1, max: 5 }),
            (contents, budget) => {
                const lines = contents.flatMap((content, index) => [
                    `-${index + 1} ${content}`,
                    `+${index + 1} ${content}`,
                ]);
                const component = renderGlowupDiff(
                    createPlainTheme(),
                    [{ lines, added: contents.length, removed: contents.length }],
                    false,
                    { collapsedLineBudget: budget },
                );
                const omitted = lines.length - budget;
                let noun = "lines";
                if (omitted === 1) noun = "line";

                expect(
                    component
                        .render(120)
                        .map(stripVTControlCharacters)
                        .map((line) => line.trim()),
                ).toEqual([
                    `… +${omitted} ${noun} (${stripVTControlCharacters(toolExpandHint())})`,
                ]);
            },
        ),
        { ...propertyReplayParameters(), numRuns: 60 },
    );
});

it("keeps retained large frames equal to fresh frames through source, coordinate, width and release histories", () => {
    const action = fc.record({
        kind: fc.constantFrom("text", "coordinate", "width", "invalidate", "release"),
        value: fc.integer({ min: 0, max: 399 }),
    });
    fc.assert(
        fc.property(fc.array(action, { minLength: 6, maxLength: 18 }), (actions) => {
            const section = {
                lines: Array.from({ length: 400 }, (_, index) => `+${index + 1} row a${index}`),
                lineCoordinates: Array.from({ length: 400 }, (_, index) => ({
                    newLine: index + 1,
                })),
                added: 400,
                removed: 0,
            };
            const sections = [section];
            const component = renderGlowupDiff(createPlainTheme(), sections, true);
            let width = 100;
            component.render(width);

            for (const { kind, value } of actions) {
                if (kind === "text") section.lines[value] = `+${value + 1} row b${value}`;

                if (kind === "coordinate")
                    section.lineCoordinates[value] = { newLine: value + 701 };

                if (kind === "width") width = [40, 100, 120][value % 3] ?? 100;
                if (kind === "invalidate") component.invalidate();
                if (kind === "release") clearCompletedLineCache();

                expect(component.render(width)).toEqual(
                    renderGlowupDiff(createPlainTheme(), sections, true).render(width),
                );
            }

            clearCompletedLineCache();
        }),
        { ...propertyReplayParameters(), numRuns: 35 },
    );
});

const retainedAppearance: RenderingAppearance = {
    diffBackgroundStyle: "two-tone",
    diffLineNumberStyle: "dual",
    narrowDiffLayout: "paired",
    sideBySideLayout: "content-aware",
    addedRowBackground: "#213A2B",
    deletedRowBackground: "#4A221D",
    addedContentBackground: "#0D5728",
    deletedContentBackground: "#762925",
    instructionPathColor: null,
    dimUnchangedDiffText: false,
};

it.each(["palette", "appearance", "home"] as const)(
    "refreshes retained large frames after a %s change",
    (change) => {
        configureRenderingAppearance(retainedAppearance);
        vi.stubEnv("HOME", "/home/old");
        let color = "31";
        const theme = {
            ...createPlainTheme(),
            fg: (_token: string, text: string) => `\u001b[${color}m${text}\u001b[39m`,
        };

        const sections = [
            {
                path: "/home/new/example.txt",
                lines: Array.from({ length: 400 }, (_, index) => `+${index + 1} row ${index}`),
                added: 400,
                removed: 0,
            },
            { path: "other.txt", lines: ["+1 other"], added: 1, removed: 0 },
        ];

        const component = renderGlowupDiff(theme, sections, true);
        const first = component.render(100);

        if (change === "palette") color = "34";

        if (change === "appearance")
            configureRenderingAppearance({
                ...retainedAppearance,
                diffLineNumberStyle: "single",
                addedRowBackground: "#112233",
            });

        if (change === "home") vi.stubEnv("HOME", "/home/new");
        try {
            const current = component.render(100);
            expect(current).not.toEqual(first);
            expect(current).toEqual(renderGlowupDiff(theme, sections, true).render(100));
        } finally {
            configureRenderingAppearance(retainedAppearance);
        }
    },
);

it("preserves sparse sections when omitted holes are not rendered", () => {
    const lines: string[] = [];
    lines.length = 12;
    lines[0] = "+1 kept";
    lines[11] = "+12 later";
    const component = renderGlowupDiff(
        createPlainTheme(),
        [{ lines, added: 2, removed: 0 }],
        false,
        {
            collapsedLineBudget: 1,
        },
    );
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("kept");
    expect(rendered).not.toContain("later");
    expect(rendered).toContain("+11 lines");
});
