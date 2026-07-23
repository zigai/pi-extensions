import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { loadPiProjectSettings } from "../src/pi-project-settings.ts";
import { PiSettingsTab } from "../src/pi-settings-tab.ts";

describe("Pi settings tab", () => {
    it("renders Pi's regular selector and persists its settings callbacks", async () => {
        initTheme("dark", false);
        const settings = SettingsManager.inMemory({
            compaction: { enabled: true },
            theme: "dark",
        });
        let cancelled = false;
        const notifications: string[] = [];
        const tab = new PiSettingsTab({
            globalSettings: settings,
            projectSettings: SettingsManager.inMemory(),
            projectSnapshot: {
                _tag: "UnavailableProjectSettings",
                path: "/project/.pi/settings.json",
                message: "Project is untrusted.",
            },
            pi: {
                getThinkingLevel: () => "high",
                setThinkingLevel() {},
            },
            ui: {
                getAllThemes: () => [
                    { name: "dark", path: undefined },
                    { name: "light", path: undefined },
                ],
                notify: (message) => notifications.push(message),
                setTheme: () => ({ success: true }),
            },
            runtime: {
                setClearOnShrink() {},
                setShowHardwareCursor() {},
            },
            model: undefined,
            terminalTheme: "dark",
            onCancel: () => {
                cancelled = true;
            },
            requestRender() {},
        });

        const rendered = tab.render(100).join("\n");
        expect(rendered).toContain("Auto-compact");
        expect(rendered).toContain("Auto-resize images");
        expect(rendered).toContain("Terminal progress");
        expect(rendered.split("\n").find((line) => line.includes(">"))).toMatch(/\(1\/25\)$/);
        expect(rendered.match(/\(1\/25\)/g)).toHaveLength(1);
        expect(tab.activeScope).toBe("global");
        expect(tab.selectScope("project")).toBe(false);

        tab.handleInput(" ");
        await tab.flush();
        expect(settings.getCompactionEnabled()).toBe(false);
        expect(notifications).toEqual([]);

        tab.handleInput("\u001b");
        expect(cancelled).toBe(true);
    });

    it("persists Pi controls to trusted project scope", async () => {
        initTheme("dark", false);
        const cwd = await mkdtemp(join(tmpdir(), "pi-settings-ui-tab-"));
        const projectSnapshot = await loadPiProjectSettings(cwd, true);
        const tab = new PiSettingsTab({
            globalSettings: SettingsManager.inMemory({ compaction: { enabled: true } }),
            projectSettings: SettingsManager.inMemory({ compaction: { enabled: true } }),
            projectSnapshot,
            pi: {
                getThinkingLevel: () => "high",
                setThinkingLevel() {},
            },
            ui: {
                getAllThemes: () => [{ name: "dark", path: undefined }],
                notify() {},
                setTheme: () => ({ success: true }),
            },
            runtime: {
                setClearOnShrink() {},
                setShowHardwareCursor() {},
            },
            model: undefined,
            terminalTheme: "dark",
            onCancel() {},
            requestRender() {},
        });

        expect(tab.selectScope("project")).toBe(true);
        tab.handleInput(" ");
        await tab.flush();
        expect(JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({
            compaction: { enabled: false },
        });
    });
});
