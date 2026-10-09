import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager, initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { loadPiProjectSettings } from "../src/pi-project-settings.ts";
import { PiSettingsTab, type PiSettingsTabOptions } from "../src/pi-settings-tab.ts";

const currentModel: NonNullable<ExtensionContext["model"]> = {
    id: "reasoning/model",
    name: "Reasoning model",
    provider: "test",
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 1000,
};

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map(async (directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function fixture(overrides: Partial<PiSettingsTabOptions> = {}) {
    initTheme("system", false);
    const cwd = await mkdtemp(join(tmpdir(), "pi-settings-latest-"));
    directories.push(cwd);
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir);
    await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ defaultThinkingLevel: "medium", unrelated: true }),
    );
    const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const projectSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const projectSnapshot = await loadPiProjectSettings(cwd, true);
    const themes: string[] = [];
    const levels: string[] = [];
    const notifications: string[] = [];
    const tab = new PiSettingsTab({
        globalSettings,
        projectSettings,
        projectSnapshot,
        pi: {
            getThinkingLevel: () => "high",
            setThinkingLevel: (level) => {
                levels.push(level);
            },
        },
        ui: {
            getAllThemes: () => ["system", "light"].map((name) => ({ name, path: undefined })),
            setTheme: (name) => {
                themes.push(String(name));
                return { success: true };
            },
            notify: (message) => {
                notifications.push(message);
            },
        },
        runtime: { mode: "regular", setClearOnShrink() {}, setShowHardwareCursor() {} },
        model: currentModel,
        availableDefaultModels: [currentModel],
        terminalTheme: "dark",
        onCancel() {},
        requestRender() {},
        ...overrides,
    });

    return { tab, cwd, agentDir, globalSettings, projectSettings, themes, levels, notifications };
}

function openSetting(tab: PiSettingsTab, query: string): void {
    tab.handleInput(query);
    tab.handleInput("\r");
}

describe("latest native settings contract", () => {
    it("constructs the actual selector without an authenticated model catalog", async () => {
        const { tab } = await fixture({ model: undefined, availableDefaultModels: [] });
        expect(tab.render(100).join("\n")).toContain("Auto-compact");
        openSetting(tab, "Default thinking level per model");
        expect(tab.render(100).join("\n")).toContain("No models available");
    });

    it.each(["global", "project"] as const)(
        "persists new fullscreen controls only in %s scope",
        async (scope) => {
            const { tab, cwd, agentDir, globalSettings, projectSettings } = await fixture();
            expect(tab.selectScope(scope)).toBe(true);
            openSetting(tab, "Fullscreen exit output");
            await tab.flush();
            tab.selectScope(scope);
            openSetting(tab, "Fullscreen copy on select");
            await tab.flush();
            tab.selectScope(scope);
            openSetting(tab, "Fullscreen wheel scrolling");
            await tab.flush();
            const target =
                scope === "global"
                    ? join(agentDir, "settings.json")
                    : join(cwd, ".pi", "settings.json");
            expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
                fullscreenExitOutput: "resume-hint",
                fullscreenCopyOnSelect: false,
                fullscreenWheelScrollLines: 1,
            });

            expect(globalSettings.getFullscreenExitOutput()).toBe(
                scope === "global" ? "resume-hint" : "transcript",
            );

            expect(globalSettings.getSettings()).not.toHaveProperty("cacheWarming");
            await projectSettings.reload();
            expect(projectSettings.getFullscreenCopyOnSelect()).toBe(false);
        },
    );

    it("persists cache warming in global scope", async () => {
        const { tab, globalSettings, notifications } = await fixture();
        openSetting(tab, "Cache warming");
        await tab.flush();

        expect(globalSettings.getCacheWarmingMode()).toBe("idle");
        expect(notifications).toEqual([]);
    });

    it("rejects project cache warming without creating a project override", async () => {
        const { tab, globalSettings, notifications, cwd } = await fixture();
        tab.selectScope("project");
        openSetting(tab, "Cache warming");
        await tab.flush();

        expect(globalSettings.getCacheWarmingMode()).toBe("streaming");
        expect(notifications).toEqual(["Cache warming can only be changed in global Pi settings."]);
        expect(tab.render(100).join("\n")).toContain("streaming");
        await expect(readFile(join(cwd, ".pi", "settings.json"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it.each(["global", "project"] as const)(
        "sets and clears per-model thinking in %s scope",
        async (scope) => {
            const { tab, globalSettings, projectSettings, levels, cwd, agentDir } = await fixture();
            tab.selectScope(scope);
            openSetting(tab, "Default thinking level per model");
            expect(tab.render(100).join("\n")).toContain("reasoning/model");
            tab.handleInput("\r");
            tab.handleInput("\u001b[B");
            tab.handleInput("\r");
            await tab.flush();
            const target =
                scope === "global"
                    ? join(agentDir, "settings.json")
                    : join(cwd, ".pi", "settings.json");
            expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
                modelThinkingLevels: { "test/reasoning/model": "minimal" },
            });

            expect(levels).toEqual(scope === "global" ? ["minimal"] : []);
            expect(globalSettings.getAllModelThinkingLevels()).toEqual(
                scope === "global" ? { "test/reasoning/model": "minimal" } : {},
            );
            await projectSettings.reload();
            expect(projectSettings.getAllModelThinkingLevels()).toEqual({
                "test/reasoning/model": "minimal",
            });

            tab.selectScope(scope);
            openSetting(tab, "Default thinking level per model");
            tab.handleInput("\r");
            tab.handleInput("\u001b[A");
            tab.handleInput("\u001b[A");
            tab.handleInput("\r");
            await tab.flush();
            expect(JSON.parse(await readFile(target, "utf8"))).not.toHaveProperty(
                "modelThinkingLevels.test/reasoning/model",
            );
            await projectSettings.reload();
            expect(projectSettings.getAllModelThinkingLevels()).toEqual({});
            expect(levels).toEqual(scope === "global" ? ["minimal", "medium"] : []);
        },
    );

    it("restores the project system default after theme preview cancellation", async () => {
        const { tab, themes, cwd } = await fixture();
        tab.selectScope("project");
        openSetting(tab, "Theme");
        tab.handleInput("\u001b[B");
        tab.handleInput("\u001b[B");
        expect(themes.at(-1)).toBe("light");
        tab.handleInput("\u001b");

        expect(themes.at(-1)).toBe("system");
        await expect(readFile(join(cwd, ".pi", "settings.json"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("restores the selected half of an automatic theme when leaving a preview", async () => {
        const { tab, themes } = await fixture({
            globalSettings: SettingsManager.inMemory({ theme: "light/system" }),
            terminalTheme: "light",
        });
        openSetting(tab, "Theme");
        tab.handleInput("\r");
        tab.handleInput("\u001b[A");
        expect(themes.at(-1)).toBe("system");
        tab.leave();

        expect(themes.at(-1)).toBe("light");
    });

    it.each(["cancel", "leave", "scope"] as const)(
        "restores the system default after theme preview %s",
        async (action) => {
            const { tab, themes, globalSettings } = await fixture();
            openSetting(tab, "Theme");
            tab.handleInput("\u001b[B");
            tab.handleInput("\u001b[B");
            expect(themes.at(-1)).toBe("light");

            if (action === "cancel") tab.handleInput("\u001b");
            else if (action === "leave") tab.leave();
            else tab.selectScope("project");

            expect(themes.at(-1)).toBe("system");
            expect(globalSettings.getThemeSetting()).toBeUndefined();
        },
    );
});
