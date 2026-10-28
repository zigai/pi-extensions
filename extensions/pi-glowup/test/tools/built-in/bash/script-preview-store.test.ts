import { describe, expect, it } from "vitest";
import { createScriptPreviewStore } from "../../../../src/tools/built-in/bash/preview-store.ts";

describe("script preview store", () => {
    it("retains complete oversized formatted script previews", () => {
        const code = "é".repeat(40_000);
        const preview = { label: "Python", language: "python", code };
        const store = createScriptPreviewStore();
        store.set("large", preview);
        expect(store.get("large")?.code).toBe(code);
    });

    it("keeps the latest preview even when it exceeds the total cache budget", () => {
        const store = createScriptPreviewStore();
        const preview = { label: "Python", language: "python", code: "x".repeat(5 * 1024 * 1024) };
        store.set("large", preview);
        expect(store.get("large")).toBe(preview);
    });

    it("bounds retained script previews by total bytes", () => {
        const store = createScriptPreviewStore();
        const preview = { label: "Python", language: "python", code: "x".repeat(70_000) };

        for (let index = 0; index < 70; index += 1) {
            store.set(`call-${index}`, preview);
        }

        expect(store.get("call-0")).toBeUndefined();
        expect(store.get("call-69")).toBe(preview);
    });
});
