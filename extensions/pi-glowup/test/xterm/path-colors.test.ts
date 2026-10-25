import { Theme } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { renderScriptCall } from "../../src/tools/built-in/bash/script-renderer.ts";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../support/theme-colors.ts";
import { rgbFromHex, VirtualTerminal } from "../support/virtual-terminal.ts";

it("paints shell paths with live semantic theme colors through Pi's TUI and xterm", async () => {
    const terminal = new VirtualTerminal(100, 20);
    const tui = new TuiMainScreen(terminal);
    const paths = ["/work/project/package.json", "/work/.pi/agent/skills/review/SKILL.md"];
    tui.setClearOnShrink(true);
    tui.start();
    try {
        for (const [accent, skill] of [
            ["#32AA64", "#AC72D3"],
            ["#67BD89", "#CA91F2"],
        ] as const) {
            const theme = new Theme(
                { ...TEST_THEME_COLORS, accent, customMessageLabel: skill },
                TEST_THEME_BACKGROUND_COLORS,
                "truecolor",
            );
            const component = renderScriptCall(
                theme,
                { label: "Bash", language: "bash", code: `cat ${paths.join(" ")}` },
                { state: "success", expanded: true },
            );
            tui.clear();
            tui.addChild(component);
            tui.requestRender(true);

            for (const width of [100, 64, 100]) {
                terminal.resize(width, 20);
                tui.requestRender();
                await terminal.settle();

                for (const [index, path] of paths.entries()) {
                    const row = terminal.interpretedRows().find((row) => row.text.includes(path));
                    expect(row, `missing ${path} at width ${width}`).toBeDefined();

                    if (row === undefined) continue;

                    const offset = row.text.indexOf(path);
                    const expectedColor = rgbFromHex([accent, skill][index] ?? accent);
                    for (const cell of row.cells.slice(offset, offset + path.length)) {
                        expect(cell.foreground).toBe(expectedColor);
                        expect(cell.isForegroundRgb).toBe(true);
                    }

                    const following = row.cells[offset + path.length];
                    if (following !== undefined)
                        expect(following.foreground).not.toBe(expectedColor);

                    expect(row.isWrapped).toBe(false);
                }
            }
        }
    } finally {
        tui.stop();
        await terminal.settle(0);
        terminal.dispose();
    }
});
