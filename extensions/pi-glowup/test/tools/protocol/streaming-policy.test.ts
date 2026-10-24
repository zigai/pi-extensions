import { afterEach, describe, expect, it } from "vitest";
import { createProtocolRenderer } from "../../../src/tools/protocol/renderer.ts";
import { createGenericRenderer } from "../../../src/tools/call-rendering.ts";
import { compactPresentation, outlinePresentation } from "../../../src/rendering/presentation.ts";
import { selectGlowupPresentation } from "../../../src/rendering/presentation-registry.ts";
import { createThirdPartyToolRenderer } from "../../../src/tools/renderers.ts";
import { registerGlowupToolRenderer } from "../../../src/presentation.ts";
import {
    code,
    output,
    stack,
    decodeGlowupNode,
    registerGlowupStreamingPolicy,
} from "../../../src/tools/protocol/contract.ts";
import type { ThirdPartyToolRenderContext } from "../../../src/tools/types.ts";

const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value };
const context: ThirdPartyToolRenderContext = {
    toolCallId: "same-call",
    args: {},
    argsComplete: true,
    executionStarted: true,
    isPartial: true,
    isError: false,
    expanded: true,
    showImages: false,
};
afterEach(() => {
    selectGlowupPresentation("compact");
});

describe("tool generated-content contract", () => {
    it.each([
        ["agent_browser", { script: "const LEGACY_PENDING =" }],
        ["mcp__chrome-devtools__evaluate_script", { function: "() => { const LEGACY_PENDING =" }],
    ] as const)("routes existing %s code previews through the same gate", (toolName, args) => {
        const inputs: Array<{ complete: boolean; source: string }> = [];
        const renderer = createThirdPartyToolRenderer(toolName, {
            streamCode: (input) => {
                inputs.push(input);
                return "CODE_GATE";
            },
        });
        const rendered = renderer
            .renderCall(args, theme, { ...context, argsComplete: false })
            .render(80)
            .join("\n");
        expect(rendered).toContain("CODE_GATE");
        expect(rendered).not.toContain("LEGACY_PENDING");
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.complete).toBe(false);
    });

    it.each(["compact", "outline"])(
        "gates %s partial results independently from completed arguments and call streams",
        (presentation) => {
            selectGlowupPresentation(presentation);
            const inputs: Array<{ key: string; complete: boolean }> = [];
            const renderer = createProtocolRenderer(
                {
                    version: 3,
                    parseArgs: (value) => value,
                    parseResult: (value) => value,
                    renderCall: () => code("CALL", { syntax: { language: "javascript" } }),
                    renderResult: () =>
                        code("RESULT unfinished =", { syntax: { language: "javascript" } }),
                },
                createGenericRenderer("test"),
                "static",
                undefined,
                (input) => {
                    inputs.push(input);
                    return input.complete ? input.source : "";
                },
            );
            expect(renderer.renderCall({}, theme, context).render(80).join("\n")).toContain("CALL");
            expect(
                renderer
                    .renderResult({}, { expanded: true, isPartial: true }, theme, context)
                    .render(80)
                    .join("\n"),
            ).not.toContain("unfinished");
            expect(inputs.map((input) => input.complete)).toEqual([true, false]);
            expect(inputs[0]?.key).not.toBe(inputs[1]?.key);
            expect(
                renderer
                    .renderResult({}, { expanded: true, isPartial: false }, theme, context)
                    .render(80)
                    .join("\n"),
            ).toContain("unfinished");
            expect(
                renderer
                    .renderResult({}, { expanded: true, isPartial: true }, theme, {
                        ...context,
                        isError: true,
                    })
                    .render(80)
                    .join("\n"),
            ).toContain("unfinished");
        },
    );

    it.each([compactPresentation, outlinePresentation])(
        "shares generated prose policy but leaves ordinary output immediate",
        (presentation) => {
            const seen: string[] = [];
            const handle = registerGlowupStreamingPolicy({
                present(input) {
                    seen.push(input.key);
                    return input.complete ? input.source : "";
                },
                settled: async () => {},
            });
            try {
                const node = stack([
                    output("stdout unfinished", { syntax: { language: "javascript" } }),
                    output("child unfinished", {
                        streaming: { kind: "markdown", complete: false, key: "child-a" },
                    }),
                    output("explicit raw", {
                        streaming: { kind: "markdown", complete: false, mode: "immediate" },
                    }),
                ]);
                const rendered = presentation
                    .renderNode(node, theme, context, "static")
                    .render(80)
                    .join("\n");
                expect(rendered).toContain("stdout unfinished");
                expect(rendered).toContain("explicit raw");
                expect(rendered).not.toContain("child unfinished");
                expect(seen).toHaveLength(1);
                expect(seen[0]).toContain("child-a");
            } finally {
                handle.dispose();
            }
        },
    );

    it("passes code streaming through public renderer contributions", () => {
        const registration = registerGlowupToolRenderer(
            "streaming-test",
            (name) => name === "contributed",
            {
                version: 3,
                parseArgs: (value) => value,
                renderCall: () => code("unfinished", { syntax: { language: "javascript" } }),
            },
        );
        try {
            const renderer = createThirdPartyToolRenderer("contributed", {
                streamCode: () => "GATED",
            });
            const rendered = renderer.renderCall({}, theme, context).render(80).join("\n");
            expect(rendered).toContain("GATED");
            expect(rendered).not.toContain("unfinished");
        } finally {
            registration.dispose();
        }
    });

    it("decodes detached streaming declarations and rejects invalid policy fields", () => {
        const streaming = {
            kind: "markdown" as const,
            complete: false,
            key: "child",
            mode: "inherit" as const,
        };
        const node = output("source", { streaming });
        const decoded = decodeGlowupNode(node);
        expect(decoded).toEqual(node);
        expect(decoded).not.toBe(node);
        expect(decoded?.kind === "output" && decoded.streaming).not.toBe(streaming);
        expect(decodeGlowupNode({ ...node, streaming: { kind: "terminal" } })).toBeUndefined();
        expect(
            decodeGlowupNode({ ...node, streaming: { ...streaming, complete: "yes" } }),
        ).toBeUndefined();
    });
});
