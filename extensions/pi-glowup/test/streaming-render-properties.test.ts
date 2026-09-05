import { test, fc } from "@fast-check/vitest";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";
import { renderWriteCallPreview } from "../src/rendering/write-rendering.ts";
import { reflowBashCommand } from "../src/script-preview/bash-analysis.ts";

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

test.prop([writeScenarioArbitrary], {
    seed: PROPERTY_SEED + 2,
    numRuns: PROPERTY_RUNS,
})(
    "keeps append-truncate-rewrite write previews cache-equivalent across width changes",
    (scenario) => {
        const sourceLines = rotatedAtomicLines(scenario.truncateAt);
        let lastComponent: Component | undefined;
        let content = "";

        for (const [index, sourceLine] of sourceLines.entries()) {
            content += `${sourceLine}\r\n`;
            const width = scenario.widthSequence[index % scenario.widthSequence.length] ?? 80;
            const cached = renderWriteCallPreview(
                { path: "src/generated.ts", content },
                plainTheme,
                {
                    isError: false,
                    isPartial: true,
                    expanded: false,
                    labelMode: "lifecycle",
                    lastComponent,
                },
            );
            const reference = renderWriteCallPreview(
                { path: "src/generated.ts", content },
                plainTheme,
                {
                    isError: false,
                    isPartial: true,
                    expanded: false,
                    labelMode: "lifecycle",
                },
            );
            expect(cached.render(width)).toEqual(reference.render(width));
            expectBoundedFrame(cached.render(width), width);
            lastComponent = cached;
        }

        const truncatedContent = sourceLines.slice(0, scenario.truncateAt).join("\n");
        const truncated = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: truncatedContent },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent,
            },
        );
        lastComponent = truncated;

        // Long suffix (> 32 chars) so prefix changes with identical suffix can test PartialWriteContentPreview.canAppend
        const longSuffix = "\n// " + "x".repeat(40) + "\nexport const tail = true;\n";
        const prefixA = "export const head = 'AAAA';";
        const prefixB = "export const head = 'BBBB';";
        const sameSuffixContentA = `${prefixA}${longSuffix}`;
        const sameSuffixContentB = `${prefixB}${longSuffix}`;

        const suffixStreamA = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: sameSuffixContentA },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent,
            },
        );
        lastComponent = suffixStreamA;

        const finalWidth = scenario.widthSequence.at(-1) ?? 100;

        // Deliver same-length prefix rewrite with matching suffix
        const suffixStreamB = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: sameSuffixContentB },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent,
            },
        );
        lastComponent = suffixStreamB;

        // Append content after the rewrite
        const appendedAfterRewriteContent = `${sameSuffixContentB}export const appended = 'after_rewrite';\n`;
        const appendedAfterRewrite = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: appendedAfterRewriteContent },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent,
            },
        );

        const coldAppended = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: appendedAfterRewriteContent },
            plainTheme,
            {
                toolCallId: "cold-appended",
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
            },
        );

        const rewrittenContent = `${truncatedContent}\nexport const rewritten = '${scenario.rewrittenSuffix}';\n`;
        const rewritten = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: rewrittenContent },
            plainTheme,
            {
                toolCallId: "write-stream-1",
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent: appendedAfterRewrite,
            },
        );
        const cold = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: rewrittenContent },
            plainTheme,
            {
                toolCallId: "cold-rewritten",
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
            },
        );
        const rewrittenFrame = rewritten.render(finalWidth);
        const semanticWidth = Math.max(100, finalWidth);
        const rewrittenText = rewritten.render(semanticWidth).join("\n");

        expect(appendedAfterRewrite.render(finalWidth)).toEqual(coldAppended.render(finalWidth));
        expect(rewrittenFrame).toEqual(cold.render(finalWidth));
        expectBoundedFrame(rewrittenFrame, finalWidth);
        expect(rewrittenText).toContain("src/rewritten.ts");
        expect(rewrittenText).toContain(scenario.rewrittenSuffix);
        for (const removedLine of sourceLines.slice(scenario.truncateAt)) {
            expect(rewrittenText).not.toContain(removedLine);
        }
    },
);

test.prop([shellChainArbitrary], {
    seed: PROPERTY_SEED + 3,
    numRuns: PROPERTY_RUNS,
})("preserves every generated top-level shell-chain segment and operator", (scenario) => {
    const command = scenario.commands
        .map((part, index) => {
            if (index === 0) return part;
            const operator = scenario.operators[(index - 1) % scenario.operators.length] ?? "&&";
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
});
