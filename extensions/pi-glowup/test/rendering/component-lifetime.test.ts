import { queryObjects } from "node:v8";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderOutlineNode } from "../../src/rendering/outline.ts";
import { renderWriteCallPreview } from "../../src/tools/built-in/write-preview.ts";
import { createCodemodeRenderer } from "../../src/tools/external/codemode.ts";
import { renderProtocolNode } from "../../src/tools/protocol/node-renderer.ts";
import type { GlowupMutationNode } from "../../src/tools/protocol/contract.ts";
import type { ThirdPartyToolRenderContext } from "../../src/tools/types.ts";
import { createPlainTheme } from "../support/plain-theme.ts";

const theme = createPlainTheme();
const codemode = createCodemodeRenderer("static", {
    get: (_toolCallId, source) => source,
    observe: (_toolCallId, invalidate) => invalidate,
});

function renderSnapshot(
    renderer: string,
    source: string,
    context: ThirdPartyToolRenderContext,
): Component {
    switch (renderer) {
        case "codemode":
            return codemode.renderCall({ code: source }, theme, context);
        case "write":
            return renderWriteCallPreview({ path: "example.ts", content: source }, theme, {
                ...context,
                streamCode: (input) => input.source,
            });
        case "protocol":
            return renderProtocolNode({ kind: "code", text: source }, theme, context, "static");
        case "protocol-stack":
            return renderProtocolNode(
                { kind: "stack", children: [{ kind: "code", text: source }] },
                theme,
                context,
                "static",
            );
        case "outline":
            return renderOutlineNode({ kind: "code", text: source }, theme, context, "static");
        default:
            throw new Error(`Unknown renderer: ${renderer}`);
    }
}

describe("streaming component ownership", () => {
    it("preserves same-call mutation component reuse without crossing tool calls", () => {
        const context: ThirdPartyToolRenderContext = {
            args: {},
            toolCallId: "mutation-one",
            argsComplete: true,
            isPartial: false,
            isError: false,
            expanded: false,
            showImages: false,
        };
        const node = (source: string): GlowupMutationNode => ({
            kind: "mutation",
            labels: { static: "Patch" },
            files: [
                {
                    path: "example.ts",
                    lines: [{ kind: "addition", text: source }],
                    added: 1,
                    removed: 0,
                },
            ],
        });

        const first = renderProtocolNode(node("const before = 1;"), theme, context, "static");
        const updated = renderProtocolNode(
            node("const after = 2;"),
            theme,
            { ...context, lastComponent: first },
            "static",
        );
        expect(updated).toBe(first);
        expect(updated.render(80).join("\n")).toContain("const after = 2;");

        const independent = renderProtocolNode(
            node("const other = 3;"),
            theme,
            { ...context, toolCallId: "mutation-two", lastComponent: updated },
            "static",
        );
        expect(independent).not.toBe(updated);
        expect(updated.render(80).join("\n")).toContain("const after = 2;");
        expect(independent.render(80).join("\n")).toContain("const other = 3;");
    });

    it.each(["codemode", "write", "protocol", "protocol-stack", "outline"])(
        "%s releases previous snapshots while the newest component remains live",
        (renderer) => {
            class PreviousSnapshot {
                render(): string[] {
                    return ["obsolete snapshot"];
                }

                invalidate(): void {}
            }

            function createCurrentComponent(): Component {
                let current: Component = new PreviousSnapshot();
                for (let index = 0; index < 100; index += 1) {
                    const source = `const marker = ${index};`;
                    current = renderSnapshot(renderer, source, {
                        args: { code: source },
                        toolCallId: "one-streaming-call",
                        argsComplete: false,
                        isPartial: true,
                        isError: false,
                        expanded: false,
                        showImages: false,
                        lastComponent: current,
                    });
                }

                return current;
            }

            const current = createCurrentComponent();
            // V8 performs a full collection; assert reachability rather than a heap/time threshold.
            expect(queryObjects(PreviousSnapshot, { format: "count" })).toBe(0);
            expect(current.render(80).join("\n")).toContain("const marker = 99;");
            expect(current.render(40).join("\n")).toContain("const marker = 99;");
        },
    );
});
