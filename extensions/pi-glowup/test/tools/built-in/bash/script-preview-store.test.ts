import { describe, expect, it } from "vitest";
import {
    boundedScriptPreview,
    createScriptPreviewStore,
} from "../../../../src/tools/built-in/bash/preview-store.ts";

describe("script preview store", () => {
    it("truncates oversized formatted script previews", () => {
        const preview = boundedScriptPreview({
            label: "Python",
            language: "python",
            code: "é".repeat(40_000),
        });

        expect(Buffer.byteLength(preview.code, "utf8")).toBeLessThanOrEqual(64 * 1024);
        expect(preview.code).toContain("preview truncated");
        expect(preview.code).not.toContain("�");
    });

    it("bounds retained script previews by total bytes", () => {
        const store = createScriptPreviewStore();
        const preview = boundedScriptPreview({
            label: "Python",
            language: "python",
            code: "x".repeat(70_000),
        });

        for (let index = 0; index < 70; index += 1) {
            store.set(`call-${index}`, preview);
        }

        expect(store.get("call-0")).toBeUndefined();
        expect(store.get("call-69")).toBe(preview);
    });
});
