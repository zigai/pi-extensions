import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { DEFAULT_MUTATION_SETTINGS } from "../../src/rendering/preview-settings.ts";
import { createNativeEditFeature } from "../../src/tools/built-in/edit.ts";

async function fixture(): Promise<{
    readonly cwd: string;
    readonly feature: ReturnType<typeof createNativeEditFeature>;
}> {
    const cwd = await mkdtemp(join(tmpdir(), "pi-glowup-session-preimage-"));
    const feature = createNativeEditFeature();
    onTestFinished(async () => {
        feature.clear();
        await rm(cwd, { recursive: true, force: true });
    });

    await writeFile(join(cwd, "file.txt"), "BEFORE\n");
    return { cwd, feature };
}

it("does not repopulate session snapshots when a pending capture settles after clear", async () => {
    const { cwd, feature } = await fixture();
    // Positive control: the real file is readable and the feature admits its snapshot.
    await feature.captureNativeEditSnapshot("control", cwd, "file.txt", DEFAULT_MUTATION_SETTINGS);
    expect(feature.stats().nativeEditSnapshots).toBe(1);
    feature.clear();

    const capturing = feature.captureNativeEditSnapshot(
        "old-session",
        cwd,
        "file.txt",
        DEFAULT_MUTATION_SETTINGS,
    );
    // capture suspends at its first filesystem await; no sleeps or mocked module are needed.
    feature.clear();
    await capturing;

    expect(feature.stats().nativeEditSnapshots).toBe(0);
});

it("does not repopulate session payloads when a pending finish settles after clear", async () => {
    const { cwd, feature } = await fixture();
    await feature.captureNativeEditSnapshot(
        "old-session",
        cwd,
        "file.txt",
        DEFAULT_MUTATION_SETTINGS,
    );
    await writeFile(join(cwd, "file.txt"), "AFTER\n");

    const finishing = feature.finishNativeEditSnapshot(
        "old-session",
        false,
        DEFAULT_MUTATION_SETTINGS,
    );
    feature.clear();
    await finishing;

    expect(feature.stats()).toMatchObject({
        nativeEditSnapshots: 0,
        nativeEditPierrePayloads: 0,
    });
});
