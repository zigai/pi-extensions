import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { formatPathTarget } from "../../../../src/rendering/path.ts";
import { renderScriptCall } from "../../../../src/tools/built-in/bash/script-renderer.ts";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../../support/theme-colors.ts";

const theme = new Theme(
    { ...TEST_THEME_COLORS, accent: "#32AA64", customMessageLabel: "#AC72D3" },
    TEST_THEME_BACKGROUND_COLORS,
    "truecolor",
);

function render(code: string, expanded = false, width = 240): string[] {
    return renderScriptCall(
        theme,
        { label: "Bash", language: "bash", code },
        { state: "success", expanded },
    ).render(width);
}

describe("Bash semantic path colors", () => {
    it.each([false, true])("uses the current theme path accent (expanded %s)", (expanded) => {
        const code = "cd /work/project; cat modes/interactive/footer.js package.json";
        const rendered = render(code, expanded).join("\n");
        for (const path of ["/work/project", "modes/interactive/footer.js", "package.json"]) {
            expect(rendered).toContain(theme.fg("accent", path));
        }

        expect(stripVTControlCharacters(rendered)).toContain(code);
    });

    it("colors quoted paths, flag values, assignments, redirects, and executable paths", () => {
        const code = `OUT=/tmp/output.log ./bin/run --config=./config.json --file 'src/my file.ts' > "/tmp/my output.log"`;
        const rendered = render(code).join("\n");
        for (const path of [
            "/tmp/output.log",
            "./bin/run",
            "./config.json",
            "src/my file.ts",
            "/tmp/my output.log",
        ]) {
            expect(rendered).toContain(theme.fg("accent", path));
        }

        expect(stripVTControlCharacters(rendered)).toContain(code);
    });

    it("uses the instruction/skill color rather than the ordinary path accent", () => {
        const paths = [
            "AGENTS.md",
            "/work/.pi/agent/skills/review/SKILL.md",
            "skills/review/SKILL.md",
        ];

        const rendered = render(`cat ${paths.join(" ")}`).join("\n");
        for (const path of paths) {
            expect(rendered).toContain(theme.fg("customMessageLabel", path));
            expect(formatPathTarget(theme, path)).toBe(theme.fg("customMessageLabel", path));
        }
    });

    it("keeps partial skill read targets in the instruction color", () => {
        expect(formatPathTarget(theme, "skills/review/SKILL.m", { isPartial: true })).toBe(
            theme.fg("customMessageLabel", "skills/review/SKILL.m"),
        );
    });

    it("preserves variables, ordinary strings, URL strings, and embedded script syntax", () => {
        const rendered = render(
            `cat "$HOME/file.txt"; echo "hello world" "https://example.com/a.json"; python -c 'print("/tmp/not-an-operand")'`,
        ).join("\n");
        expect(rendered).toContain(theme.fg("syntaxVariable", "$HOME"));
        expect(rendered).toContain(theme.fg("syntaxString", "hello world"));
        expect(rendered).toContain(theme.fg("syntaxString", "https://example.com/a.json"));
        expect(rendered).not.toContain(theme.fg("accent", "/tmp/not-an-operand"));
    });

    it.each(["cat 'src/path.ts", 'cat "src/path.ts', "cat 'src/path.ts'"])(
        "preserves incomplete quoted path source: %s",
        (code) => expect(stripVTControlCharacters(render(code).join("\n"))).toContain(code),
    );

    it("keeps paths and source intact across narrow wrapping", () => {
        const code = "cat /work/project/really-long-directory/example.ts";
        for (const width of [24, 60, 120]) {
            const lines = render(code, true, width);
            for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            expect(lines.join("\n")).toContain(theme.getFgAnsi("accent"));
        }
    });
});
