import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";

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

const renderContext = {
    args: {},
    toolCallId: "call-apply-patch",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
};

const samplePatch = `*** Begin Patch
*** Update File: README.md
@@
-old heading
+new heading
*** Add File: src/new.ts
+export const answer = 42;
+console.log(answer);
*** End Patch`;

function expectLinesWithinWidth(lines: ReadonlyArray<string>, width: number): void {
    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
}

describe("apply_patch renderer", () => {
    it("shows every file and its bounded diff before expansion", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const collapsedLines = renderer
            .renderCall({ patch: samplePatch }, plainTheme, renderContext)
            .render(100);
        const collapsed = collapsedLines.join("\n");
        const expandedLines = renderer
            .renderCall({ patch: samplePatch }, plainTheme, {
                ...renderContext,
                expanded: true,
            })
            .render(100);
        const expanded = expandedLines.join("\n");

        expect(collapsedLines).toHaveLength(7);
        expect(collapsed).toContain("• Edited README.md (+1 -1)");
        expect(collapsed).toContain("• Added src/new.ts (+2)");
        expect(collapsed).not.toContain("files");
        expect(collapsed).not.toMatch(/[├└]/u);
        expect(collapsed).toContain("README.md");
        expect(collapsed).toContain("old heading");
        expect(collapsed).toContain("+export const answer = 42;");
        expect(expanded).toContain("• Edited README.md (+1 -1)");
        expect(expanded).toContain("• Added src/new.ts (+2)");
        expect(expanded).toContain("-old heading");
        expect(expanded).toContain("+new heading");
        expect(expanded).toContain("+export const answer = 42;");
        expectLinesWithinWidth(collapsedLines, 100);
        expectLinesWithinWidth(expandedLines, 100);
    });

    it("does not invent separators between update chunks", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch
*** Update File: src/example.ts
@@
-const one = 1;
+const one = 2;
@@
-const two = 2;
+const two = 3;
*** End Patch`;
        const rendered = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(rendered).toContain("-const one = 1;");
        expect(rendered).toContain("+const two = 3;");
        expect(rendered).not.toContain("⋮");
        expect(rendered).not.toContain("...");
        expect(rendered).not.toMatch(/\d+ -const/u);
    });

    it("uses real line numbers only when hunk coordinates provide them", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch
*** Update File: src/example.ts
@@ -20,1 +30,1 @@
-const value = 1;
+const value = 2;
*** End Patch`;
        const rendered = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(rendered).toContain("20 -const value = 1;");
        expect(rendered).toContain("30 +const value = 2;");
    });

    it("leaves successful results empty when the call already rendered the patch", () => {
        const renderer = createThirdPartyToolRenderer("pi-codex-core__apply_patch", {
            labelMode: "lifecycle",
        });
        const result = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: "Success. Updated the following files:\nM README.md\n",
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args: { patch: samplePatch } },
            )
            .render(80);

        expect(result).toEqual([]);
    });

    it("renders failed applications with the Codex failure title", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const lines = renderer
            .renderResult(
                { content: [{ type: "text", text: "Invalid patch: missing header" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args: { patch: "bad" }, isError: true },
            )
            .render(80);
        const rendered = lines.join("\n");

        expect(lines[0]?.trimEnd()).toBe("• Failed to apply patch");
        expect(rendered).not.toContain("✘ Failed to apply patch");
        expect(rendered).toContain("Invalid patch: missing header");
        expectLinesWithinWidth(lines, 80);
    });

    it("shows the latest file and diff tail while patch arguments stream", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const partialPatch = `${samplePatch.replace("*** End Patch", "")}\n${"+extra\n".repeat(1_000)}`;
        const lines = renderer
            .renderCall({ patch: partialPatch }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100);
        const rendered = lines.join("\n");

        expect(rendered).toMatch(/• Editing src\/new\.ts \(\+1002\)/u);
        expect(lines).toHaveLength(7);
        expect(rendered).toContain("997 +extra");
        expect(rendered).toContain("1002 +extra");
        expect(rendered).not.toContain("earlier patch lines");
        expect(rendered).not.toContain("README.md");
        expectLinesWithinWidth(lines, 100);
    });

    it("keeps the beginning and end of a completed collapsed patch", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch\n*** Add File: src/generated.ts\n${Array.from(
            { length: 40 },
            (_value, index) => `+export const value${index + 1} = ${index + 1};\n`,
        ).join("")}*** End Patch`;
        const rendered = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(120)
            .join("\n");

        expect(rendered).toContain("export const value1 = 1;");
        expect(rendered).toContain("export const value40 = 40;");
        expect(rendered).not.toContain("export const value20 = 20;");
        expect(rendered).toContain("… +34 lines (to expand)");
    });

    it("shows a six-line replacement without an unnecessary omission", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch
*** Update File: colors.ts
@@
-export const color03 = 3;
-export const color04 = 4;
-export const color05 = 5;
+export const color03 = 30;
+export const color04 = 40;
+export const color05 = 50;
*** End Patch`;
        const lines = renderer.renderCall({ patch }, plainTheme, renderContext).render(120);
        const rendered = lines.join("\n");

        expect(lines).toHaveLength(7);
        expect(rendered).toContain("-export const color03 = 3;");
        expect(rendered).toContain("+export const color03 = 30;");
        expect(rendered).toContain("+export const color05 = 50;");
        expect(rendered).not.toContain("to expand");
    });

    it("renders every multi-file diff before expansion", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const filePatch = (name: string): string =>
            `*** Add File: ${name}.ts\n${Array.from(
                { length: 30 },
                (_value, index) => `+export const ${name}${index + 1} = ${index + 1};\n`,
            ).join("")}`;
        const patch = `*** Begin Patch\n${["first", "second", "third", "fourth"]
            .map(filePatch)
            .join("")}*** End Patch`;
        const collapsedLines = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(160);
        const collapsed = collapsedLines.join("\n");
        const expanded = renderer
            .renderCall({ patch }, plainTheme, { ...renderContext, expanded: true })
            .render(160)
            .join("\n");

        expect(collapsedLines).toHaveLength(35);
        expect(collapsed).not.toContain("files");
        expect(collapsed).toContain("• Added first.ts (+30)");
        expect(collapsed).toContain("• Added fourth.ts (+30)");
        expect(collapsed).toContain("first.ts");
        expect(collapsed).toContain("export const first1 = 1;");
        expect(collapsed).toContain("export const fourth1 = 1;");
        expect(collapsed).toContain("export const fourth30 = 30;");
        expect(collapsed).not.toContain("export const fourth15 = 15;");
        expect(collapsed).toContain("… +24 lines (to expand)");
        expect(expanded).toContain("Added first.ts");
        expect(expanded).toContain("Added fourth.ts");
        expect(expanded).toContain("export const first1 = 1;");
        expect(expanded).toContain("export const first30 = 30;");
    });

    it("keeps every file viewport before expansion", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch\n${Array.from(
            { length: 10 },
            (_value, index) =>
                `*** Add File: file-${index + 1}.ts\n+export const value = ${index + 1};\n`,
        ).join("")}*** End Patch`;
        const lines = renderer.renderCall({ patch }, plainTheme, renderContext).render(120);
        const rendered = lines.join("\n");

        expect(lines).toHaveLength(29);
        expect(rendered).toContain("file-1.ts");
        expect(rendered).toContain("• Added file-10.ts (+1)");
        expect(rendered).not.toMatch(/[├└]/u);
        expectLinesWithinWidth(lines, 120);
    });

    it("renders deleted files as standalone operations without fake statistics", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch
*** Delete File: first.ts
*** Delete File: second.ts
*** End Patch`;
        const collapsed = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(120)
            .join("\n");
        const expanded = renderer
            .renderCall({ patch }, plainTheme, { ...renderContext, expanded: true })
            .render(120)
            .join("\n");

        expect(collapsed).toContain("• Deleted first.ts");
        expect(collapsed).toContain("• Deleted second.ts");
        expect(expanded).toContain("• Deleted first.ts");
        expect(expanded).toContain("• Deleted second.ts");
        expect(collapsed).not.toContain("(+0 -0)");
        expect(collapsed).not.toContain("files");
        expect(collapsed).not.toMatch(/[├└]/u);
    });

    it("keeps content diffs and later delete operations", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch
*** Add File: added.ts
+export const retained = true;
*** Delete File: removed.ts
*** End Patch`;
        const rendered = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(120)
            .join("\n");

        expect(rendered).toContain("• Added added.ts (+1)");
        expect(rendered).toContain("+export const retained = true;");
        expect(rendered).toContain("• Deleted removed.ts");
    });

    it("renders a single deleted file without fake statistics", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = `*** Begin Patch
*** Delete File: first.ts
*** End Patch`;
        const rendered = renderer
            .renderCall({ patch }, plainTheme, renderContext)
            .render(120)
            .join("\n");

        expect(rendered).toContain("• Deleted first.ts");
        expect(rendered).not.toContain("(+0 -0)");
    });

    it("retains readable deleted text with an honest removed-line count", () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-codex-look-delete-"));
        const filePath = path.join(cwd, "removed.ts");
        writeFileSync(filePath, "one\ntwo\nthree\n");
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = "*** Begin Patch\n*** Delete File: removed.ts\n*** End Patch";
        try {
            const streaming = renderer.renderCall({ patch }, plainTheme, {
                ...renderContext,
                cwd,
                argsComplete: false,
                isPartial: true,
            });
            unlinkSync(filePath);
            const rendered = renderer
                .renderCall({ patch }, plainTheme, {
                    ...renderContext,
                    cwd,
                    lastComponent: streaming,
                })
                .render(120)
                .join("\n");

            expect(rendered).toContain("• Deleted removed.ts (-3)");
            expect(rendered).toContain("-one");
            expect(rendered).toContain("-three");
            expect(rendered).not.toContain("+0");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("incrementally updates one component with newly streamed patch lines", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        let patch = "*** Begin Patch\n*** Add File: src/generated.ts\n";
        let lastComponent: Component | undefined;
        let firstComponent: Component | undefined;

        for (let index = 1; index <= 200; index += 1) {
            patch += `+export const value${index} = ${index};\n`;
            lastComponent = renderer.renderCall({ patch }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                lastComponent,
            });
            firstComponent ??= lastComponent;
            lastComponent.render(120);
        }

        const rendered = lastComponent?.render(120).join("\n") ?? "";
        expect(lastComponent).toBe(firstComponent);
        expect(lastComponent?.render(120)).toHaveLength(7);
        expect(rendered).toMatch(/• Editing src\/generated\.ts \(\+200\)/u);
        expect(rendered).toContain("export const value195 = 195;");
        expect(rendered).toContain("export const value200 = 200;");
        expect(rendered).not.toContain("export const value1 = 1;");
        expectLinesWithinWidth(lastComponent?.render(120) ?? [], 120);
    });

    it("never reuses a streaming component across tool calls", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = "*** Begin Patch\n*** Add File: first.ts\n+export const first = true;\n";
        const first = renderer.renderCall({ patch }, plainTheme, {
            ...renderContext,
            toolCallId: "call-first",
            argsComplete: false,
            isPartial: true,
        });
        const second = renderer.renderCall({ patch }, plainTheme, {
            ...renderContext,
            toolCallId: "call-second",
            argsComplete: false,
            isPartial: true,
            lastComponent: first,
        });

        expect(second).not.toBe(first);
    });

    it("keeps a constant seven-row stream across file boundaries", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const firstPatch = `*** Begin Patch
*** Add File: first.ts
+export const first1 = 1;
+export const first2 = 2;
+export const first3 = 3;
`;
        const firstComponent = renderer.renderCall({ patch: firstPatch }, plainTheme, {
            ...renderContext,
            argsComplete: false,
            isPartial: true,
        });
        const secondHeaderPatch = `${firstPatch}*** Add File: second.ts
`;
        const secondHeaderComponent = renderer.renderCall(
            { patch: secondHeaderPatch },
            plainTheme,
            {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                lastComponent: firstComponent,
            },
        );
        const secondLineComponent = renderer.renderCall(
            { patch: `${secondHeaderPatch}+export const second = 2;` },
            plainTheme,
            {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                lastComponent: secondHeaderComponent,
            },
        );

        expect(secondHeaderComponent).toBe(firstComponent);
        expect(secondLineComponent).toBe(firstComponent);
        expect(firstComponent.render(120)).toHaveLength(7);
        expect(secondHeaderComponent.render(120)).toHaveLength(7);
        expect(secondLineComponent.render(120)).toHaveLength(7);
        expect(secondLineComponent.render(120).join("\n")).toContain("second.ts (+1)");
        expect(secondLineComponent.render(120).join("\n")).not.toContain("first.ts");
    });

    it("resets the live patch preview when partial arguments are rewritten", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const firstPatch =
            "*** Begin Patch\n*** Add File: src/first.ts\n+export const first = true;\n";
        const firstComponent = renderer.renderCall({ patch: firstPatch }, plainTheme, {
            ...renderContext,
            argsComplete: false,
            isPartial: true,
        });
        const secondPatch =
            "*** Begin Patch\n*** Add File: src/second.ts\n+export const second = true;\n";
        const secondComponent = renderer.renderCall({ patch: secondPatch }, plainTheme, {
            ...renderContext,
            argsComplete: false,
            isPartial: true,
            lastComponent: firstComponent,
        });
        const rendered = secondComponent.render(100).join("\n");

        expect(secondComponent).toBe(firstComponent);
        expect(rendered).toContain("src/second.ts (+1)");
        expect(rendered).toContain("export const second = true;");
        expect(rendered).not.toContain("src/first.ts");
        expect(rendered).not.toContain("export const first = true;");
    });

    it("does not double-count a CRLF split across patch updates", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const firstPatch =
            "*** Begin Patch\r\n*** Add File: src/generated.ts\r\n+export const value = 1;\r";
        const firstComponent = renderer.renderCall({ patch: firstPatch }, plainTheme, {
            ...renderContext,
            argsComplete: false,
            isPartial: true,
        });
        const secondComponent = renderer.renderCall({ patch: `${firstPatch}\n` }, plainTheme, {
            ...renderContext,
            argsComplete: false,
            isPartial: true,
            lastComponent: firstComponent,
        });

        expect(secondComponent.render(100).join("\n")).toContain("src/generated.ts (+1)");
    });

    it("updates the visible patch line before its newline arrives", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const prefix = "*** Begin Patch\n*** Add File: src/generated.ts\n";
        const firstComponent = renderer.renderCall(
            { patch: `${prefix}+export const generated` },
            plainTheme,
            {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            },
        );
        const secondComponent = renderer.renderCall(
            { patch: `${prefix}+export const generated = true;` },
            plainTheme,
            {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                lastComponent: firstComponent,
            },
        );

        expect(secondComponent.render(100).join("\n")).toContain("export const generated = true;");
    });

    it("keeps oversized completed patch calls on the cheap fallback path", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const largePatch = `*** Begin Patch\n*** Add File: huge.txt\n${"+line\n".repeat(20_000)}*** End Patch`;
        const lines = renderer
            .renderCall({ patch: largePatch }, plainTheme, renderContext)
            .render(100);
        const rendered = lines.join("\n");

        expect(rendered).toContain("• Applied Patch 20003 patch lines");
        expect(rendered).not.toContain("(+0 -0)");
        expect(rendered).not.toContain("huge.txt");
        expect(rendered).not.toContain("+line");
        expectLinesWithinWidth(lines, 100);
    });

    it("keeps the apply-patch label stable in static mode", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", { labelMode: "static" });
        const active = renderer
            .renderCall({ patch: samplePatch }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100)
            .join("\n");
        const completed = renderer
            .renderCall({ patch: samplePatch }, plainTheme, renderContext)
            .render(100)
            .join("\n");

        expect(active).toContain("• Apply Patch");
        expect(completed).toContain("• Apply Patch");
        expect(completed).not.toContain("• Edited");
    });
});
