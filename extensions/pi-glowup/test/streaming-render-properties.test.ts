import { test, fc } from "@fast-check/vitest";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expect } from "vitest";
import { clearApplyPatchRenderingState } from "../src/rendering/apply-patch-rendering.ts";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";
import { renderWriteCallPreview } from "../src/rendering/write-rendering.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";

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

const streamScenarioArbitrary = fc.record({
    lineEnding: fc.constantFrom("\n", "\r\n"),
    rotation: fc.integer({ min: 0, max: atomicLines.length - 1 }),
    chunkSizes: fc.array(fc.integer({ min: 1, max: 43 }), {
        minLength: 2,
        maxLength: 18,
    }),
    widths: fc.array(fc.integer({ min: 8, max: 180 }), {
        minLength: 2,
        maxLength: 10,
    }),
    firstPath: fc.constantFrom("src/generated.ts", "src/unicode-λ.ts", "src/emoji-🧪.ts"),
    secondPath: fc.constantFrom("src/second.ts", "src/再生.ts", "src/combined-e\u0301.ts"),
});

const rewriteScenarioArbitrary = fc.record({
    width: fc.integer({ min: 18, max: 180 }),
    truncateDivisor: fc.integer({ min: 2, max: 6 }),
    obsoletePath: fc.constantFrom("src/obsolete.ts", "src/old-λ.ts"),
    currentPath: fc.constantFrom("src/current.ts", "src/new-🧪.ts"),
    obsoleteMarker: fc.constantFrom("OBSOLETE_ALPHA", "OBSOLETE_BETA"),
    currentMarker: fc.constantFrom("CURRENT_GAMMA", "CURRENT_DELTA"),
});

const writeScenarioArbitrary = fc.record({
    widthSequence: fc.array(fc.integer({ min: 12, max: 180 }), {
        minLength: 3,
        maxLength: 9,
    }),
    truncateAt: fc.integer({ min: 0, max: atomicLines.length - 1 }),
    rewrittenSuffix: fc.constantFrom("REWRITTEN_ONE", "REWRITTEN_TWO", "REWRITTEN_🧪"),
});

function rotatedAtomicLines(rotation: number): readonly string[] {
    return [...atomicLines.slice(rotation), ...atomicLines.slice(0, rotation)];
}

function buildMultiFilePatch(scenario: {
    readonly lineEnding: string;
    readonly rotation: number;
    readonly firstPath: string;
    readonly secondPath: string;
}): string {
    const lines = [
        "*** Begin Patch",
        `*** Add File: ${scenario.firstPath}`,
        ...rotatedAtomicLines(scenario.rotation).map((line) => `+${line}`),
        `*** Add File: ${scenario.secondPath}`,
        "+export const secondFileMarker = 'SECOND_FILE_BOUNDARY';",
        "*** End Patch",
    ];
    return lines.join(scenario.lineEnding);
}

function streamingPrefixes(patch: string, chunkSizes: readonly number[]): readonly string[] {
    const cuts = new Set<number>();
    let offset = 0;
    for (const chunkSize of chunkSizes) {
        offset = Math.min(patch.length, offset + chunkSize);
        cuts.add(offset);
        if (offset === patch.length) break;
    }
    for (let index = patch.indexOf("\r\n"); index >= 0; index = patch.indexOf("\r\n", index + 2)) {
        cuts.add(index + 1);
    }
    const secondSection = patch.indexOf("*** Add File:", patch.indexOf("*** Add File:") + 1);
    if (secondSection >= 0) {
        cuts.add(secondSection);
        cuts.add(Math.min(patch.length, secondSection + "*** Add File:".length));
    }
    cuts.add(patch.length);
    return [...cuts]
        .filter((cut) => cut > 0)
        .sort((left, right) => left - right)
        .map((cut) => patch.slice(0, cut));
}

function partialContext(toolCallId: string, lastComponent?: Component) {
    return {
        args: {},
        toolCallId,
        executionStarted: true,
        argsComplete: false,
        isPartial: true,
        expanded: false,
        showImages: false,
        isError: false,
        ...(lastComponent === undefined ? {} : { lastComponent }),
    };
}

function completedContext(toolCallId: string, lastComponent?: Component) {
    return {
        ...partialContext(toolCallId, lastComponent),
        argsComplete: true,
        isPartial: false,
    };
}

function expectBoundedFrame(lines: readonly string[], width: number): void {
    expect(lines.length).toBeLessThanOrEqual(MAX_STREAMING_ROWS);
    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
}

