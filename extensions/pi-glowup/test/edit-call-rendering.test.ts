import { describe, expect, it } from "vitest";
import { summarizeEditCall } from "../src/rendering/edit-call-rendering.ts";

describe("edit call rendering", () => {
    it("counts only structurally valid edit entries", () => {
        const summary = summarizeEditCall(
            {
                path: "src/rendering.ts",
                edits: [
                    { oldText: "old", newText: "new" },
                    { oldText: "before", newText: "after" },
                    null,
                    null,
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
            { path: "src/rendering.ts", edits: [null] },
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
        const activeSummary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            { isError: false, isPartial: true, argsComplete: false, labelMode: "lifecycle" },
        );
        expect(activeSummary.statusText).toBe("Editing");

        const restoredSummary = summarizeEditCall(
            { path: "src/rendering.ts", edits: [{ oldText: "old", newText: "new" }] },
            {
                isError: false,
                isPartial: true,
                argsComplete: false,
                labelMode: "lifecycle",
                result: { content: [{ type: "text", text: "done" }], details: {} },
            },
        );

        expect(restoredSummary).toEqual({
            statusText: "Edited",
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
