import { describe, expect, it } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import {
    renderSuccessfulWriteResultFallback,
    renderWriteCallPreview,
} from "../src/rendering/write-rendering.ts";

const plainTheme: CodexRenderTheme = {
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

describe("write rendering", () => {
    it("renders successful write content from call arguments", () => {
        const component = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            plainTheme,
            { isError: false, isPartial: false, expanded: false },
        );

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("Write src/example.ts (+1 -0)");
        expect(rendered).toContain("export const value = 1;");
    });

    it("uses dynamic write labels when enabled", () => {
        const component = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            plainTheme,
            { isError: false, isPartial: false, expanded: false, dynamicStatusLabels: true },
        );

        expect(component.render(100).join("\n")).toContain("Wrote src/example.ts (+1 -0)");
    });

    it("renders streaming write content from bounded incremental preview state", () => {
        let lastComponent: Component | undefined;
        let content = "";
        for (let index = 1; index <= 200; index += 1) {
            content += `export const value${index} = ${index};\n`;
            lastComponent = renderWriteCallPreview(
                { path: "src/generated.ts", content },
                plainTheme,
                {
                    isError: false,
                    isPartial: true,
                    expanded: false,
                    dynamicStatusLabels: true,
                    lastComponent,
                },
            );
            lastComponent.render(120);
        }

        const rendered = lastComponent?.render(120).join("\n") ?? "";

        expect(rendered).toContain("Writing src/generated.ts (+200 -0)");
        expect(rendered).toContain("export const value1 = 1;");
        expect(rendered).toContain("export const value19 = 19;");
        expect(rendered).toContain("… +181 lines (to expand)");
        expect(rendered).not.toContain("export const value100 = 100;");
    });

    it("does not double-count split CRLF line endings while streaming", () => {
        let lastComponent = renderWriteCallPreview(
            { path: "src/generated.ts", content: "export const value = 1;\r" },
            plainTheme,
            { isError: false, isPartial: true, expanded: false, dynamicStatusLabels: true },
        );

        lastComponent = renderWriteCallPreview(
            { path: "src/generated.ts", content: "export const value = 1;\r\n" },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                dynamicStatusLabels: true,
                lastComponent,
            },
        );

        expect(lastComponent.render(120).join("\n")).toContain("Writing src/generated.ts (+1 -0)");
    });

    it("hides successful byte-count output after rendering write content", () => {
        expect(
            renderSuccessfulWriteResultFallback({
                path: "src/example.ts",
                content: "export const value = 1;\n",
            })?.render(80),
        ).toEqual([]);
        expect(renderSuccessfulWriteResultFallback({ path: "src/example.ts" })).toBeUndefined();
    });
});
