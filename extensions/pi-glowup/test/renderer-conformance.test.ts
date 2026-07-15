import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";
import type { ThirdPartyToolResult } from "../src/third-party-tools/types.ts";

type RendererConformanceCase = {
    readonly family: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly callText: string;
    readonly result?: ThirdPartyToolResult;
};

const theme: CodexRenderTheme = {
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
        family: "apply-patch",
        toolName: "apply_patch",
        args: {
            patch: "*** Begin Patch\n*** Add File: value.ts\n+export const value = 1;\n*** End Patch",
        },
        callText: "Patch",
        result: result("Done!"),
    },
    {
        family: "agent-browser",
        toolName: "agent_browser",
        args: { args: ["open", "https://example.com"] },
        callText: "Browser",
        result: result("Opened https://example.com"),
    },
    {
        family: "mcp-gateway",
        toolName: "mcp",
        args: { connect: "chrome-devtools" },
        callText: "MCP",
        result: result("Connected"),
    },
    {
        family: "chrome-devtools",
        toolName: "mcp__chrome-devtools__take_snapshot",
        args: {},
        callText: "Browser Snapshot",
        result: result("Snapshot complete"),
    },
    {
        family: "finalize-plan",
        toolName: "finalize_plan",
        args: { markdown: "# Plan\n\nShip it." },
        callText: "Finalized Plan",
        result: result("Plan finalized"),
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
    },
    {
        family: "goal",
        toolName: "get_goal",
        args: {},
        callText: "Goal",
        result: result("active: Verify rendering"),
    },
    {
        family: "agent",
        toolName: "Agent",
        args: { description: "Inspect renderers", prompt: "Inspect tool rendering." },
        callText: "Agent",
        result: result("Agent completed"),
    },
    {
        family: "web-run",
        toolName: "web_run",
        args: { search_query: [{ q: "Pi documentation" }] },
        callText: "Searched the web",
        result: result("Search complete"),
    },
    {
        family: "image-generation",
        toolName: "imagegen",
        args: { prompt: "A deterministic terminal screenshot" },
        callText: "Image",
        result: result("Generated 1 image"),
    },
    {
        family: "image-viewing",
        toolName: "view_image",
        args: { path: "/tmp/世界/example.png" },
        callText: "Viewed Image",
        result: result("Image Size: 100x100"),
    },
    {
        family: "generic-third-party",
        toolName: "unknown_tool",
        args: { nested: { value: "hello 世界" } },
        callText: "Called unknown_tool",
        result: result("Generic result"),
    },
];

function renderedLines(testCase: RendererConformanceCase, width: number): string[] {
    const renderer = createThirdPartyToolRenderer(testCase.toolName, {
        labelMode: "lifecycle",
    });
    const call = renderer.renderCall(testCase.args, theme, context).render(width);
    if (testCase.result === undefined) return call;
    return [
        ...call,
        ...renderer
            .renderResult(testCase.result, { expanded: false, isPartial: false }, theme, context)
            .render(width),
    ];
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
            const lines = renderedLines(testCase, width);
            expect(lines.join("\n"), `${testCase.family} at width ${width}`).toContain(
                testCase.callText,
            );
            for (const line of lines) {
                expect(
                    visibleWidth(line),
                    `${testCase.family} exceeded width ${width}`,
                ).toBeLessThanOrEqual(width);
            }
        }
    });
});
