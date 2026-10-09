import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_MUTATION_SETTINGS } from "../../../src/rendering/preview-settings.ts";
import { createNativeEditFeature } from "../../../src/tools/built-in/edit.ts";
import {
    captureDeletedTextPreview,
    captureTextFilePreimage,
} from "../../../src/tools/built-in/delete-preview.ts";

async function createSandbox(): Promise<{ readonly project: string; readonly outside: string }> {
    const root = await mkdtemp(join(tmpdir(), "pi-glowup-preimage-boundary-"));
    onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    await writeFile(join(project, "inside.txt"), "inside\n");
    await writeFile(join(outside, "marker.txt"), "SYNTHETIC_OUTSIDE_MARKER\n");

    return { project, outside };
}

describe("preimage filesystem boundary", () => {
    it("rejects both file and ancestor symlinks that resolve outside cwd", async () => {
        const { project, outside } = await createSandbox();
        await symlink(join(outside, "marker.txt"), join(project, "file-link"));
        await symlink(outside, join(project, "directory-link"), "dir");

        expect(await captureTextFilePreimage(project, "file-link")).toBeUndefined();
        expect(await captureTextFilePreimage(project, "directory-link/marker.txt")).toBeUndefined();
        expect(await captureDeletedTextPreview(project, "file-link")).toBeUndefined();
        expect(await readFile(join(outside, "marker.txt"), "utf8")).toBe(
            "SYNTHETIC_OUTSIDE_MARKER\n",
        );
    });

    it("retains in-project symlinks, including a symlinked cwd", async () => {
        const { project, outside } = await createSandbox();
        await symlink(join(project, "inside.txt"), join(project, "inside-link"));
        await symlink(project, join(outside, "project-alias"), "dir");

        const expected = { lines: ["inside"], endsWithNewline: true };
        expect(await captureTextFilePreimage(project, "inside-link")).toEqual(expected);
        expect(
            await captureTextFilePreimage(join(outside, "project-alias"), "inside-link"),
        ).toEqual(expected);
    });

    it("rejects lexical escapes even when an outside sibling shares the cwd prefix", async () => {
        const { project, outside } = await createSandbox();
        await mkdir(`${project}-sibling`);
        await writeFile(join(`${project}-sibling`, "marker.txt"), "SIBLING\n");

        for (const filePath of [
            "../outside/marker.txt",
            join(outside, "marker.txt"),
            "../project-sibling/marker.txt",
            ".",
        ]) {
            expect(await captureTextFilePreimage(project, filePath)).toBeUndefined();
        }
    });

    it("preserves explicit outside-cwd metadata capture rather than silently changing policy", async () => {
        const { project, outside } = await createSandbox();
        await symlink(join(outside, "marker.txt"), join(project, "outside-link"));

        for (const filePath of ["../outside/marker.txt", "outside-link"]) {
            expect(
                await captureTextFilePreimage(project, filePath, null, { allowOutsideCwd: true }),
            ).toEqual({ lines: ["SYNTHETIC_OUTSIDE_MARKER"], endsWithNewline: true });
        }
    });

    it.each([
        { maxBytes: 2, accepted: false },
        { maxBytes: 3, accepted: true },
        { maxBytes: 4, accepted: true },
        { maxBytes: null, accepted: true },
    ])("uses bytes at the UTF-8 file-size boundary: $maxBytes", async ({ maxBytes, accepted }) => {
        const { project } = await createSandbox();
        await writeFile(join(project, "utf8.txt"), "é\n");

        const result = await captureTextFilePreimage(project, "utf8.txt", maxBytes);
        expect(result).toEqual(accepted ? { lines: ["é"], endsWithNewline: true } : undefined);
    });

    it("normalizes newline forms without changing preimage bytes on disk", async () => {
        const { project } = await createSandbox();
        const original = "one\r\ntwo\rthree";
        await writeFile(join(project, "mixed.txt"), original);

        expect(await captureDeletedTextPreview(project, "mixed.txt")).toEqual({
            section: {
                path: "mixed.txt",
                lines: ["-1 one", "-2 two", "-3 three"],
                added: 0,
                removed: 3,
            },
            removed: 3,
            preimage: { lines: ["one", "two", "three"], endsWithNewline: false },
        });

        expect(await readFile(join(project, "mixed.txt"), "utf8")).toBe(original);
    });

    it("rejects absent, directory, dangling-symlink and NUL-bearing inputs", async () => {
        const { project } = await createSandbox();
        await mkdir(join(project, "directory"));
        await symlink(join(project, "missing"), join(project, "dangling"));
        await writeFile(join(project, "binary"), Buffer.from([65, 0, 66]));

        for (const filePath of ["missing", "directory", "dangling", "binary"]) {
            expect(await captureTextFilePreimage(project, filePath)).toBeUndefined();
        }
    });
});

describe("native edit session preimages", () => {
    it("does not repopulate session snapshots when a pending capture settles after clear", async () => {
        const { project } = await createSandbox();
        const feature = createNativeEditFeature();
        onTestFinished(() => feature.clear());
        await feature.captureNativeEditSnapshot(
            "control",
            project,
            "inside.txt",
            DEFAULT_MUTATION_SETTINGS,
        );
        expect(feature.stats().nativeEditSnapshots).toBe(1);
        feature.clear();

        const capturing = feature.captureNativeEditSnapshot(
            "old-session",
            project,
            "inside.txt",
            DEFAULT_MUTATION_SETTINGS,
        );
        feature.clear();
        await capturing;

        expect(feature.stats().nativeEditSnapshots).toBe(0);
        await feature.captureNativeEditSnapshot(
            "old-session",
            project,
            "inside.txt",
            DEFAULT_MUTATION_SETTINGS,
        );
        expect(feature.stats().nativeEditSnapshots).toBe(1);
    });

    it("does not repopulate session payloads when a pending finish settles after clear", async () => {
        const { project } = await createSandbox();
        const feature = createNativeEditFeature();
        onTestFinished(() => feature.clear());
        await feature.captureNativeEditSnapshot(
            "old-session",
            project,
            "inside.txt",
            DEFAULT_MUTATION_SETTINGS,
        );
        await writeFile(join(project, "inside.txt"), "AFTER\n");

        const finishing = feature.finishNativeEditSnapshot(
            "old-session",
            false,
            DEFAULT_MUTATION_SETTINGS,
        );
        feature.clear();
        await expect(finishing).resolves.toBeUndefined();
        expect(feature.stats()).toMatchObject({
            nativeEditSnapshots: 0,
            nativeEditPierrePayloads: 0,
        });

        await feature.captureNativeEditSnapshot(
            "new-session",
            project,
            "inside.txt",
            DEFAULT_MUTATION_SETTINGS,
        );
        await writeFile(join(project, "inside.txt"), "AFTER NEW SESSION\n");
        expect(
            await feature.finishNativeEditSnapshot("new-session", false, DEFAULT_MUTATION_SETTINGS),
        ).toBeDefined();

        expect(feature.stats().nativeEditPierrePayloads).toBe(1);
    });
});
