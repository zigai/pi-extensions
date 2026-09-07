import { visibleWidth } from "@earendil-works/pi-tui";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/load.ts";
import { PiPtyProcess, type PiProcessOptions, type PtyScreenFrame } from "./pi-process-harness.ts";

const CTRL_O = "\u000f";
const PTY_TIMEOUT_MS = 20_000;

type FixtureWorkspace = {
    readonly root: string;
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionPath: string;
};

function createFixtureWorkspace(workspaceName = "workspace"): FixtureWorkspace {
    const root = mkdtempSync(join(tmpdir(), "pi-glowup-pty-"));
    const cwd = join(root, workspaceName);
    const agentDir = join(root, "agent");
    const extensionDirectory = join(agentDir, "extensions");
    const configDirectory = join(agentDir, "extension-settings");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(extensionDirectory, { recursive: true });
    mkdirSync(configDirectory, { recursive: true });

    const glowupPath = resolve("src/index.ts");
    const providerPath = resolve("test/pty/fixtures/offline-provider.ts");
    writeFileSync(
        join(extensionDirectory, "glowup.ts"),
        `export { default } from ${JSON.stringify(glowupPath)};\n`,
    );
    writeFileSync(
        join(extensionDirectory, "offline-provider.ts"),
        `export { default } from ${JSON.stringify(providerPath)};\n`,
    );
    copyFileSync(resolve("test/pty/fixtures/settings.json"), join(agentDir, "settings.json"));
    copyFileSync(resolve("test/pty/fixtures/keybindings.json"), join(agentDir, "keybindings.json"));
    copyFileSync(resolve("test/pty/fixtures/config.json"), getGlowupGlobalConfigPath(agentDir));
    const sessionPath = join(root, "restored-session.jsonl");
    const sessionFixture = readFileSync(
        resolve("test/pty/fixtures/restored-session.jsonl"),
        "utf8",
    ).replace("/deterministic/pty-fixture", () => JSON.stringify(cwd).slice(1, -1));
    writeFileSync(sessionPath, sessionFixture);

    return { root, cwd, agentDir, sessionPath };
}

function launchOptions(
    fixture: FixtureWorkspace,
    options: Partial<
        Pick<PiProcessOptions, "sessionPath" | "initialPrompt" | "tuiMode" | "columns" | "rows">
    > = {},
): PiProcessOptions {
    return {
        cwd: fixture.cwd,
        agentDir: fixture.agentDir,
        columns: 160,
        rows: 42,
        ...options,
    };
}

function mutationBlock(frame: PtyScreenFrame, path: string, followingText: string): string {
    const start = frame.rows.findIndex((row) => row.text.includes(`Patched ${path}`));
    if (start < 0) throw new Error(`missing completed mutation header for ${path}`);
    const end = frame.rows.findIndex(
        (row, index) => index > start && row.text.includes(followingText),
    );
    if (end < 0) throw new Error(`missing following transcript marker ${followingText}`);
    return frame.rows
        .slice(start, end)
        .map((row) => row.text.trimEnd())
        .join("\n")
        .trimEnd();
}

function countMatches(text: string, pattern: RegExp): number {
    return [...text.matchAll(pattern)].length;
}

function expectTerminalInvariants(frame: PtyScreenFrame, internalPaths: readonly string[]): void {
    expect(frame.text).not.toContain("Patch patch");
    expect(frame.text).not.toContain("undefined");
    expect(frame.text).not.toContain("NaN");
    expect(frame.text).not.toContain("�");
    expect(frame.text).not.toMatch(/"patch"\s*:/u);
    expect(frame.text).not.toContain("artifacts/pty");

    for (const internalPath of internalPaths) expect(frame.text).not.toContain(internalPath);
    expect(
        countMatches(frame.text, /\b(?:Patching|Patched|Failed to patch)\b/gu),
    ).toBeLessThanOrEqual(1);

    for (const row of frame.rows) {
        expect(visibleWidth(row.text)).toBeLessThanOrEqual(frame.columns);
        expect(row.isWrapped).toBe(false);
    }
}

function trailingBlankRowsBefore(frame: PtyScreenFrame, text: string): number {
    const end = frame.rows.findIndex((row) => row.text.includes(text));
    if (end < 0) throw new Error(`missing terminal row containing ${text}`);
    let blanks = 0;
    for (let index = end - 1; index >= 0 && frame.rows[index]?.text.trim() === ""; index -= 1) {
        blanks += 1;
    }

    return blanks;
}

