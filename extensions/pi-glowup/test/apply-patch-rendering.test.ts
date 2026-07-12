import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import { captureApplyPatchPreimages } from "../src/rendering/apply-patch-rendering.ts";
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
        expect(collapsed).toContain("• Patched README.md (+1 -1)");
        expect(collapsed).toContain("• Patched src/new.ts (+2)");
        expect(collapsed).not.toContain("files");
        expect(collapsed).not.toMatch(/[├└]/u);
        expect(collapsed).toContain("README.md");
        expect(collapsed).toContain("old heading");
        expect(collapsed).toContain("+export const answer = 42;");
        expect(expanded).toContain("• Patched README.md (+1 -1)");
        expect(expanded).toContain("• Patched src/new.ts (+2)");
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

    it("uses line numbers supplied by hunk coordinates", () => {
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

    it("derives real line numbers for coordinate-less edit hunks from the preimage", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-codex-look-update-"));
        try {
            writeFileSync(
                path.join(cwd, "example.ts"),
                "line one\nline two\nline three\nline four\nline five\nline six\n",
            );
            const renderer = createThirdPartyToolRenderer("apply_patch", {
                labelMode: "lifecycle",
            });
            const patch = `*** Begin Patch
*** Update File: example.ts
@@
 line three
-line four
+changed four
 line five
*** End Patch`;
            const context = { ...renderContext, cwd, toolCallId: "coordinate-less-update" };

            await captureApplyPatchPreimages(context.toolCallId, cwd, { patch });
            const rendered = renderer
                .renderCall({ patch }, plainTheme, context)
                .render(100)
                .join("\n");

            expect(rendered).toContain("3  line three");
            expect(rendered).toContain("4 -line four");
            expect(rendered).toContain("4 +changed four");
            expect(rendered).toContain("5  line five");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("accounts for earlier hunk line shifts when deriving later line numbers", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-codex-look-update-"));
        try {
            writeFileSync(
                path.join(cwd, "example.ts"),
                Array.from({ length: 8 }, (_value, index) => `line ${index + 1}`).join("\n") + "\n",
            );
            const renderer = createThirdPartyToolRenderer("apply_patch", {
                labelMode: "lifecycle",
            });
            const patch = `*** Begin Patch
*** Update File: example.ts
@@
 line 2
-line 3
+line 3a
+line 3b
 line 4
@@
 line 7
-line 8
+changed 8
*** End Patch`;
            const context = { ...renderContext, cwd, toolCallId: "shifted-coordinate-less-update" };

            await captureApplyPatchPreimages(context.toolCallId, cwd, { patch });
            const rendered = renderer
                .renderCall({ patch }, plainTheme, { ...context, expanded: true })
                .render(100)
                .join("\n");

            expect(rendered).toContain("3 -line 3");
            expect(rendered).toContain("3 +line 3a");
            expect(rendered).toContain("4 +line 3b");
            expect(rendered).toContain("8  line 7");
            expect(rendered).toContain("8 -line 8");
            expect(rendered).toContain("9 +changed 8");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
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

    it("renders failed applications without claiming the attempted patch succeeded", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const context = {
            ...renderContext,
            args: { patch: samplePatch },
            isError: true,
        };
        const callLines = renderer
            .renderCall({ patch: samplePatch }, plainTheme, context)
            .render(80);
        const resultLines = renderer
            .renderResult(
                { content: [{ type: "text", text: "Invalid patch: missing header" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                context,
            )
            .render(80);
        const rendered = [...callLines, ...resultLines].join("\n");

        expect(callLines[0]?.trimEnd()).toBe("• Patch README.md (+1 -1)");
        expect(resultLines[0]?.trimEnd()).toBe("• Failed to patch");
        expect(rendered).not.toContain("Patched");
        expect(rendered).toContain("Invalid patch: missing header");
        expectLinesWithinWidth([...callLines, ...resultLines], 80);
    });

    it("shows the current file diff tail while patch arguments stream", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const partialPatch = `*** Begin Patch\n*** Add File: src/new.ts\n${"+extra\n".repeat(1_000)}`;
        const lines = renderer
            .renderCall({ patch: partialPatch }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100);
        const rendered = lines.join("\n");

        expect(rendered).toContain("• Patching src/new.ts");
        expect(rendered).not.toContain("(+1000)");
        expect(lines).toHaveLength(7);
        expect(rendered).toContain("995 +extra");
        expect(rendered).toContain("1000 +extra");
        expect(rendered).not.toContain("earlier patch lines");
        expectLinesWithinWidth(lines, 100);
    });

    it("resolves real line numbers for coordinate-less streaming updates", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-codex-look-streaming-patch-"));
        try {
            writeFileSync(
                path.join(cwd, "example.ts"),
                Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`).join("\n"),
            );
            const patch = `*** Begin Patch
*** Update File: example.ts
@@
 line 9
-line 10
+line ten
 line 11`;
            const renderer = createThirdPartyToolRenderer("apply_patch", {
                labelMode: "lifecycle",
            });
            let notify: (() => void) | undefined;
            const invalidated = new Promise<void>((resolve) => {
                notify = resolve;
            });
            const context = {
                ...renderContext,
                toolCallId: "streaming-numbered-patch",
                argsComplete: false,
                isPartial: true,
                cwd,
                invalidate: () => notify?.(),
            };
            const component = renderer.renderCall({ patch }, plainTheme, context);
            const initial = component.render(100).join("\n");

            expect(initial).not.toContain("-line 10");
            expect(initial).not.toContain("+line ten");

            await invalidated;
            const rendered = renderer
                .renderCall({ patch }, plainTheme, {
                    ...context,
                    lastComponent: component,
                    invalidate: () => {},
                })
                .render(100)
                .join("\n");

            expect(rendered).toContain("9  line 9");
            expect(rendered).toContain("10 -line 10");
            expect(rendered).toContain("10 +line ten");
            expect(rendered).toContain("11  line 11");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("does not retry unavailable streaming update preimages", async () => {
        const renderer = createThirdPartyToolRenderer("apply_patch");
        const patch = "*** Begin Patch\n*** Update File: missing.ts\n@@\n-old\n+new";
        let invalidations = 0;
        let notify: (() => void) | undefined;
        const invalidated = new Promise<void>((resolve) => {
            notify = resolve;
        });
        const context = {
            ...renderContext,
            toolCallId: "missing-streaming-preimage",
            argsComplete: false,
            isPartial: true,
            cwd: process.cwd(),
            invalidate: (): void => {
                invalidations += 1;
                notify?.();
            },
        };
        const component = renderer.renderCall({ patch }, plainTheme, context);

        await invalidated;
        renderer.renderCall({ patch }, plainTheme, { ...context, lastComponent: component });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(invalidations).toBe(1);
    });

    it("does not read partially streamed update paths", async () => {
        const renderer = createThirdPartyToolRenderer("apply_patch");
        let invalidations = 0;
        renderer.renderCall({ patch: "*** Begin Patch\n*** Update File: incomplete" }, plainTheme, {
            ...renderContext,
            toolCallId: "incomplete-streaming-path",
            argsComplete: false,
            isPartial: true,
            cwd: process.cwd(),
            invalidate: () => {
                invalidations += 1;
            },
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(invalidations).toBe(0);
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
        expect(rendered.trimEnd().endsWith("… +34 lines (to expand)")).toBe(true);
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
        expect(collapsed).toContain("• Patched first.ts (+30)");
        expect(collapsed).toContain("• Patched fourth.ts (+30)");
        expect(collapsed).toContain("first.ts");
        expect(collapsed).toContain("export const first1 = 1;");
        expect(collapsed).toContain("export const fourth1 = 1;");
        expect(collapsed).toContain("export const fourth30 = 30;");
        expect(collapsed).not.toContain("export const fourth15 = 15;");
        expect(collapsed).toContain("… +24 lines (to expand)");
        expect(expanded).toContain("Patched first.ts");
        expect(expanded).toContain("Patched fourth.ts");
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
        expect(rendered).toContain("• Patched file-10.ts (+1)");
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

        expect(collapsed).toContain("• Patched first.ts");
        expect(collapsed).toContain("• Patched second.ts");
        expect(expanded).toContain("• Patched first.ts");
        expect(expanded).toContain("• Patched second.ts");
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

        expect(rendered).toContain("• Patched added.ts (+1)");
        expect(rendered).toContain("+export const retained = true;");
        expect(rendered).toContain("• Patched removed.ts");
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

        expect(rendered).toContain("• Patched first.ts");
        expect(rendered).not.toContain("(+0 -0)");
    });

    it("retains readable deleted text with an honest removed-line count", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-codex-look-delete-"));
        const filePath = path.join(cwd, "removed.ts");
        writeFileSync(filePath, "one\ntwo\nthree\n");
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const patch = "*** Begin Patch\n*** Delete File: removed.ts\n*** End Patch";
        try {
            await captureApplyPatchPreimages(renderContext.toolCallId, cwd, { patch });
            unlinkSync(filePath);
            const rendered = renderer
                .renderCall({ patch }, plainTheme, {
                    ...renderContext,
                    cwd,
                })
                .render(120)
                .join("\n");

            expect(rendered).toContain("• Patched removed.ts (-3)");
            expect(rendered).toContain("-one");
            expect(rendered).toContain("-three");
            expect(rendered).not.toContain("+0");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("replays bounded newly streamed patch lines without reusing components", () => {
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
        expect(lastComponent).not.toBe(firstComponent);
        expect(lastComponent?.render(120)).toHaveLength(7);
        expect(rendered).toContain("• Patching src/generated.ts");
        expect(rendered).not.toContain("(+200)");
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

    it("keeps coherent bounded frames across partial file boundaries", () => {
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
        const firstFrame = firstComponent.render(120);
        const partialHeaderComponent = renderer.renderCall(
            { patch: `${firstPatch}*** Add File: sec` },
            plainTheme,
            {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                lastComponent: firstComponent,
            },
        );
        const partialHeaderFrame = partialHeaderComponent.render(120);
        const secondHeaderPatch = `${firstPatch}*** Add File: second.ts
`;
        const secondHeaderComponent = renderer.renderCall(
            { patch: secondHeaderPatch },
            plainTheme,
            {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                lastComponent: partialHeaderComponent,
            },
        );
        const secondHeaderFrame = secondHeaderComponent.render(120);
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
        const secondLineFrame = secondLineComponent.render(120);

        expect(partialHeaderComponent).not.toBe(firstComponent);
        expect(secondHeaderComponent).not.toBe(firstComponent);
        expect(secondLineComponent).not.toBe(firstComponent);
        expect(firstFrame.length).toBeLessThanOrEqual(7);
        expect(partialHeaderFrame.length).toBeLessThanOrEqual(7);
        expect(secondHeaderFrame.length).toBeLessThanOrEqual(7);
        expect(secondLineFrame.length).toBeLessThanOrEqual(7);
        expect(partialHeaderFrame.join("\n")).toContain("Patching first.ts");
        expect(partialHeaderFrame.join("\n")).not.toContain("Patch sec");
        expect(secondHeaderFrame.join("\n")).toContain("Patching first.ts");
        expect(secondLineFrame.join("\n")).toContain("Patching first.ts");
        expect(secondLineFrame.join("\n")).toContain("export const first1 = 1;");
        expect(secondLineFrame.join("\n")).not.toContain("second.ts");
        expect(secondLineFrame.join("\n")).not.toContain("(+1)");
        expect(secondLineFrame.at(-1)?.trim().length).toBeGreaterThan(0);
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

        expect(secondComponent).not.toBe(firstComponent);
        expect(rendered).toContain("Patching src/second.ts");
        expect(rendered).not.toContain("(+1)");
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

        expect(secondComponent.render(100).join("\n")).toContain("Patching src/generated.ts");
        expect(secondComponent.render(100).join("\n")).not.toContain("(+1)");
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

    it("keeps pre-section partial patch rendering header-only", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "lifecycle",
        });
        const lines = renderer
            .renderCall({ patch: "*** Begin Patch\n*** Add File: src/gen" }, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100);
        const rendered = lines.join("\n");

        expect(lines).toHaveLength(1);
        expect(rendered).toContain("• Patching");
        expect(rendered).not.toContain("Patch patch");
        expect(rendered).not.toContain("…");
    });

    it("keeps undecodable partial patch calls header-only", () => {
        const renderer = createThirdPartyToolRenderer("apply_patch", {
            labelMode: "static",
        });
        const lines = renderer
            .renderCall({}, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
            })
            .render(100);
        const rendered = lines.join("\n");

        expect(lines).toHaveLength(1);
        expect(rendered).toContain("• Patch");
        expect(rendered).not.toContain("Patch patch");
        expect(rendered).not.toContain("…");
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

        expect(rendered).toContain("• Patched 20003 patch lines");
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

        expect(active).toContain("• Patch");
        expect(completed).toContain("• Patch");
        expect(completed).not.toContain("• Patched");
    });
});
