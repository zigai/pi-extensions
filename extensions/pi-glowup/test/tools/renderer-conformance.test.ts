import { visibleWidth } from "@earendil-works/pi-tui";
import type { JsonValue } from "../../src/json-value.ts";
import { describe, expect, it } from "vitest";
import type { GlowupRenderTheme } from "../../src/rendering/theme.ts";
import { createThirdPartyToolRenderer } from "../../src/tools/renderers.ts";
import type { ThirdPartyToolResult } from "../../src/tools/types.ts";

type RendererConformanceCase = {
    readonly family: string;
    readonly toolName: string;
    readonly args: JsonValue;
    readonly callText: string;
    readonly result?: ThirdPartyToolResult;
    readonly resultText?: string | null;
};

const theme: GlowupRenderTheme = {
    fg(_token, text) {
        return text;
    },
    bg(_token, text) {
        return text;
    },
    bold(text) {
        return text;
    },
};

const context = {
    args: {},
    toolCallId: "conformance-call",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
};

const result = (text: string): ThirdPartyToolResult => ({
    content: [{ type: "text", text }],
});

const cases: ReadonlyArray<RendererConformanceCase> = [
    {
        family: "agent-browser",
        toolName: "agent_browser",
        args: { args: ["open", "https://example.com"] },
        callText: "Browser",
        result: result("Opened https://example.com"),
        resultText: "Opened",
    },
    {
        family: "mcp-gateway",
        toolName: "mcp",
        args: { connect: "chrome-devtools" },
        callText: "MCP",
        result: result("Connected"),
        resultText: "Connected",
    },
    {
        family: "chrome-devtools",
        toolName: "mcp__chrome-devtools__take_snapshot",
        args: {},
        callText: "Browser Snapshot",
        result: result("Snapshot complete"),
        resultText: "Snapshot complete",
    },
    {
        family: "finalize-plan",
        toolName: "finalize_plan",
        args: { markdown: "# Plan\n\nShip it." },
        callText: "Finalized Plan",
        result: result("Plan finalized"),
        resultText: null,
    },
    {
        family: "ask-user-question",
        toolName: "ask_user_question",
        args: {
            questions: [
                {
                    header: "Mode",
                    question: "Choose one?",
                    options: [{ label: "Safe", description: "Use safe mode" }],
                },
            ],
        },
        callText: "Asked User",
        result: result("Mode: Safe"),
        resultText: "Mode: Safe",
    },
    {
        family: "generic-third-party",
        toolName: "unknown_tool",
        args: { nested: { value: "hello 世界" } },
        callText: "Called unknown_tool",
        result: result("Generic result"),
        resultText: "Generic result",
    },
];

function renderCallLines(testCase: RendererConformanceCase, width: number): string[] {
    const renderer = createThirdPartyToolRenderer(testCase.toolName, {
        labelMode: "lifecycle",
    });
    return renderer.renderCall(testCase.args, theme, context).render(width);
}

function renderResultLines(testCase: RendererConformanceCase, width: number): string[] {
    if (testCase.result === undefined) return [];
    const renderer = createThirdPartyToolRenderer(testCase.toolName, {
        labelMode: "lifecycle",
    });
    return renderer
        .renderResult(testCase.result, { expanded: false, isPartial: false }, theme, context)
        .render(width);
}

function renderedLines(testCase: RendererConformanceCase, width: number): string[] {
    return [...renderCallLines(testCase, width), ...renderResultLines(testCase, width)];
}

describe("renderer family conformance", () => {
    it.each(cases)("$family survives the minimum defensive width", (testCase) => {
        const width = 8;
        const lines = renderedLines(testCase, width);
        for (const line of lines) {
            expect(
                visibleWidth(line),
                `${testCase.family} exceeded width ${width}`,
            ).toBeLessThanOrEqual(width);
        }
    });

    it.each(cases)("$family preserves semantic output", (testCase) => {
        for (const width of [23, 50, 100, 180]) {
            const call = renderCallLines(testCase, width);
            const res = renderResultLines(testCase, width);
            expect(call.join("\n"), `${testCase.family} call at width ${width}`).toContain(
                testCase.callText,
            );
            for (const line of [...call, ...res]) {
                expect(
                    visibleWidth(line),
                    `${testCase.family} exceeded width ${width}`,
                ).toBeLessThanOrEqual(width);
            }
        }
    });

    it.each(cases.filter((testCase) => testCase.resultText === null))(
        "$family suppresses redundant result output",
        (testCase) => {
            for (const width of [23, 50, 100, 180]) {
                expect(renderResultLines(testCase, width)).toEqual([]);
            }
        },
    );

    it.each(
        cases.filter(
            (testCase) => testCase.resultText !== undefined && testCase.resultText !== null,
        ),
    )("$family preserves result text", (testCase) => {
        for (const width of [23, 50, 100, 180]) {
            expect(renderResultLines(testCase, width).join("\n")).toContain(testCase.resultText);
        }
    });
});
