import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import {
    renderBashCommandCall,
    type BashCommandRenderOptions,
} from "../../../../src/tools/built-in/bash/renderer.ts";
import type { GlowupRenderTheme } from "../../../../src/rendering/theme.ts";

const theme: GlowupRenderTheme = {
    fg(_token, text) {
        return text;
    },
    bold(text) {
        return text;
    },
};
const pythonCommand = "python3 - <<'PY'\nprint(1)\nPY";

type RenderOptions = Partial<BashCommandRenderOptions>;

function render(command: string, width: number, options: RenderOptions = {}) {
    return renderBashCommandCall(theme, command, {
        state: "success",
        expanded: true,
        maxCodePreviewLines: 8,
        showPrologueOmission: false,
        shellLayout: "preserve",
        shellOperatorPosition: "trailing",
        background: true,
        ...options,
    }).render(width);
}

function plain(rows: readonly string[]): string[] {
    return rows.map((row) => stripVTControlCharacters(row));
}

function expectWithinWidth(rows: readonly string[], width: number): void {
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
}

describe("native Bash background call marker", () => {
    it.each(["sleep 5", pythonCommand])(
        "right-aligns the marker before the duration on the top prompt row: %s",
        (command) => {
            const rows = plain(render(command, 40, { durationMs: 1234 }));
            expect(rows[0]).toMatch(/ 1\.23s $/u);
            expect(visibleWidth(rows[0] ?? "")).toBe(40);
            expect(rows.join("\n").match(//gu)).toHaveLength(1);

            if (command === pythonCommand) {
                expect(rows[0]).toMatch(/^\$ python3 - <<'PY'/u);
                expect(rows.slice(1)).toEqual(["  print(1)"]);
            } else expect(rows[0]).toMatch(/^\$ sleep 5/u);
        },
    );

    it.each(["sleep 5", pythonCommand])(
        "shows only the marker while running even if elapsed time is supplied: %s",
        (command) => {
            const rows = plain(render(command, 40, { state: "running", durationMs: 1234 }));
            expect(rows[0]).toMatch(/  $/u);
            expect(rows.join("\n")).not.toMatch(/1\.23s|done|completed|✓/u);
        },
    );

    it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        "retains the marker when duration is unknown (%s)",
        (durationMs) => {
            const rows = plain(render("sleep 5", 40, { durationMs }));
            expect(rows[0]).toMatch(/  $/u);
            expect(rows.join("\n")).not.toMatch(/NaN|Infinity|\ds/u);
        },
    );

    it("keeps a failed duration red and the marker muted", () => {
        const coloredTheme: GlowupRenderTheme = {
            ...theme,
            fg(token, text) {
                if (token === "toolDiffRemoved") return `\u001b[31m${text}\u001b[39m`;
                if (token === "muted") return `\u001b[90m${text}\u001b[39m`;
                return text;
            },
        };
        const rows = renderBashCommandCall(coloredTheme, "false", {
            state: "error",
            expanded: true,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "preserve",
            shellOperatorPosition: "trailing",
            background: true,
            durationMs: 0,
        }).render(40);

        expect(rows[0]).toContain("\u001b[90m\u001b[39m \u001b[31m0.00s\u001b[39m");
        expectWithinWidth(rows, 40);
    });

    it.each([
        [
            "echo abcdefghijklmnopqrstuvwxyz",
            ["$ echo            4.27s ", "    abcdefghijkl", "    mnopqrstuvwx", "    yz"],
        ],
        [pythonCommand, ["$ python3 -       4.27s ", "    <<'PY'", "  print(1)"]],
    ] as const)("reserves space before wrapping a long first line: %s", (command, expected) => {
        const rows = render(command, 25, { durationMs: 4270 });
        expect(plain(rows)).toEqual(expected);
        expectWithinWidth(rows, 25);
    });

    it.each([8, 10, 14, 15, 18, 22])(
        "prefers the marker over a duration when narrow (%d columns)",
        (width) => {
            for (const command of ["echo abcdefghijklmnopqrstuvwxyz", pythonCommand]) {
                const rows = render(command, width, { durationMs: 3_725_000 });
                expect(plain(rows)[0]).toMatch(/  $/u);
                expect(plain(rows).join("\n")).not.toContain("1h 2m 5s");
                expectWithinWidth(rows, width);
            }
        },
    );

    it.each([1, 2, 4, 7])("omits metadata only at tiny widths (%d columns)", (width) => {
        const rows = render("echo abc", width, { durationMs: 1234 });
        expect(plain(rows).join("\n")).not.toContain("");
        expectWithinWidth(rows, width);
    });

    it("preserves foreground code and duration rendering exactly", () => {
        expect(
            plain(render("echo 'literal & text'\nprintf done", 80, { background: false })),
        ).toEqual(["$ echo 'literal & text'", "  printf done"]);

        expect(plain(render("sleep 5", 40, { background: false, durationMs: 1234 }))).toEqual([
            `$ sleep 5${" ".repeat(25)}1.23s `,
        ]);
        const rows = renderBashCommandCall(theme, "echo plain", {
            state: "running",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
        }).render(40);
        expect(plain(rows)).toEqual(["$ echo plain"]);
    });

    it("changes only header metadata, not code content", () => {
        for (const command of ["echo 'literal & text'\nprintf done", pythonCommand]) {
            const foreground = plain(render(command, 80, { background: false }));
            const background = plain(render(command, 80)).map((row) => row.replace(/\s+ $/u, ""));
            expect(background).toEqual(foreground);
        }
    });
});
