import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
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
        const projectSettings = SettingsManager.inMemory({ sessionShareDestination: "radius" });
        let cancelled = false;
        const notifications: string[] = [];
        const tab = new PiSettingsTab({
            globalSettings: settings,
            projectSettings,
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
                mode: "regular",
                setClearOnShrink() {},
                setShowHardwareCursor() {},
            },
            model: undefined,
            availableDefaultModels: [],
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
        expect(rendered.split("\n").find((line) => line.includes(">"))).toMatch(/\(1\/\d+\)$/);
        expect(rendered.match(/\(1\/\d+\)/g)).toHaveLength(1);
        expect(tab.activeScope).toBe("global");
        expect(tab.selectScope("project")).toBe(false);

        tab.handleInput(" ");
        await tab.flush();
        expect(settings.getCompactionEnabled()).toBe(false);
        tab.handleInput("share");
        expect(stripTerminalSequences(tab.render(100).join("\n"))).toMatch(
            /Session share destination +auto/,
        );
        tab.handleInput("\r");
        await tab.flush();
        expect(settings.getSessionShareDestination()).toBe("gist");
        expect(projectSettings.getSessionShareDestination()).toBe("radius");
        expect(notifications).toEqual([]);

        tab.handleInput("\u001b");
        expect(cancelled).toBe(true);
    });

    it("persists Pi controls to trusted project scope", async () => {
        initTheme("dark", false);
        const cwd = await mkdtemp(join(tmpdir(), "pi-settings-ui-tab-"));
        const projectSnapshot = await loadPiProjectSettings(cwd, true);
        const globalSettings = SettingsManager.inMemory({
            compaction: { enabled: true },
            sessionShareDestination: "radius",
        });
        const projectSettings = SettingsManager.create(cwd, join(cwd, "agent"));
        const tab = new PiSettingsTab({
            globalSettings,
            projectSettings,
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
                mode: "regular",
                setClearOnShrink() {},
                setShowHardwareCursor() {},
            },
            model: undefined,
            availableDefaultModels: [],
            terminalTheme: "dark",
            onCancel() {},
            requestRender() {},
        });

        expect(tab.selectScope("project")).toBe(true);
        tab.handleInput(" ");
        await tab.flush();
        tab.handleInput("mermaid");
        expect(tab.render(100).join("\n")).toContain("Mermaid diagrams");
        tab.handleInput("\r");
        await tab.flush();
        tab.handleInput("\u0015");
        tab.handleInput("share");
        expect(stripTerminalSequences(tab.render(100).join("\n"))).toMatch(
            /Session share destination +auto/,
        );
        tab.handleInput("\r");
        await tab.flush();
        expect(projectSettings.getSessionShareDestination()).toBe("gist");
        expect(globalSettings.getSessionShareDestination()).toBe("radius");
        expect(globalSettings.getCompactionEnabled()).toBe(true);
        expect(JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({
            compaction: { enabled: false },
            markdown: { mermaid: "off" },
            sessionShareDestination: "gist",
        });
    });

    it("renders and persists Pi 0.84 fullscreen settings", async () => {
        initTheme("dark", false);
        const settings = SettingsManager.inMemory({ tuiMode: "fullscreen" });
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
                getAllThemes: () => [{ name: "dark", path: undefined }],
                notify: (message) => notifications.push(message),
                setTheme: () => ({ success: true }),
            },
            runtime: {
                mode: "fullscreen",
                setClearOnShrink() {},
                setShowHardwareCursor() {},
            },
            model: undefined,
            availableDefaultModels: [],
            terminalTheme: "dark",
            onCancel() {},
            requestRender() {},
        });

        tab.handleInput("tui");
        const rendered = tab.render(100).join("\n");
        expect(rendered).toContain("TUI mode");
        expect(rendered).toContain("fullscreen");
        tab.handleInput("\r");
        await tab.flush();

        expect(settings.getTuiMode()).toBe("regular");
        expect(notifications).toContain("TUI mode will change to regular in the next Pi session.");
    });
});
