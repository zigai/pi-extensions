import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("Bash path rendering", () => {
    it.each([false, true])("shows paths in the plain text color (expanded %s)", (expanded) => {
        const code = "cd /work/project; cat modes/interactive/footer.js package.json AGENTS.md";
        const rendered = render(code, expanded).join("\n");
        for (const path of [
            "/work/project",
            "modes/interactive/footer.js",
            "package.json",
            "AGENTS.md",
        ]) {
            expect(rendered).toContain(theme.fg("toolTitle", path));
        }

        expect(rendered).not.toContain(theme.getFgAnsi("accent"));
        expect(rendered).not.toContain(theme.getFgAnsi("customMessageLabel"));
        expect(stripVTControlCharacters(rendered)).toContain(code);
    });

    it("keeps quoted arguments containing slashes in the string color", () => {
        const rendered = render(
            `node eval 'items.filter(a=>/65M|75M/i.test(a.text))' --file 'src/my file.ts'`,
        ).join("\n");

        expect(rendered).toContain(
            theme.fg("syntaxString", "'items.filter(a=>/65M|75M/i.test(a.text))'"),
        );

        expect(rendered).toContain(theme.fg("syntaxString", "'src/my file.ts'"));
    });

    it("colors instruction read targets apart from ordinary read targets", () => {
        for (const path of [
            "AGENTS.md",
            "/work/.pi/agent/skills/review/SKILL.md",
            "skills/review/SKILL.md",
        ])
            expect(formatPathTarget(theme, path)).toBe(theme.fg("customMessageLabel", path));

        const script = "/work/.pi/agent/skills/review/scripts/run.ts";
        expect(formatPathTarget(theme, script)).toBe(theme.fg("accent", script));
        expect(
            formatPathTarget(theme, "/work/.pi/agent/skills/review/scripts/run.t", {
                isPartial: true,
            }),
        ).toBe(theme.fg("muted", "/work/.pi/agent/skills/review/scripts/run.t"));

        const reference = "/work/.pi/agent/skills/review/references/rules.md";
        expect(formatPathTarget(theme, reference)).toBe(theme.fg("customMessageLabel", reference));
    });

    it("keeps partial skill read targets in the instruction color", () => {
        expect(formatPathTarget(theme, "skills/review/SKILL.m", { isPartial: true })).toBe(
            theme.fg("customMessageLabel", "skills/review/SKILL.m"),
        );
    });

    describe("home directory paths", () => {
        const home = "/home/tester";
        let previousHome: string | undefined;
        beforeEach(() => {
            previousHome = process.env.HOME;
            process.env.HOME = home;
        });
        afterEach(() => {
            process.env.HOME = previousHome;
        });

        it("shows unquoted home paths with ~", () => {
            const rendered = stripVTControlCharacters(
                render(
                    `${home}/bin/tool ${home}/notes.txt --out ${home}/out.log > ${home}/run.log; OUT=${home}/x cd ${home}`,
                ).join("\n"),
            );
            expect(rendered).toContain(
                "~/bin/tool ~/notes.txt --out ~/out.log > ~/run.log; OUT=~/x cd ~",
            );
            expect(rendered).not.toContain(home);
        });

        it("keeps home paths where bash would not expand ~", () => {
            const code = `cat "${home}/a.txt" '${home}/b.txt' --config=${home}/c.json $DIR${home}/d.txt ${home}x/e.txt; python -c 'open("${home}/f.txt")'`;
            expect(stripVTControlCharacters(render(code).join("\n"))).toContain(code);
        });
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
            expect(stripVTControlCharacters(lines.join("")).replaceAll(/\s/gu, "")).toContain(
                code.replaceAll(" ", ""),
            );
        }
    });
});
