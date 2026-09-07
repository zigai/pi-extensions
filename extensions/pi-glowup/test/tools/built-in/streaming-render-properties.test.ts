import { fc } from "@fast-check/vitest";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import { renderWriteCallPreview } from "../../../src/tools/built-in/write-preview.ts";
import { reflowBashCommand } from "../../../src/tools/built-in/bash/command.ts";

const PROPERTY_SEED = 0x5eed_2026;
const PROPERTY_RUNS = 60;
const MAX_STREAMING_ROWS = 16;

const plainTheme: GlowupRenderTheme = {
    fg(_token: string, text: string): string {
        return text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

const atomicLines = [
    "export const asciiMarker = 1;",
    "export const emojiMarker = '🧪🚀';",
    "export const combiningMarker = 'e\u0301';",
    `export const longAtomicMarker = '${"atomic".repeat(48)}';`,
] as const;

const writeScenarioArbitrary = fc.record({
    widthSequence: fc.array(fc.integer({ min: 12, max: 180 }), {
        minLength: 3,
        maxLength: 9,
    }),
    truncateAt: fc.integer({ min: 0, max: atomicLines.length - 1 }),
    rewrittenSuffix: fc.constantFrom("REWRITTEN_ONE", "REWRITTEN_TWO", "REWRITTEN_🧪"),
});

const shellChainArbitrary = fc.record({
    commands: fc.array(
        fc
            .array(fc.constantFrom("alpha", "beta", "gamma", "--flag", "value", "path/file"), {
                minLength: 1,
                maxLength: 5,
            })
            .map((words) => words.join(" ")),
        { minLength: 2, maxLength: 12 },
    ),
    operators: fc.array(fc.constantFrom("&&" as const, "||" as const), {
        minLength: 1,
        maxLength: 11,
    }),
});

function rotatedAtomicLines(rotation: number): readonly string[] {
    return [...atomicLines.slice(rotation), ...atomicLines.slice(0, rotation)];
}

function expectBoundedFrame(lines: readonly string[], width: number): void {
    expect(lines.length).toBeLessThanOrEqual(MAX_STREAMING_ROWS);

    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
    }
}

test("keeps append-truncate-rewrite write previews cache-equivalent across width changes", () => {
    fc.assert(
        fc.property(writeScenarioArbitrary, (scenario) => {
            const sourceLines = rotatedAtomicLines(scenario.truncateAt);
            for (const movingViewport of [false, true]) {
                let lastComponent: Component | undefined;
                let updateIndex = 0;
                const checkUpdate = (content: string, path = "src/generated.ts"): Component => {
                    const context = {
                        toolCallId: "write-stream-1",
                        isError: false,
                        isPartial: true,
                        expanded: false,
                        labelMode: "lifecycle" as const,
                        movingViewport,
                    };
                    const args = { path, content };
                    const cached = renderWriteCallPreview(args, plainTheme, {
                        ...context,
                        lastComponent,
                    });
                    const cold = renderWriteCallPreview(args, plainTheme, context);
                    const width =
                        scenario.widthSequence[updateIndex % scenario.widthSequence.length] ?? 80;
                    updateIndex += 1;

                    // Compare before another update can mutate the reused component.
                    for (const frameWidth of [width, Math.max(100, width)]) {
                        const frame = cached.render(frameWidth);
                        expect(frame).toEqual(cold.render(frameWidth));
                        expectBoundedFrame(frame, frameWidth);
                    }

                    lastComponent = cached;
                    return cached;
                };

                let content = "";
                for (const sourceLine of sourceLines) {
                    content += `${sourceLine}\r\n`;
                    checkUpdate(content);
                }

                const truncatedContent = sourceLines.slice(0, scenario.truncateAt).join("\n");
                checkUpdate(truncatedContent);

                // Keep the changed row visible in both head and moving-tail viewports.
                const longSuffix = `\n// ${"x".repeat(40)}\nexport const tail = true;\n`;
                const prefixA = `export const head = 'AAAA_${scenario.rewrittenSuffix}';`;
                const prefixB = `export const head = 'BBBB_${scenario.rewrittenSuffix}';`;
                checkUpdate(`${prefixA}${longSuffix}`, "src/rewritten.ts");
                const rewrittenPrefix = checkUpdate(`${prefixB}${longSuffix}`, "src/rewritten.ts");
                const prefixText = rewrittenPrefix.render(100).join("\n");
                expect(prefixText).toContain(`BBBB_${scenario.rewrittenSuffix}`);
                expect(prefixText).not.toContain(`AAAA_${scenario.rewrittenSuffix}`);
                checkUpdate(
                    `${prefixB}${longSuffix}export const appended = 'after_rewrite';\n`,
                    "src/rewritten.ts",
                );

                const rewritten = checkUpdate(
                    `${truncatedContent}\nexport const rewritten = '${scenario.rewrittenSuffix}';\n`,
                    "src/rewritten.ts",
                );
                const rewrittenText = rewritten.render(100).join("\n");
                expect(rewrittenText).toContain("src/rewritten.ts");
                expect(rewrittenText).toContain(scenario.rewrittenSuffix);

                for (const removedLine of sourceLines.slice(scenario.truncateAt)) {
                    expect(rewrittenText).not.toContain(removedLine);
                }
            }
        }),
        { seed: PROPERTY_SEED + 2, numRuns: PROPERTY_RUNS },
    );
});

test("preserves every generated top-level shell-chain segment and operator", () => {
    fc.assert(
        fc.property(shellChainArbitrary, (scenario) => {
            const command = scenario.commands
                .map((part, index) => {
                    if (index === 0) return part;
                    const operator =
                        scenario.operators[(index - 1) % scenario.operators.length] ?? "&&";

                    return `${operator} ${part}`;
                })
                .join(" ");
            const expectedLines = [scenario.commands[0] ?? ""];
            for (const [index, part] of scenario.commands.slice(1).entries()) {
                const operator = scenario.operators[index % scenario.operators.length] ?? "&&";
                if (operator === "&&") {
                    expectedLines[expectedLines.length - 1] += ` ${operator}`;
                    expectedLines.push(part);
                } else {
                    expectedLines[expectedLines.length - 1] += ` ${operator} ${part}`;
                }
            }

            const expected = expectedLines.length > 1 ? expectedLines.join("\n") : undefined;
            expect(reflowBashCommand(command)).toBe(expected);
        }),
        { seed: PROPERTY_SEED + 3, numRuns: PROPERTY_RUNS },
    );
});
