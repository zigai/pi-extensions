import type { Component } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../../src/rendering/syntax/highlighter.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../../support/theme-colors.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

// Large enough to bypass the shared per-source syntax cache. The live tool row
// must retain its own colors when Pi rebuilds it after asynchronous completion.
const source = Array.from(
    { length: 180 },
    (_value, index) => `const value${index} = formatValue("syntax_${index}", ${index});`,
).join("\n");

describe("streaming Bash syntax ownership", () => {
    afterEach(async () => {
        await disposeSyntaxHighlighting();
    });

    it("does not flash plain code or restart highlighting when a streamed tool row rebuilds", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const feature = createNativeBashFeature();
        const command = `node --input-type=module <<'JS'\n${source}\nJS`;
        const invalidate = vi.fn<() => void>();
        let previous: Component | undefined;
        const redraw = () => {
            const context = {
                args: { command },
                toolCallId: "streamed-syntax",
                cwd: "/work",
                lastComponent: previous,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: true,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate,
            } satisfies BuiltInRenderContext;
            previous = feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
                ({ source: code }) => code,
            );
            return previous.render(120);
        };

        const cold = redraw();
        await settleSyntaxHighlights();
        expect(invalidate).toHaveBeenCalled();
        previous?.invalidate();
        const colored = previous?.render(120);
        expect(colored).toBeDefined();
        expect(colored).not.toEqual(cold);
        const completions = invalidate.mock.calls.length;
        for (let revision = 0; revision < 4; revision += 1) {
            expect(redraw()).toEqual(colored);
            await settleSyntaxHighlights();
            expect(invalidate).toHaveBeenCalledTimes(completions);
        }

        expect(colored?.map(stripVTControlCharacters)).toEqual(cold.map(stripVTControlCharacters));
    });
});
