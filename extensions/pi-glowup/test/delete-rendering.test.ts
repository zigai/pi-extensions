import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureDeletedTextPreview } from "../src/rendering/delete-preview.ts";

describe("delete rendering", () => {
    it("captures readable text before deletion with line counts", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-glowup-native-delete-"));
        try {
            writeFileSync(path.join(cwd, "removed.ts"), "one\ntwo\nthree\n");
            const preview = await captureDeletedTextPreview(cwd, "removed.ts");

            expect(preview?.removed).toBe(3);
            expect(preview?.section.lines).toEqual(["-1 one", "-2 two", "-3 three"]);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("does not capture binary or out-of-project paths", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-glowup-native-delete-"));
        try {
            writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([1, 0, 2]));
            expect(await captureDeletedTextPreview(cwd, "binary.bin")).toBeUndefined();
            expect(await captureDeletedTextPreview(cwd, "../outside.ts")).toBeUndefined();
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("honors configurable delete preimage limits", async () => {
        const cwd = mkdtempSync(path.join(tmpdir(), "pi-glowup-native-delete-"));
        try {
            writeFileSync(path.join(cwd, "removed.txt"), "one\ntwo\nthree\n");

            expect(await captureDeletedTextPreview(cwd, "removed.txt", 4)).toBeUndefined();
            expect(await captureDeletedTextPreview(cwd, "removed.txt", null)).toMatchObject({
                removed: 3,
            });
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
