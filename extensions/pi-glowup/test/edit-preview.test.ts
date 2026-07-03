import { describe, expect, it } from "vitest";
import { buildEditPreview, EditPreviewStore } from "../src/edit-preview.ts";

describe("edit previews", () => {
    it("builds display-only diff metadata", () => {
        const preview = buildEditPreview({
            path: "file.txt",
            diff: "-1 old\n+1 new\n 2 same",
        });

        expect(preview).toEqual({
            path: "file.txt",
            added: 1,
            removed: 1,
        });
        expect("diff" in preview).toBe(false);
    });

    it("does not retain large raw diff text in preview state", () => {
        const diff = `${" 1 context\n".repeat(1_000)}+1001 new\n-1002 old\n`;
        const preview = buildEditPreview({ path: "large.patch", diff });

        expect(preview).toEqual({
            path: "large.patch",
            added: 1,
            removed: 1,
        });
        expect(JSON.stringify(preview)).not.toContain("context");
    });

    it("bounds previews by insertion recency", () => {
        const store = new EditPreviewStore(2);
        const first = buildEditPreview({ path: "a", diff: "+1 a" });
        const second = buildEditPreview({ path: "b", diff: "+1 b" });
        const third = buildEditPreview({ path: "c", diff: "+1 c" });

        store.set("first", first);
        store.set("second", second);
        store.set("third", third);

        expect(store.get("first")).toBeUndefined();
        expect(store.get("second")).toBe(second);
        expect(store.get("third")).toBe(third);
    });
});
