import type { Component } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

    it("retains independent embedded programs across width changes", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
        const first = source.replaceAll("syntax_", "alpha_");
        const second = source.replaceAll("syntax_", "beta_");
        const command = `node -e '${first}'; node -e '${second}'`;
        const invalidate = vi.fn<() => void>();
        let previous: Component | undefined;
        const render = (width: number) => {
            const context = {
                args: { command },
                toolCallId: "independent-resize",
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
                () => "preserve",
                () => "trailing",
                ({ source: code }) => code,
            );

            return previous.render(width);
        };
        render(120);
        await feature.settled();
        render(120);
        await settleSyntaxHighlights();
        previous?.invalidate();
        const wide = render(120).map(stripVTControlCharacters).join("\n");
        const narrow = render(80).map(stripVTControlCharacters).join("\n");
        expect(wide).toContain("alpha_0");
        expect(wide).toContain("beta_0");
        expect(narrow).toContain("alpha_0");
        expect(narrow).toContain("beta_0");
        await settleSyntaxHighlights();
        expect(render(120).map(stripVTControlCharacters).join("\n")).toBe(wide);
    });

    it("does not adopt a stale program after an A to B to A source change", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
        const first = `node -e '${source.replaceAll("syntax_", "alpha_")}'`;
        const second = `node -e '${source.replaceAll("syntax_", "beta_")}'`;
        const invalidate = vi.fn<() => void>();
        let previous: Component | undefined;
        const render = (command: string) => {
            const context = {
                args: { command },
                toolCallId: "source-revisions",
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
                () => "preserve",
                () => "trailing",
                ({ source: code }) => code,
            );

            return previous.render(120);
        };
        render(first);
        render(second);
        render(first);
        await feature.settled();
        render(first);
        await settleSyntaxHighlights();
        previous?.invalidate();
        const displayed = render(first).map(stripVTControlCharacters).join("\n");
        expect(displayed).toContain("alpha_0");
        expect(displayed).not.toContain("beta_0");
    });

    it("does not invalidate a reset feature when a syntax job finishes late", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const feature = createNativeBashFeature();
        const command = `node --input-type=module <<'JS'\n${source}\nJS`;
        const invalidate = vi.fn<() => void>();
        const context = {
            args: { command },
            toolCallId: "reset-syntax",
            cwd: "/work",
            lastComponent: undefined,
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
        const show = () =>
            feature.renderBashCall(
                { command },
                theme,
                context,
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
                ({ source: code }) => code,
            );
        show().render(120);
        await feature.settled();
        show().render(120);
        const before = invalidate.mock.calls.length;
        feature.clear();
        await settleSyntaxHighlights();
        expect(invalidate).toHaveBeenCalledTimes(before);
    });

    it("does not flash plain code or restart highlighting when a streamed tool row rebuilds", async () => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const feature = createNativeBashFeature();
        onTestFinished(() => feature.clear());
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

        redraw();
        await feature.settled();
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
