import assert from "node:assert/strict";
import { test } from "vitest";

import { ThinkingStatusPatchSession } from "../src/status-patch-session.ts";

test("status patch activation is shared and restored once on reset", async () => {
    let installs = 0;
    let restores = 0;
    const session = new ThinkingStatusPatchSession(async () => {
        installs += 1;

        return () => {
            restores += 1;
        };
    });

    const first = session.activate(() => false);
    const second = session.activate(() => false);
    await Promise.all([first, second]);
    assert.equal(installs, 1);
    assert.equal(restores, 0);
    session.reset();
    session.reset();
    assert.equal(restores, 1);
});

test("status patch reset clears ownership before a restore failure", async () => {
    let restores = 0;
    const session = new ThinkingStatusPatchSession(async () => () => {
        restores += 1;
        throw new Error("restore failed");
    });
    await session.activate(() => false);
    assert.throws(() => session.reset(), /restore failed/);
    assert.doesNotThrow(() => session.reset());
    assert.equal(restores, 1);
});

test("status patch completion after reset restores the stale installation", async () => {
    let resolveInstall: ((restore: () => void) => void) | undefined;
    let restores = 0;

    const session = new ThinkingStatusPatchSession(
        async () =>
            new Promise((resolve) => {
                resolveInstall = resolve;
            }),
    );

    const activation = session.activate(() => false);
    session.reset();
    assert.notEqual(resolveInstall, undefined);
    resolveInstall?.(() => {
        restores += 1;
    });
    await activation;
    assert.equal(restores, 1);
});
