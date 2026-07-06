import { describe, expect, it } from "vitest";
import { summarizeEditCall } from "../src/rendering/edit-call-rendering.ts";

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

    it("uses dynamic status labels when enabled", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            {
                isError: false,
                isPartial: true,
                argsComplete: false,
                dynamicStatusLabels: true,
            },
        );

        expect(summary).toEqual({
            statusText: "Editing",
            path: "src/rendering.ts",
            suffix: "",
            hasInvalidEdits: false,
        });
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
});
