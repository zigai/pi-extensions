import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { textDiffGolden } from "../../support/text-diff-corpus.ts";
import { createPlainTheme } from "../../support/plain-theme.ts";
import { renderGlowupDiff } from "../../../src/rendering/diff/text-renderer.ts";
import type { DiffLineCoordinates } from "../../../src/rendering/diff/text-diff.ts";

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
