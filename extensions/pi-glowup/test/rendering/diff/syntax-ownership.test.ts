import type { Component } from "@earendil-works/pi-tui";
import { keyText, keyHint, Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../src/rendering/syntax/highlighter.ts";
import { PREVIEW_MUTATION_SETTINGS } from "../../../src/rendering/preview-settings.ts";
import { createNativeEditFeature } from "../../../src/tools/built-in/edit.ts";
import { renderGlowupDiff } from "../../../src/rendering/diff/text-renderer.ts";
import { createNativeDeleteFeature } from "../../../src/tools/built-in/delete.ts";
import type { BuiltInRenderContext } from "../../../src/tools/built-in/context.ts";
import { mutation } from "../../../src/tools/protocol/contract.ts";
import { renderProtocolMutation } from "../../../src/tools/protocol/mutation-renderer.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../support/theme-colors.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

// Larger than the shared syntax cache's per-source budget, but within the tokenizer limit.
const source = Array.from(
    { length: 400 },
    (_value, index) => `const value${index} = formatValue("syntax_${index}", ${index});`,
);

const path = "src/retained-colors.ts";

describe("text mutation syntax ownership", () => {
    afterEach(async () => {
        await disposeSyntaxHighlighting();
    });

    it.each(["before", "after"] as const)(
        "refreshes an admitted frame when syntax starts %s its first draw",
        async (startup) => {
            await disposeSyntaxHighlighting();

            if (startup === "before")
                await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });

            let component: Component | undefined;

            const sections = [
                {
                    path,
                    lines: source.map((line, index) => `+${index + 1} ${line}`),
                    added: source.length,
                    removed: 0,
                },
            ];
            component = renderGlowupDiff(theme, sections, true, {
                invalidate: () => component?.invalidate(),
            });
            const initial = component.render(100);
            expect(initial.length).toBeGreaterThan(300);

            if (startup === "after")
                await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });

            component.render(100);
            await settleSyntaxHighlights();
            const settled = component.render(100);
            expect(settled).not.toEqual(initial);
            expect(settled.map(stripVTControlCharacters)).toEqual(
                initial.map(stripVTControlCharacters),
            );
            const fresh = renderGlowupDiff(theme, sections, true);
            fresh.render(100);
            await settleSyntaxHighlights();
            expect(fresh.render(100)).toEqual(settled);
            expect(component.render(100)).toEqual(settled);
        },
    );

    it.each(["protocol", "edit", "delete"] as const)(
        "keeps %s colors and completion notifications across component rebuilds",
        async (kind) => {
            await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
            expect(Buffer.byteLength(source.join("\n"))).toBeGreaterThan(8 * 1024);
            const invalidate = vi.fn<() => void>();
            const edit = createNativeEditFeature();
            const deletion = createNativeDeleteFeature();
            let previous: Component | undefined;
            const redraw = () => {
                const context = {
                    args: { path },
                    toolCallId: `syntax-${kind}`,
                    state: undefined,
                    cwd: "/tmp",
                    durationMs: undefined,
                    outputPad: 0,
                    keyText,
                    keyHint,
                    executionStarted: true,
                    argsComplete: true,
                    isPartial: false,
                    expanded: true,
                    showImages: false,
                    isError: false,
                    invalidate,
                    lastComponent: previous,
                } satisfies BuiltInRenderContext;
                if (kind === "protocol") {
                    previous = renderProtocolMutation(
                        mutation({ static: "Patch" }, [
                            {
                                path,
                                lines: source.map((text, index) => ({
                                    kind: "addition",
                                    text,
                                    newLine: index + 1,
                                })),
                                added: source.length,
                                removed: 0,
                            },
                        ]),
                        theme,
                        context,
                        { label: "Patch", state: "success" },
                    );
                } else {
                    let sign = "-";
                    if (kind === "edit") sign = "+";

                    const result = {
                        content: [],
                        details: {
                            diff: source
                                .map((text, index) => `${sign}${index + 1} ${text}`)
                                .join("\n"),
                        },
                    };
                    if (kind === "edit") {
                        previous = edit.renderEditResult(
                            result,
                            { expanded: true, isPartial: false },
                            theme,
                            context,
                            PREVIEW_MUTATION_SETTINGS,
                        );
                    } else {
                        previous = deletion.renderDeleteCall(
                            { path },
                            theme,
                            { ...context, result },
                            "static",
                            PREVIEW_MUTATION_SETTINGS,
                        );
                    }
                }

                return previous.render(100);
            };

            const cold = redraw();
            await settleSyntaxHighlights();
            expect(invalidate).toHaveBeenCalled();

            // The host rebuilds the tool row after its completion callback.
            const settled = redraw();
            expect(settled).not.toEqual(cold);
            const completions = invalidate.mock.calls.length;
            for (let revision = 0; revision < 4; revision += 1) {
                expect(redraw()).toEqual(settled);
                await settleSyntaxHighlights();
                expect(invalidate).toHaveBeenCalledTimes(completions);
            }

            expect(settled.map(stripVTControlCharacters)).toEqual(
                cold.map(stripVTControlCharacters),
            );

            expect(settled.length).toBeGreaterThan(300);
            previous = undefined;
            redraw();
            await settleSyntaxHighlights();
            expect(redraw()).toEqual(settled);
        },
    );
});