function lifecycleState(frame: PtyScreenFrame): string | undefined {
    if (frame.text.includes("Patched src/current.ts")) return "completed";
    if (frame.text.includes("Patching src/current.ts")) return "rewritten";

    if (frame.text.includes("Patching src/obsolete.ts") && !frame.text.includes("staleTailTwo")) {
        return "shrunk";
    }

    if (frame.text.includes("Patching src/obsolete.ts")) return "obsolete";
    if (/\bPatching\b/u.test(frame.text)) return "header";
    return undefined;
}

function compressedLifecycle(frames: readonly PtyScreenFrame[]): readonly string[] {
    const states: string[] = [];
    for (const frame of frames) {
        const state = lifecycleState(frame);
        if (state !== undefined && states.at(-1) !== state) states.push(state);
    }

    return states;
}

describe("actual Pi CLI in a real PTY", () => {
    const fixtures: FixtureWorkspace[] = [];

    afterEach(() => {
        for (const fixture of fixtures.splice(0)) {
            rmSync(fixture.root, { recursive: true, force: true });
        }
    });

    it("keeps restored mutation history immutable through expansion, resize, reload, and resume", async () => {
        const fixture = createFixtureWorkspace('workspace "$&\\end');
        fixtures.push(fixture);
        let pi = new PiPtyProcess(launchOptions(fixture, { sessionPath: fixture.sessionPath }));
        try {
            const initial = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("Patched restored.ts") &&
                    frame.text.includes("SESSION_SENTINEL") &&
                    frame.text.includes("ASK_RESTORE_SENTINEL") &&
                    frame.text.includes("Asked User") &&
                    frame.text.includes("Choose one:"),
                PTY_TIMEOUT_MS,
            );
            expectTerminalInvariants(initial, [
                resolve("test/pty/fixtures/offline-provider.ts"),
                resolve("artifacts/pty"),
            ]);
            const initialBlock = mutationBlock(initial, "restored.ts", "SESSION_SENTINEL");
            expect(initialBlock).toContain("to expand");
            expect(initialBlock).not.toContain("restored5");
            expect(initial.text).toContain("Candidates · Which candidates should be restored?");
            expect(initial.text).toContain("Stable only");
            expect(initial.text).not.toContain("questions: 1 item");

            let nextSequence = pi.frames().length;
            pi.sendKey(CTRL_O);
            const expanded = await pi.waitForFrame(
                (frame) => frame.text.includes("restored5") && !frame.text.includes("to expand"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );
            expectTerminalInvariants(expanded, [resolve("test/pty/fixtures/offline-provider.ts")]);
            expect(countMatches(expanded.text, /Patched restored\.ts/gu)).toBe(1);

            nextSequence = pi.frames().length;
            pi.sendKey(CTRL_O);
            const collapsed = await pi.waitForFrame(
                (frame) => frame.text.includes("to expand"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );
            expect(mutationBlock(collapsed, "restored.ts", "SESSION_SENTINEL")).toBe(initialBlock);

            nextSequence = pi.frames().length;
            pi.resize(70, 42);
            const narrow = await pi.waitForFrame(
                (frame) => frame.columns === 70 && frame.text.includes("Patched restored.ts"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );
            expectTerminalInvariants(narrow, [resolve("test/pty/fixtures/offline-provider.ts")]);

            nextSequence = pi.frames().length;
            pi.resize(160, 42);
            const widened = await pi.waitForFrame(
                (frame) => frame.columns === 160 && frame.text.includes("SESSION_SENTINEL"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );
            expect(mutationBlock(widened, "restored.ts", "SESSION_SENTINEL")).toBe(initialBlock);

            nextSequence = pi.frames().length;
            pi.sendText("/reload\r");
            await pi.waitForFrame(
                (frame) => frame.text.includes("Reloading keybindings"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );
            const reloaded = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("Patched restored.ts") &&
                    frame.text.includes("SESSION_SENTINEL") &&
                    !frame.text.includes("Reloading keybindings"),
                PTY_TIMEOUT_MS,
                nextSequence + 1,
            );
            expect(mutationBlock(reloaded, "restored.ts", "SESSION_SENTINEL")).toBe(initialBlock);
            expectTerminalInvariants(reloaded, [resolve("test/pty/fixtures/offline-provider.ts")]);

            await pi.stop();
            pi = new PiPtyProcess(launchOptions(fixture, { sessionPath: fixture.sessionPath }));
            const resumed = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("Patched restored.ts") &&
                    frame.text.includes("SESSION_SENTINEL"),
                PTY_TIMEOUT_MS,
            );
            expect(mutationBlock(resumed, "restored.ts", "SESSION_SENTINEL")).toBe(initialBlock);
            expectTerminalInvariants(resumed, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("restored-resize-reload-resume", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 60_000);

    it("shows every restored mutation row and reflows apply_patch in fullscreen", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        writeFileSync(
            getGlowupGlobalConfigPath(fixture.agentDir),
            JSON.stringify({
                toolLabels: { mode: "lifecycle" },
                appearance: { sideBySideLayout: "fixed" },
            }),
        );
        const pi = new PiPtyProcess(
            launchOptions(fixture, {
                sessionPath: fixture.sessionPath,
                tuiMode: "fullscreen",
            }),
        );
        try {
            const wide = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("Patched restored.ts") &&
                    frame.text.includes("restored9") &&
                    frame.text.includes("SESSION_SENTINEL"),
                PTY_TIMEOUT_MS,
            );
            const wideBlock = mutationBlock(wide, "restored.ts", "SESSION_SENTINEL");
            expect(wideBlock).toContain("restored1");
            expect(wideBlock).toContain("restored5");
            expect(wideBlock).toContain("restored9");
            expect(wideBlock).toContain(" │ ");
            expect(wideBlock).not.toContain("to expand");
            expectTerminalInvariants(wide, [resolve("test/pty/fixtures/offline-provider.ts")]);

            const nextSequence = pi.frames().length;
            pi.resize(70, 42);
            const narrow = await pi.waitForFrame(
                (frame) =>
                    frame.columns === 70 &&
                    frame.text.includes("restored9") &&
                    frame.text.includes("SESSION_SENTINEL"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );
            const narrowBlock = mutationBlock(narrow, "restored.ts", "SESSION_SENTINEL");
            expect(narrowBlock).toContain("restored1");
            expect(narrowBlock).toContain("restored9");
            expect(narrowBlock).not.toContain(" │ ");
            expectTerminalInvariants(narrow, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("full-default-apply-patch", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("uses unified layout when a content-aware split pane would wrap", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        mkdirSync(join(fixture.cwd, "src"), { recursive: true });
        writeFileSync(
            join(fixture.cwd, "src/layout.ts"),
            `export const longValue = "${"x".repeat(72)}old";\n`,
        );
        const pi = new PiPtyProcess(
            launchOptions(fixture, {
                initialPrompt: "run the deterministic wrapping patch",
                tuiMode: "fullscreen",
            }),
        );
        try {
            const unified = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("STREAM_COMPLETE") &&
                    frame.text.includes("Edited src/layout.ts") &&
                    frame.text.includes("old") &&
                    frame.text.includes("new"),
                PTY_TIMEOUT_MS,
            );
            const changedRows = unified.rows.filter(
                (row) =>
                    row.text.includes("longValue") &&
                    (row.text.includes("old") || row.text.includes("new")),
            );
            expect(changedRows).toHaveLength(2);
            expect(changedRows.every((row) => !row.isWrapped)).toBe(true);
            expect(
                changedRows.every((row) => !(row.text.includes("old") && row.text.includes("new"))),
            ).toBe(true);
            expectTerminalInvariants(unified, [resolve("test/pty/fixtures/offline-provider.ts")]);

            const wideSequence = pi.frames().length;
            pi.resize(240, 42);
            const split = await pi.waitForFrame(
                (frame) =>
                    frame.columns === 240 &&
                    frame.rows.some(
                        (row) =>
                            row.text.includes("longValue") &&
                            row.text.includes("old") &&
                            row.text.includes("new"),
                    ),
                PTY_TIMEOUT_MS,
                wideSequence,
            );
            expectTerminalInvariants(split, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("content-aware-wrap-fallback", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("reflows a completed Bash chain in the actual Pi process", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        const pi = new PiPtyProcess(
            launchOptions(fixture, { initialPrompt: "run the deterministic bash chain" }),
        );
        try {
            const wide = await pi.waitForText("STREAM_COMPLETE", PTY_TIMEOUT_MS);
            const wideCallRows = wide.rows.filter(
                (row) => row.text.includes("Bash") && row.text.includes("CHAIN_ALPHA"),
            );
            expect(wideCallRows).toHaveLength(1);
            expect(wideCallRows[0]?.text).toContain("&& printf");
            expectTerminalInvariants(wide, [resolve("test/pty/fixtures/offline-provider.ts")]);

            const narrowSequence = pi.frames().length;
            pi.resize(44, 42);
            const narrow = await pi.waitForFrame(
                (frame) =>
                    frame.columns === 44 &&
                    frame.rows.some(
                        (row) =>
                            row.text.includes("CHAIN_ALPHA") && row.text.trimEnd().endsWith("&&"),
                    ),
                PTY_TIMEOUT_MS,
                narrowSequence,
            );
            expect(
                narrow.rows
                    .filter(
                        (row) =>
                            row.text.includes("CHAIN_ALPHA") || row.text.includes("CHAIN_BETA"),
                    )
                    .every((row) => !row.isWrapped),
            ).toBe(true);
            expectTerminalInvariants(narrow, [resolve("test/pty/fixtures/offline-provider.ts")]);

            const restoredSequence = pi.frames().length;
            pi.resize(160, 42);
            const restored = await pi.waitForFrame(
                (frame) =>
                    frame.columns === 160 &&
                    frame.rows.some(
                        (row) => row.text.includes("Bash") && row.text.includes("CHAIN_ALPHA"),
                    ),
                PTY_TIMEOUT_MS,
                restoredSequence,
            );
            expect(
                restored.rows.filter(
                    (row) => row.text.includes("Bash") && row.text.includes("CHAIN_ALPHA"),
                ),
            ).toHaveLength(1);
            expectTerminalInvariants(restored, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("bash-chain-resize", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("separates and structures compound Bash even when the command fits", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        const pi = new PiPtyProcess(
            launchOptions(fixture, {
                columns: 312,
                initialPrompt: "run the deterministic bash layout",
            }),
        );
        try {
            const completed = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("STREAM_COMPLETE") &&
                    frame.rows.some((row) => row.text.trim() === "• Bash") &&
                    frame.rows.some((row) =>
                        row.text.includes("│ for item in alpha beta gamma delta; do"),
                    ) &&
                    frame.rows.some((row) => row.text.includes("│   if test")) &&
                    frame.rows.some((row) => row.text.includes("│ done | sort")),
                PTY_TIMEOUT_MS,
            );

            expect(completed.text).not.toContain("• Bash for item");
            expectTerminalInvariants(completed, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("wide-compound-bash-layout", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("redraws a completed standalone script when language formatting finishes", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        writeFileSync(
            getGlowupGlobalConfigPath(fixture.agentDir),
            JSON.stringify({
                scriptPreview: {
                    formatters: {
                        python: [
                            process.execPath,
                            "-e",
                            "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.replace('; ', '\\n')))",
                        ],
                    },
                },
            }),
        );
        const pi = new PiPtyProcess(
            launchOptions(fixture, { initialPrompt: "run the deterministic formatted python" }),
        );
        try {
            const formatted = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("STREAM_COMPLETE") &&
                    frame.rows.some((row) => row.text.includes("│ import os")) &&
                    frame.rows.some((row) => row.text.includes("│ print(os.getcwd())")),
                PTY_TIMEOUT_MS,
            );

            expect(formatted.text).toContain("Python");
            expect(formatted.text).not.toContain("one Bash execution");
            expect(formatted.text).not.toContain("Python import os; print(os.getcwd())");
            expectTerminalInvariants(formatted, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("standalone-script-formatter-redraw", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("renders uv Python argv as Python and restores silent imports when expanded", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        const pi = new PiPtyProcess(
            launchOptions(fixture, {
                rows: 70,
                initialPrompt: "run the deterministic uv python args",
            }),
        );
        try {
            const collapsed = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("STREAM_COMPLETE") &&
                    frame.text.includes("• Python") &&
                    frame.text.includes("records = ["),
                PTY_TIMEOUT_MS,
            );

            expect(collapsed.text).not.toContain("uv run");
            expect(collapsed.text).not.toContain("import json");
            expect(collapsed.text).not.toContain("import/setup lines omitted");
            expect(collapsed.text).toContain("… +6 lines (ctrl+o to expand)");
            const argvIndex = collapsed.rows.findIndex((row) => row.text.includes('"argv"'));
            const outputMarkerIndex = collapsed.rows.findIndex(
                (row, index) => index > argvIndex && row.text.includes("… +8 lines"),
            );
            const medianIndex = collapsed.rows.findIndex((row) => row.text.includes('"median_ms"'));
            expect(argvIndex).toBeGreaterThanOrEqual(0);
            expect(outputMarkerIndex).toBeGreaterThan(argvIndex);
            expect(medianIndex).toBeGreaterThan(outputMarkerIndex);
            expectTerminalInvariants(collapsed, [resolve("test/pty/fixtures/offline-provider.ts")]);

            const nextSequence = pi.frames().length;
            pi.sendKey(CTRL_O);
            const expanded = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("• Python") &&
                    frame.text.includes("import json") &&
                    frame.text.includes("from collections import Counter"),
                PTY_TIMEOUT_MS,
                nextSequence,
            );

            expect(expanded.text).not.toContain("uv run");
            expectTerminalInvariants(expanded, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("uv-python-args", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("keeps an inline Python pipeline as one Bash call", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        const pi = new PiPtyProcess(
            launchOptions(fixture, {
                initialPrompt: "run the deterministic inline python pipeline",
            }),
        );
        try {
            const completed = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("STREAM_COMPLETE") &&
                    frame.text.includes("• Bash") &&
                    frame.text.includes("python3 -c 'import sys") &&
                    frame.text.includes("0013 patch"),
                PTY_TIMEOUT_MS,
            );

            expect(completed.text).toContain("| sort -nr | head -n 3");
            expect(completed.text).not.toContain("• Python");
            expectTerminalInvariants(completed, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("inline-python-pipeline", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("reclassifies a speculative Python partial as completed Bash", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        const pi = new PiPtyProcess(
            launchOptions(fixture, { initialPrompt: "run the deterministic reclassified bash" }),
        );
        try {
            const completed = await pi.waitForFrame(
                (frame) =>
                    frame.text.includes("STREAM_COMPLETE") &&
                    frame.text.includes("FINAL_BASH_RENDER"),
                PTY_TIMEOUT_MS,
            );

            expect(completed.text).toContain("• Bash");
            expect(completed.text).toContain("node --input-type=module");
            expect(completed.text).not.toContain("• Python");
            expect(completed.text).not.toContain("SPECULATIVE_PYTHON");
            expectTerminalInvariants(completed, [resolve("test/pty/fixtures/offline-provider.ts")]);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("reclassified-bash", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);

    it("captures every deterministic streaming apply_patch lifecycle without stale or duplicate rows", async () => {
        const fixture = createFixtureWorkspace();
        fixtures.push(fixture);
        const pi = new PiPtyProcess(
            launchOptions(fixture, { initialPrompt: "run the deterministic patch stream" }),
        );
        try {
            const completed = await pi.waitForText("STREAM_COMPLETE", PTY_TIMEOUT_MS);
            const frames = pi.frames();
            const firstLifecycle = frames.findIndex((frame) => lifecycleState(frame) !== undefined);
            expect(firstLifecycle).toBeGreaterThanOrEqual(0);
            const lifecycleFrames = frames.slice(firstLifecycle);
            const states = compressedLifecycle(lifecycleFrames);
            expect(states).toEqual(["header", "obsolete", "shrunk", "rewritten", "completed"]);

            const rewrittenIndex = lifecycleFrames.findIndex(
                (frame) => lifecycleState(frame) === "rewritten",
            );
            expect(rewrittenIndex).toBeGreaterThanOrEqual(0);

            for (const frame of lifecycleFrames.slice(rewrittenIndex)) {
                expect(frame.text).not.toContain("src/obsolete.ts");
                expect(frame.text).not.toContain("OBSOLETE_STREAM_MARKER");
                expect(frame.text).not.toContain("staleTailTwo");
            }

            for (const frame of lifecycleFrames) {
                expectTerminalInvariants(frame, [
                    resolve("test/pty/fixtures/offline-provider.ts"),
                    resolve("artifacts/pty"),
                ]);
            }

            expect(countMatches(completed.text, /Patched src\/current\.ts/gu)).toBe(1);
            expect(completed.text).toContain("CURRENT_STREAM_MARKER");
            expect(completed.text).toContain("🧪");
            expect(completed.text).not.toContain("Done!");
            expect(trailingBlankRowsBefore(completed, "STREAM_COMPLETE")).toBeLessThanOrEqual(1);
        } catch (cause: unknown) {
            await pi.writeFailureArtifacts("streaming-apply-patch", cause);
            throw cause;
        } finally {
            await pi.stop();
        }
    }, 45_000);
});
