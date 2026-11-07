import {
    getCapabilities,
    setCapabilities,
    TuiMainScreen,
    TuiAltScreen,
    type Component,
} from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { renderScriptCall } from "../../src/tools/built-in/bash/script-renderer.ts";
import { extractEmbeddedPrograms } from "../../src/tools/built-in/bash/embedded-programs.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../src/rendering/syntax/highlighter.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../support/theme-colors.ts";
import { VirtualTerminal } from "../support/virtual-terminal.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
const originalCapabilities = getCapabilities();

afterEach(async () => {
    await disposeSyntaxHighlighting();
    setCapabilities(originalCapabilities);
});

it.each(["regular", "fullscreen"])(
    "preserves embedded Python terminal cells during pending analysis and resize (%s)",
    async (mode) => {
        setCapabilities({ ...originalCapabilities, trueColor: true });
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
        const terminal = new VirtualTerminal(100, 24);
        let tui;
        if (mode === "regular") tui = new TuiMainScreen(terminal);
        else tui = new TuiAltScreen(terminal);

        onTestFinished(() => {
            tui.stop();
            terminal.dispose();
        });
        const source = `cd /work && python3 - <<'PY'\nprint("CELL_ANCHOR", 42)\nPY`;
        const next = `${source}\necho done`;
        const initialPrograms = extractEmbeddedPrograms(source);
        const nextPrograms = extractEmbeddedPrograms(next);
        let ready = false;
        let current: Component | undefined;
        const render = (code: string) => {
            current = renderScriptCall(
                theme,
                { label: "Bash", language: "bash", code },
                {
                    state: "running",
                    expanded: true,
                    lastComponent: current,
                    invalidate: () => {
                        current?.invalidate();
                        tui.requestRender();
                    },
                    // Deterministically hold the asynchronous parser boundary. No
                    // elapsed-time assumption can hide the pending frame under test.
                    embeddedPrograms: (value) => {
                        if (value === source) return initialPrograms;
                        if (ready) return nextPrograms;
                        return undefined;
                    },
                },
            );
        };
        render(source);
        tui.addChild({ render: () => ["BEFORE_SYNTAX"], invalidate() {} });
        tui.addChild({
            render: (width) => current?.render(width) ?? [],
            invalidate: () => current?.invalidate(),
        });
        tui.addChild({ render: () => ["AFTER_SYNTAX"], invalidate() {} });
        tui.start();
        await terminal.settle();
        await settleSyntaxHighlights();
        current?.invalidate();
        tui.requestRender();
        await terminal.settle();
        const codeCells = () => {
            const row = terminal.requireRowContaining("CELL_ANCHOR");
            const start = row.text.indexOf("print");
            return row.cells.slice(start, start + 'print("CELL_ANCHOR", 42)'.length);
        };
        const colored = codeCells();
        expect(new Set(colored.map((cell) => cell.foreground)).size).toBeGreaterThan(2);
        render(next);
        tui.requestRender();
        await terminal.settle();
        expect(codeCells()).toEqual(colored);
        terminal.requireRowContaining("echo done");

        for (const width of [50, 120, 100]) {
            terminal.resize(width, 24);
            tui.requestRender();
            await terminal.settle();
            expect(codeCells()).toEqual(colored);
            terminal.assertUniqueTranscriptMarkers("CELL_ANCHOR", "BEFORE_SYNTAX", "AFTER_SYNTAX");
            terminal.assertRowsFitWidth();
            terminal.assertNoWrappedRows();
        }

        ready = true;
        current?.invalidate();
        tui.requestRender();
        await terminal.settle();
        await settleSyntaxHighlights();
        current?.invalidate();
        tui.requestRender();
        await terminal.settle();
        expect(codeCells()).toEqual(colored);
    },
);
