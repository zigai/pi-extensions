import { visibleWidth } from "@earendil-works/pi-tui";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGlowupGlobalConfigPath } from "../../src/config/config.ts";
import { PiPtyProcess, type PiProcessOptions, type PtyScreenFrame } from "./pi-process-harness.ts";

const CTRL_O = "\u000f";
const PTY_TIMEOUT_MS = 20_000;

type FixtureWorkspace = {
    readonly root: string;
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionPath: string;
};

function createFixtureWorkspace(): FixtureWorkspace {
    const root = mkdtempSync(join(tmpdir(), "pi-glowup-pty-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const extensionDirectory = join(agentDir, "extensions");
    const configDirectory = join(agentDir, "pi-glowup");
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
    ).replace("/deterministic/pty-fixture", cwd.replaceAll("\\", "\\\\"));
    writeFileSync(sessionPath, sessionFixture);
    return { root, cwd, agentDir, sessionPath };
}

function launchOptions(
    fixture: FixtureWorkspace,
    options: Partial<Pick<PiProcessOptions, "sessionPath" | "initialPrompt">> = {},
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
        const fixture = createFixtureWorkspace();
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
