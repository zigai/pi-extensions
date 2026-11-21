import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterAll, beforeAll, test } from "vitest";

const extensionUrl = new URL("../src/index.ts", import.meta.url).href;
const modelStatusUrl = new URL("../src/model-status.ts", import.meta.url).href;
const settingsUrl = new URL("../src/settings.ts", import.meta.url).href;
const warning =
    "[pi-ui-tweaks] model status patch unavailable; Pi internals may have changed: missing showStatus";
const phaseEnd = "\u0000phase-end\n";

type PhaseResult = { stdout: string; stderr: string };
type DiagnosticProcess = {
    ready: Promise<void>;
    run(hasUI: boolean): Promise<PhaseResult>;
    dispose(): Promise<void>;
};

let diagnosticProcess: DiagnosticProcess | undefined;

function readPhases(stream: Readable, closed: Promise<void>) {
    let buffer = "";
    stream.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
    });

    return {
        async next(): Promise<string> {
            for (;;) {
                const end = buffer.indexOf(phaseEnd);
                if (end !== -1) {
                    const phase = buffer.slice(0, end);
                    buffer = buffer.slice(end + phaseEnd.length);
                    return phase;
                }

                const more = await Promise.race([
                    once(stream, "data").then(() => true),
                    closed.then(() => false),
                ]);
                if (!more) return buffer;
            }
        },
        text: () => buffer,
    };
}

// A fresh process records the actual terminal streams, without replacing console or stream methods.
// Both scenarios share it because each cold start loads the whole Pi coding agent through tsx.
async function startDiagnosticProcess(): Promise<DiagnosticProcess> {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-ui-diagnostics-"));
    const agentDir = path.join(directory, "agent");
    const settingsDir = path.join(agentDir, "extension-settings");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
        path.join(settingsDir, "pi-ui-tweaks.json"),
        JSON.stringify({ dimInputBorder: "invalid" }),
    );
    try {
        const child: ChildProcess = spawn(
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

                const warning = ${JSON.stringify(warning)};
                const phaseEnd = ${JSON.stringify(phaseEnd)};

                async function scenario(hasUI) {
                    const expectedErrors = loadUiTweaksSettings(${JSON.stringify(directory)}, true)
                        .errors.map(message => ({ message: "[pi-ui-tweaks] " + message, severity: "error" }));
                    assert.ok(expectedErrors.length > 0);
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
                        hasUI,
                        isProjectTrusted: () => true,
                        ui: {
                            notify(message, severity) {
                                assert.ok(hasUI, "headless session must not notify");
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
                    if (hasUI) {
                        assert.deepEqual(first, expectedFirst);
                        assert.deepEqual(second, expectedSecond);
                        return;
                    }

                    assert.deepEqual(first, []);
                    assert.deepEqual(second, []);
                    process.stdout.write(JSON.stringify([...expectedFirst, ...expectedSecond]
                        .map(diagnostic => diagnostic.message + "\\n").join("")));
                }

                process.on("message", async ({ hasUI }) => {
                    await scenario(hasUI);
                    process.stdout.write(phaseEnd);
                    process.stderr.write(phaseEnd);
                    process.send("done");
                });
                process.send("ready");
                `,
            ],
            {
                stdio: ["ignore", "pipe", "pipe", "ipc"],
                env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
                timeout: 30_000,
            },
        );
        assert.ok(child.stdout && child.stderr);
        const closed = once(child, "close").then(() => undefined);
        const stdout = readPhases(child.stdout, closed);
        const stderr = readPhases(child.stderr, closed);
        const exited = async (): Promise<never> => {
            await closed;
            throw new Error(`Diagnostic process exited with ${child.exitCode}: ${stderr.text()}`);
        };

        const ready = Promise.race([
            once(child, "message").then((messages: unknown[]) => {
                assert.equal(messages[0], "ready");
            }),
            exited(),
        ]);

        return {
            ready,
            async run(hasUI) {
                child.send({ hasUI });
                await Promise.race([once(child, "message"), exited()]);

                return { stdout: await stdout.next(), stderr: await stderr.next() };
            },
            async dispose() {
                try {
                    if (child.exitCode === null && child.signalCode === null) child.kill();
                    await closed;
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

beforeAll(async () => {
    diagnosticProcess = await startDiagnosticProcess();
    await diagnosticProcess.ready;
});

afterAll(async () => {
    await diagnosticProcess?.dispose();
});

test("factory routes startup, active and reload diagnostics through UI without terminal writes", async () => {
    assert.ok(diagnosticProcess);
    const result = await diagnosticProcess.run(true);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
});

test("explicit headless sessions preserve configuration errors and patch warnings on stderr", async () => {
    assert.ok(diagnosticProcess);
    const result = await diagnosticProcess.run(false);
    const expected: unknown = JSON.parse(result.stdout);
    assert.equal(result.stderr, expected);
});