test.prop([streamScenarioArbitrary], {
    seed: PROPERTY_SEED,
    numRuns: PROPERTY_RUNS,
})(
    "keeps chunked multi-file apply_patch frames bounded, causal, and reference-equivalent",
    (scenario) => {
        clearApplyPatchRenderingState();
        const patch = buildMultiFilePatch(scenario);
        const prefixes = streamingPrefixes(patch, scenario.chunkSizes);
        const renderer = createThirdPartyToolRenderer("apply_patch", { labelMode: "lifecycle" });
        let lastComponent: Component | undefined;

        for (const [index, prefix] of prefixes.entries()) {
            const width = scenario.widths[index % scenario.widths.length] ?? 80;
            const component = renderer.renderCall(
                { patch: prefix },
                plainTheme,
                partialContext("call-streamed", lastComponent),
            );
            const frame = component.render(width);
            const reference = createThirdPartyToolRenderer("apply_patch", {
                labelMode: "lifecycle",
            })
                .renderCall({ patch: prefix }, plainTheme, partialContext("call-streamed"))
                .render(width);

            expectBoundedFrame(frame, width);
            expect(frame).toEqual(reference);
            const rendered = frame.join("\n");
            for (const futureContent of [
                ...atomicLines,
                scenario.firstPath,
                scenario.secondPath,
                "SECOND_FILE_BOUNDARY",
            ]) {
                if (!prefix.includes(futureContent)) {
                    expect(rendered).not.toContain(futureContent);
                }
            }
            lastComponent = component;
        }

        const finalWidth = scenario.widths.at(-1) ?? 100;
        const streamedFinal = renderer
            .renderCall({ patch }, plainTheme, completedContext("call-streamed", lastComponent))
            .render(finalWidth);
        const coldFinal = createThirdPartyToolRenderer("apply_patch", { labelMode: "lifecycle" })
            .renderCall({ patch }, plainTheme, completedContext("call-streamed"))
            .render(finalWidth);

        expectBoundedFrame(streamedFinal, finalWidth);
        expect(streamedFinal).toEqual(coldFinal);
    },
);

test.prop([rewriteScenarioArbitrary], {
    seed: PROPERTY_SEED + 1,
    numRuns: PROPERTY_RUNS,
})(
    "removes truncated and rewritten patch state and isolates tool-call component identity",
    (scenario) => {
        clearApplyPatchRenderingState();
        const renderer = createThirdPartyToolRenderer("apply_patch", { labelMode: "lifecycle" });
        const obsoletePatch = [
            "*** Begin Patch",
            `*** Add File: ${scenario.obsoletePath}`,
            `+export const obsolete = '${scenario.obsoleteMarker}';`,
            "+export const obsoleteTail = 'STALE_TAIL';",
        ].join("\n");
        const currentPatch = [
            "*** Begin Patch",
            `*** Add File: ${scenario.currentPath}`,
            `+export const current = '${scenario.currentMarker}';`,
        ].join("\n");
        const first = renderer.renderCall(
            { patch: obsoletePatch },
            plainTheme,
            partialContext("call-obsolete"),
        );
        first.render(scenario.width);
        const truncated = renderer.renderCall(
            {
                patch: obsoletePatch.slice(
                    0,
                    Math.floor(obsoletePatch.length / scenario.truncateDivisor),
                ),
            },
            plainTheme,
            partialContext("call-obsolete", first),
        );
        expectBoundedFrame(truncated.render(scenario.width), scenario.width);
        const rewritten = renderer.renderCall(
            { patch: currentPatch },
            plainTheme,
            partialContext("call-obsolete", truncated),
        );
        const rewrittenFrame = rewritten.render(scenario.width);
        const coldRewrite = createThirdPartyToolRenderer("apply_patch", { labelMode: "lifecycle" })
            .renderCall({ patch: currentPatch }, plainTheme, partialContext("call-obsolete"))
            .render(scenario.width);
        const semanticWidth = Math.max(80, scenario.width);
        const rewrittenText = rewritten.render(semanticWidth).join("\n");

        expect(rewritten).toBe(first);
        expect(rewrittenText).toContain(scenario.currentPath);
        expect(rewrittenText).toContain(scenario.currentMarker);
        expect(rewrittenText).not.toContain(scenario.obsoletePath);
        expect(rewrittenText).not.toContain(scenario.obsoleteMarker);
        expect(rewrittenText).not.toContain("STALE_TAIL");
        expect(rewrittenFrame).toEqual(coldRewrite);
        expectBoundedFrame(rewrittenFrame, scenario.width);

        const isolated = renderer.renderCall(
            { patch: currentPatch },
            plainTheme,
            partialContext("call-independent", rewritten),
        );
        expect(isolated).not.toBe(rewritten);
        expect(isolated.render(scenario.width)).toEqual(
            createThirdPartyToolRenderer("apply_patch", { labelMode: "lifecycle" })
                .renderCall({ patch: currentPatch }, plainTheme, partialContext("call-independent"))
                .render(scenario.width),
        );
    },
);

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
        const rewrittenContent = `${truncatedContent}\nexport const rewritten = '${scenario.rewrittenSuffix}';\n`;
        const finalWidth = scenario.widthSequence.at(-1) ?? 100;
        const rewritten = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: rewrittenContent },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent,
            },
        );
        const cold = renderWriteCallPreview(
            { path: "src/rewritten.ts", content: rewrittenContent },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
            },
        );
        const rewrittenFrame = rewritten.render(finalWidth);
        const semanticWidth = Math.max(100, finalWidth);
        const rewrittenText = rewritten.render(semanticWidth).join("\n");

        expect(rewrittenFrame).toEqual(cold.render(finalWidth));
        expectBoundedFrame(rewrittenFrame, finalWidth);
        expect(rewrittenText).toContain("src/rewritten.ts");
        expect(rewrittenText).toContain(scenario.rewrittenSuffix);
        for (const removedLine of sourceLines.slice(scenario.truncateAt)) {
            expect(rewrittenText).not.toContain(removedLine);
        }
    },
);
