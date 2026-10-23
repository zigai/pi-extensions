import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const extensionUrl = new URL("../src/index.ts", import.meta.url).href;
const modelStatusUrl = new URL("../src/model-status.ts", import.meta.url).href;
const settingsUrl = new URL("../src/settings.ts", import.meta.url).href;
const warning =
    "[pi-ui-tweaks] model status patch unavailable; Pi internals may have changed: missing showStatus";

// A fresh process records the actual terminal streams, without replacing console or stream methods.
async function runDiagnosticSession(hasUI: boolean) {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-ui-diagnostics-"));
    const agentDir = path.join(directory, "agent");
    const settingsDir = path.join(agentDir, "extension-settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
        path.join(settingsDir, "pi-ui-tweaks.json"),
        JSON.stringify({ dimInputBorder: "invalid" }),
    );
    try {
        return spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                `
                import assert from "node:assert/strict";
                import extension from ${JSON.stringify(extensionUrl)};
                import { installModelStatusPatch } from ${JSON.stringify(modelStatusUrl)};
                import { loadUiTweaksSettings } from ${JSON.stringify(settingsUrl)};
                import { SelectList } from "@earendil-works/pi-tui";

                const expectedErrors = loadUiTweaksSettings(${JSON.stringify(directory)}, true)
                    .errors.map(message => ({ message: "[pi-ui-tweaks] " + message, severity: "error" }));
                assert.ok(expectedErrors.length > 0);
                const warning = ${JSON.stringify(warning)};
                const first = [];
                const second = [];
                const handlers = new Map();
                extension({ on(event, handler) {
                    const callbacks = handlers.get(event) ?? [];
                    callbacks.push(handler);
                    handlers.set(event, callbacks);
                } });
                const context = notices => ({
                    cwd: ${JSON.stringify(directory)},
                    hasUI: ${JSON.stringify(hasUI)},
                    isProjectTrusted: () => true,
                    ui: {
                        notify(message, severity) {
                            assert.ok(${JSON.stringify(hasUI)}, "headless session must not notify");
                            notices.push({ message, severity });
                        },
                        getEditorComponent() {}, setEditorComponent() {}, setWidget() {},
                    },
                });
                const emit = async (type, ctx) => {
                    for (const handler of handlers.get(type) ?? []) {
                        await handler({ type, reason: "reload" }, ctx);
                    }
                };
                const unavailable = () => installModelStatusPatch({ hideModelChangeStatus: true }, null).dispose();
                const originalRender = SelectList.prototype.render;
                unavailable(); // Before a session: queue, never print.
                await emit("session_start", context(first));
                assert.notEqual(SelectList.prototype.render, originalRender);
                unavailable(); // Active session: notify, or explicit headless stderr.
                await emit("session_shutdown", context(first));
                assert.equal(SelectList.prototype.render, originalRender);
                const afterShutdown = first.length;
                unavailable(); // Disposed session must not receive diagnostics.
                assert.equal(first.length, afterShutdown);
                await emit("session_start", context(second));
                await emit("session_shutdown", context(second));
                assert.equal(SelectList.prototype.render, originalRender);
                const expectedFirst = [{ message: warning, severity: "warning" },
                    ...expectedErrors, { message: warning, severity: "warning" }];
                const expectedSecond = [{ message: warning, severity: "warning" }, ...expectedErrors];
                if (${JSON.stringify(hasUI)}) {
                    assert.deepEqual(first, expectedFirst);
                    assert.deepEqual(second, expectedSecond);
                    process.stdout.write("ok");
                } else {
                    assert.deepEqual(first, []);
                    assert.deepEqual(second, []);
                    process.stdout.write(JSON.stringify([...expectedFirst, ...expectedSecond]
                        .map(diagnostic => diagnostic.message + "\\n").join("")));
                }
                `,
            ],
            {
                encoding: "utf8",
                env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
                timeout: 30_000,
            },
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("factory routes startup, active and reload diagnostics through UI without terminal writes", async () => {
    const result = await runDiagnosticSession(true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ok");
    assert.equal(result.stderr, "");
});

test("explicit headless sessions preserve configuration errors and patch warnings on stderr", async () => {
    const result = await runDiagnosticSession(false);
    assert.equal(result.status, 0, result.stderr);
    const expected: unknown = JSON.parse(result.stdout);
    assert.equal(result.stderr, expected);
});
