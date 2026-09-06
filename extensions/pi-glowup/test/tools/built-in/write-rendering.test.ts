import { beforeEach, describe, expect, it } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import {
    configureRenderingAppearance,
    type GlowupRenderTheme,
} from "../../../src/rendering/theme.ts";
import {
    renderSuccessfulWriteResultFallback,
    renderWriteCallPreview,
} from "../../../src/tools/built-in/write-preview.ts";
import {
    DEFAULT_MUTATION_SETTINGS,
    PREVIEW_MUTATION_SETTINGS,
} from "../../../src/rendering/preview-settings.ts";

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

const dimMarkerTheme: GlowupRenderTheme = {
    fg(token: string, text: string): string {
        return token === "dim" ? `<dim>${text}</dim>` : text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

const defaultAppearance = {
    diffBackgroundStyle: "two-tone",
    diffLineNumberStyle: "dual",
    narrowDiffLayout: "paired",
    sideBySideLayout: "content-aware",
    addedRowBackground: null,
    deletedRowBackground: null,
    addedContentBackground: null,
    deletedContentBackground: null,
    instructionPathColor: null,
    dimUnchangedDiffText: false,
} as const;

describe("write rendering", () => {
    beforeEach(() => configureRenderingAppearance(defaultAppearance));

    it("renders successful write content from call arguments", () => {
        const component = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            plainTheme,
            { isError: false, isPartial: false, expanded: false },
        );

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("Write src/example.ts (+1)");
        expect(rendered).toContain("export const value = 1;");
    });

    it("defers partial write paths until content starts streaming", () => {
        const component = renderWriteCallPreview({ path: "/tmp/part" }, plainTheme, {
            isError: false,
            isPartial: true,
            argsComplete: false,
            expanded: false,
        });

        expect(component.render(100)).toEqual([]);
    });

    it("uses dynamic write labels when enabled", () => {
        const component = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            plainTheme,
            { isError: false, isPartial: false, expanded: false, labelMode: "lifecycle" },
        );

        expect(component.render(100).join("\n")).toContain("Wrote src/example.ts (+1)");
    });

    it("does not render content or success statistics for failed writes", () => {
        const component = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            plainTheme,
            {
                isError: true,
                isPartial: false,
                expanded: false,
                labelMode: "lifecycle",
            },
        );
        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("Write src/example.ts");
        expect(rendered).not.toContain("export const value = 1;");
        expect(rendered).not.toContain("(+1)");
        expect(rendered).not.toContain("Wrote");
    });

    it("uses the Pi addition background for written content", () => {
        const backgroundTheme: GlowupRenderTheme = {
            ...plainTheme,
            bg(token, text) {
                return `<${token}>${text}</${token}>`;
            },
        };
        const rendered = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            backgroundTheme,
            { isError: false, isPartial: false, expanded: false },
        )
            .render(100)
            .join("\n");

        expect(rendered).toContain("<toolSuccessBg>");
        expect(rendered).not.toContain("<toolErrorBg>");
    });

    it("renders write previews as numbered addition rows", () => {
        const completed = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            dimMarkerTheme,
            { isError: false, isPartial: false, expanded: false },
        );
        const streaming = renderWriteCallPreview(
            { path: "src/example.ts", content: "export const value = 1;\n" },
            dimMarkerTheme,
            { isError: false, isPartial: true, expanded: false },
        );

        expect(completed.render(140).join("\n")).toContain("<dim>  1 </dim>+");
        expect(streaming.render(140).join("\n")).toContain("<dim>  1 </dim>+");
    });

    it("renders streaming write content with a moving tail viewport", () => {
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
                    labelMode: "lifecycle",
                    lastComponent,
                },
            );
            lastComponent.render(120);
        }

        const rendered = lastComponent?.render(120).join("\n") ?? "";

        expect(rendered).toMatch(/Writing src\/generated\.ts \(\+200\)/u);
        expect(rendered).not.toContain("export const value1 = 1;");
        expect(rendered).not.toContain("export const value3 = 3;");
        expect(rendered).toContain("export const value195 = 195;");
        expect(rendered).toContain("export const value200 = 200;");
        expect(rendered).toContain("… +194 lines (to expand)");
        expect(rendered).not.toContain("export const value19 = 19;");
        expect(rendered).not.toContain("export const value100 = 100;");
    });

    it("can disable the moving streaming write viewport", () => {
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
                    labelMode: "lifecycle",
                    movingViewport: false,
                    lastComponent,
                },
            );
            lastComponent.render(120);
        }

        const rendered = lastComponent?.render(120).join("\n") ?? "";

        expect(rendered).toContain("export const value1 = 1;");
        expect(rendered).toContain("export const value6 = 6;");
        expect(rendered).toContain("… +194 lines (to expand)");
        expect(rendered).not.toContain("export const value7 = 7;");
    });

    it("reveals the full streaming write when expanded", () => {
        const content = Array.from(
            { length: 40 },
            (_value, index) => `export const value${index + 1} = ${index + 1};`,
        ).join("\n");
        const component = renderWriteCallPreview(
            { path: "src/generated.ts", content },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: true,
                labelMode: "lifecycle",
            },
        );
        const rendered = component.render(120).join("\n");

        expect(rendered).toContain("export const value1 = 1;");
        expect(rendered).toContain("export const value40 = 40;");
        expect(rendered).not.toContain("to expand");
    });

    it.each([false, true])(
        "preserves every character of long expanded write lines when isPartial=%s",
        (isPartial) => {
            const content = "abcdefghijklmnopqrstuvwxyz".repeat(8);
            const component = renderWriteCallPreview(
                { path: "src/generated.ts", content },
                plainTheme,
                {
                    isError: false,
                    isPartial,
                    expanded: true,
                    labelMode: "lifecycle",
                },
            );
            const diffLines = component.render(40).slice(1);
            const reconstructed = diffLines
                .map((line, index) => {
                    if (index === 0) {
                        return line.slice(line.indexOf("+") + 1).trimEnd();
                    }
                    return line.trim();
                })
                .join("");

            expect(reconstructed).toBe(content);
            expect(diffLines.join("\n")).not.toContain("…");
        },
    );

    it("does not split emoji graphemes when bounding a streaming line", () => {
        const content = `${"a".repeat(1_998)}🧪Z`;
        const component = renderWriteCallPreview(
            { path: "src/generated.ts", content },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
            },
        );
        const rendered = component.render(2_200).join("\n");

        expect(Buffer.from(rendered, "utf8").toString("utf8")).toBe(rendered);
        expect(rendered).not.toContain("�");
    });

    it("keeps both ends of a completed collapsed write", () => {
        const content = Array.from(
            { length: 40 },
            (_value, index) => `export const value${index + 1} = ${index + 1};`,
        ).join("\n");
        const component = renderWriteCallPreview(
            { path: "src/generated.ts", content },
            plainTheme,
            { isError: false, isPartial: false, expanded: false, labelMode: "lifecycle" },
        );
        const rendered = component.render(120).join("\n");

        expect(rendered).toContain("export const value1 = 1;");
        expect(rendered).toContain("export const value40 = 40;");
        expect(rendered).not.toContain("export const value20 = 20;");
        expect(rendered).toContain("lines (to expand)");
    });

    it("renders every completed write row in the default full mutation view", () => {
        const content = Array.from(
            { length: 40 },
            (_value, index) => `export const value${index + 1} = ${index + 1};`,
        ).join("\n");
        const rendered = renderWriteCallPreview({ path: "src/generated.ts", content }, plainTheme, {
            isError: false,
            isPartial: false,
            expanded: false,
            mutationSettings: DEFAULT_MUTATION_SETTINGS,
        })
            .render(120)
            .join("\n");

        expect(rendered).toContain("value1 = 1");
        expect(rendered).toContain("value20 = 20");
        expect(rendered).toContain("value40 = 40");
        expect(rendered).not.toContain("to expand");
    });

    it("honors the configurable write preview byte limit", () => {
        const rendered = renderWriteCallPreview(
            { path: "src/generated.ts", content: "0123456789\n".repeat(20) },
            plainTheme,
            {
                isError: false,
                isPartial: false,
                expanded: false,
                mutationSettings: {
                    ...DEFAULT_MUTATION_SETTINGS,
                    limits: {
                        ...DEFAULT_MUTATION_SETTINGS.limits,
                        maxWritePreviewBytes: 80,
                    },
                },
            },
        )
            .render(120)
            .join("\n");

        expect(rendered).toContain("write preview truncated");
        expect(rendered).not.toContain("+20 0123456789");
    });

    it("honors the configurable completed preview row count", () => {
        const content = Array.from({ length: 12 }, (_value, index) => `line ${index + 1}`).join(
            "\n",
        );
        const lines = renderWriteCallPreview({ path: "src/generated.ts", content }, plainTheme, {
            isError: false,
            isPartial: false,
            expanded: false,
            mutationSettings: {
                ...PREVIEW_MUTATION_SETTINGS,
                previewLines: 4,
            },
        }).render(120);

        expect(lines).toHaveLength(6);
        expect(lines.join("\n")).toContain("… +8 lines (to expand)");
    });

    it("keeps streaming mutation counters compact without internal padding", () => {
        const singleDigit = renderWriteCallPreview(
            { path: "src/generated.ts", content: "one\n" },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
            },
        );
        const tripleDigit = renderWriteCallPreview(
            {
                path: "src/generated.ts",
                content: Array.from({ length: 100 }, (_value, index) => `line ${index}`).join("\n"),
            },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
            },
        );
        const singleRendered = singleDigit.render(120).join("\n");

        expect(singleRendered).toContain("(+1)");
        expect(singleRendered).not.toContain("(+  1)");
        expect(tripleDigit.render(120).join("\n")).toContain("(+100)");
    });

    it("does not double-count split CRLF line endings while streaming", () => {
        let lastComponent = renderWriteCallPreview(
            { path: "src/generated.ts", content: "export const value = 1;\r" },
            plainTheme,
            { isError: false, isPartial: true, expanded: false, labelMode: "lifecycle" },
        );

        lastComponent = renderWriteCallPreview(
            { path: "src/generated.ts", content: "export const value = 1;\r\n" },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                expanded: false,
                labelMode: "lifecycle",
                lastComponent,
            },
        );

        expect(lastComponent.render(120).join("\n")).toContain("Writing src/generated.ts (+1)");
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
