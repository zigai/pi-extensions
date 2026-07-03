import { describe, expect, it } from "vitest";
import { summarizeEditCall } from "../src/edit-call-rendering.ts";

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

    it("marks incomplete edit arguments as pending", () => {
        const summary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            { isError: false, isPartial: true, argsComplete: false },
        );

        expect(summary).toEqual({
            statusText: "Edit Pending",
            path: "src/rendering.ts",
            suffix: "",
            hasInvalidEdits: false,
        });
    });

    it("marks completed errored edit calls as failed", () => {
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
            statusText: "Edit Failed",
            path: "src/rendering.ts",
            suffix: " (2 edits)",
            hasInvalidEdits: false,
        });
    });
});
