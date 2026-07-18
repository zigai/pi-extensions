import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";
import {
    renderStreamingEditCallPreview,
    resolveStreamingEditLineNumber,
    summarizeEditCall,
} from "../src/rendering/edit-call-rendering.ts";

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

describe("edit call rendering", () => {
    it("counts only structurally valid edit entries", () => {
        const summary = summarizeEditCall(
            {
                path: "src/rendering.ts",
                edits: [
                    { oldText: "old", newText: "new" },
                    { old_string: "before", new_string: "after" },
                    "stray generated text",
                    { oldText: "missing new text" },
                ],
            },
            { isError: false, isPartial: false, argsComplete: true },
        );

        expect(summary).toEqual({
            statusText: "Edit",
            path: "src/rendering.ts",
            suffix: " (2 valid, 2 invalid)",
            hasInvalidEdits: true,
        });
    });

    it("marks incomplete edit arguments with the stable edit label", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            { isError: false, isPartial: true, argsComplete: false },
        );

        expect(summary).toEqual({
            statusText: "Edit",
            path: "src/rendering.ts",
            suffix: "",
            hasInvalidEdits: false,
        });
    });

    it("uses the active edit label in lifecycle mode", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            {
                isError: false,
                isPartial: true,
                argsComplete: false,
                labelMode: "lifecycle",
            },
        );

        expect(summary).toEqual({
            statusText: "Editing",
            path: "src/rendering.ts",
            suffix: "",
            hasInvalidEdits: false,
        });
    });

    it("treats an unfinished edit entry as pending while arguments stream", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old" }] },
            {
                isError: false,
                isPartial: true,
                argsComplete: false,
                labelMode: "lifecycle",
            },
        );

        expect(summary).toEqual({
            statusText: "Editing",
            path: "src/rendering.ts",
            suffix: "",
            hasInvalidEdits: false,
        });
    });

    it("uses the completed edit label in lifecycle mode", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            {
                isError: false,
                isPartial: false,
                argsComplete: true,
                labelMode: "lifecycle",
            },
        );

        expect(summary.statusText).toBe("Edited");
    });

    it("marks restored completed edit calls as no longer pending", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            { isError: false, isPartial: false, argsComplete: false },
        );

        expect(summary).toEqual({
            statusText: "Edit",
            path: "src/rendering.ts",
            suffix: "",
            hasInvalidEdits: false,
        });
    });

    it("marks completed errored edit calls with the stable edit label", () => {
        const summary = summarizeEditCall(
            {
                path: "src/rendering.ts",
                edits: [
                    { oldText: "old", newText: "new" },
                    { oldText: "older", newText: "newer" },
                ],
            },
            { isError: true, isPartial: false, argsComplete: true },
        );

        expect(summary).toEqual({
            statusText: "Edit",
            path: "src/rendering.ts",
            suffix: " (2 edits)",
            hasInvalidEdits: false,
        });
    });

    it("shows the latest replacement lines while edit arguments stream", () => {
        const oldText = Array.from({ length: 10 }, (_value, index) => `old line ${index + 1}`).join(
            "\n",
        );
        const newText = Array.from({ length: 30 }, (_value, index) => `new line ${index + 1}`).join(
            "\n",
        );
        const component = renderStreamingEditCallPreview(
            { path: "src/rendering.ts", edits: [{ oldText, newText }] },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                argsComplete: false,
                expanded: false,
                labelMode: "lifecycle",
                lineNumberStart: 20,
            },
        );
        const lines = component?.render(100) ?? [];
        const rendered = lines.join("\n");

        expect(rendered).toContain("• Editing src/rendering.ts");
        expect(rendered).toContain("… earlier replacement lines omitted");
        expect(rendered).toContain("new line 30");
        expect(rendered).not.toContain("old line 1");
        expect(rendered).not.toMatch(/\d+ [+-]/u);
        expect(rendered).not.toContain("(+");
        expect(rendered).not.toContain("(-");
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(100);
        }
    });

    it("does not split emoji graphemes when bounding a streaming replacement", () => {
        const newText = `a🧪${"b".repeat(1_998)}`;
        const component = renderStreamingEditCallPreview(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText }] },
            plainTheme,
            {
                isError: false,
                isPartial: true,
                argsComplete: false,
                expanded: false,
                labelMode: "lifecycle",
                lineNumberStart: 1,
            },
        );
        const rendered = component?.render(2_200).join("\n") ?? "";

        expect(Buffer.from(rendered, "utf8").toString("utf8")).toBe(rendered);
        expect(rendered).not.toContain("�");
    });

    it("resolves streaming edit line numbers asynchronously from the real file", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-glowup-edit-lines-"));
        try {
            writeFileSync(path.join(cwd, "example.ts"), "one\ntwo\nthree\nfour\nfive\n");
            const args = {
                path: "example.ts",
                edits: [{ oldText: "three\nfour", newText: "changed" }],
            };
            let notify: (() => void) | undefined;
            const invalidated = new Promise<void>((resolve) => {
                notify = resolve;
            });

            expect(
                resolveStreamingEditLineNumber("edit-line-test", cwd, args, () => notify?.()),
            ).toBeUndefined();
            await invalidated;
            expect(resolveStreamingEditLineNumber("edit-line-test", cwd, args, () => {})).toBe(3);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("caches ambiguous streaming edit lookups as unresolved", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-glowup-edit-lines-"));
        try {
            writeFileSync(path.join(cwd, "example.ts"), "same\nmiddle\nsame\n");
            const args = {
                path: "example.ts",
                edits: [{ oldText: "same", newText: "changed" }],
            };
            let invalidations = 0;
            let notify: (() => void) | undefined;
            const invalidated = new Promise<void>((resolve) => {
                notify = resolve;
            });
            const invalidate = (): void => {
                invalidations += 1;
                notify?.();
            };

            expect(
                resolveStreamingEditLineNumber("ambiguous-edit-test", cwd, args, invalidate),
            ).toBeUndefined();
            await invalidated;
            expect(
                resolveStreamingEditLineNumber("ambiguous-edit-test", cwd, args, invalidate),
            ).toBeUndefined();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(invalidations).toBe(1);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
