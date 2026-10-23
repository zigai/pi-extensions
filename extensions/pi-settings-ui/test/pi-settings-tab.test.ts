import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { loadPiProjectSettings } from "../src/pi-project-settings.ts";
import { PiSettingsTab, type PiSettingsTabOptions } from "../src/pi-settings-tab.ts";

function createSearchTab(overrides: Partial<PiSettingsTabOptions> = {}): PiSettingsTab {
    initTheme("dark", false);

    return new PiSettingsTab({
        globalSettings: SettingsManager.inMemory(),
        projectSettings: SettingsManager.inMemory(),
        projectSnapshot: {
            _tag: "UnavailableProjectSettings",
            path: "/project/.pi/settings.json",
            message: "Project is untrusted.",
        },
        pi: { getThinkingLevel: () => "high", setThinkingLevel() {} },
        ui: {
            getAllThemes: () => [
                { name: "dark", path: undefined },
                { name: "light", path: undefined },
            ],
            notify() {},
            setTheme: () => ({ success: true }),
        },
        runtime: { mode: "regular", setClearOnShrink() {}, setShowHardwareCursor() {} },
        model: undefined,
        availableDefaultModels: [],
        terminalTheme: "dark",
        onCancel() {},
        requestRender() {},
        ...overrides,
    });
}

describe("Pi settings tab", () => {
    it("discovers value-free metadata independently of the native filter and stored values", () => {
        const tab = createSearchTab({
            globalSettings: SettingsManager.inMemory({ theme: "private-theme-value" }),
        });
        const entries = tab.settingsEntries();
        expect(entries).toContainEqual({
            id: "autocompact",
            label: "Auto-compact",
            description: "Automatically compact context when it gets too large",
        });

        expect(entries).toContainEqual({
            id: "fullscreen-scrollbar",
            label: "Fullscreen scrollbar",
            description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
        });

        expect(entries.map((entry) => Object.keys(entry).sort())).toEqual(
            entries.map(() => ["description", "id", "label"]),
        );

        expect(JSON.stringify(entries)).not.toContain("private-theme-value");

        tab.handleInput("no matching control");
        expect(tab.settingsEntries()).toEqual(entries);
    });

    it.each([
        { images: null, expectedImageIds: [], expectedCount: 33 },
        {
            images: "kitty",
            expectedImageIds: ["show-images", "image-width-cells"],
            expectedCount: 35,
        },
    ] as const)(
        "discovers and focuses every available native control with images=$images",
        ({ images, expectedImageIds, expectedCount }) => {
            const capabilities = getCapabilities();
            setCapabilities({ ...capabilities, images });
            try {
                const tab = createSearchTab();
                const entries = tab.settingsEntries();
                expect(
                    entries
                        .filter(({ id }) => ["show-images", "image-width-cells"].includes(id))
                        .map(({ id }) => id),
                ).toEqual(expectedImageIds);

                expect(new Set(entries.map(({ id }) => id)).size).toBe(entries.length);
                expect(entries).toHaveLength(expectedCount);
                expect(stripTerminalSequences(tab.render(140).join("\n"))).toContain(
                    `(1/${expectedCount})`,
                );

                for (const entry of entries) {
                    tab.handleInput("no matching control");
                    expect(tab.focusSetting(entry.id)).toBe(true);
                    const selected = stripTerminalSequences(tab.render(140).join("\n"))
                        .split("\n")
                        .find((line) => line.startsWith("→"));
                    expect(selected?.startsWith(`→ ${entry.label} `)).toBe(true);
                }
            } finally {
                setCapabilities(capabilities);
            }
        },
    );

    it("focuses an exact setting after filtering without changing it until activated", async () => {
        const settings = SettingsManager.inMemory({ sessionShareDestination: "auto" });
        let renders = 0;
        const tab = createSearchTab({
            globalSettings: settings,
            requestRender: () => {
                renders += 1;
            },
        });
        tab.handleInput("compact");
        expect(tab.focusSetting("share-destination")).toBe(true);
        expect(renders).toBe(2);
        expect(settings.getSessionShareDestination()).toBe("auto");
        expect(stripTerminalSequences(tab.render(100).join("\n"))).toMatch(
            /→ Session share destination +auto/,
        );

        tab.handleInput("\r");
        await tab.flush();
        expect(settings.getSessionShareDestination()).toBe("gist");
        expect(settings.getCompactionEnabled()).toBe(true);
    });

    it("rejects unknown IDs without clearing the current native filter or selection", () => {
        const tab = createSearchTab();
        tab.handleInput("share");
        const before = tab.render(100);
        expect(tab.focusSetting("Session share destination")).toBe(false);
        expect(tab.focusSetting("unknown-setting")).toBe(false);
        expect(tab.render(100)).toEqual(before);
    });

    it("closes a theme preview before focusing another setting without saving the preview", async () => {
        const settings = SettingsManager.inMemory({ theme: "dark" });
        const themes: Array<Parameters<PiSettingsTabOptions["ui"]["setTheme"]>[0]> = [];
        const tab = createSearchTab({
            globalSettings: settings,
            ui: {
                getAllThemes: () => [
                    { name: "dark", path: undefined },
                    { name: "light", path: undefined },
                ],
                notify() {},
                setTheme: (name) => {
                    themes.push(name);
                    return { success: true };
                },
            },
        });
        tab.handleInput("theme");
        tab.handleInput("\r");
        tab.handleInput("\u001b[B");
        expect(themes.at(-1)).toBe("light");
        expect(tab.focusSetting("autocompact")).toBe(true);
        expect(themes.at(-1)).toBe("dark");
        await tab.flush();
        expect(settings.getThemeSetting()).toBe("dark");
        expect(stripTerminalSequences(tab.render(100).join("\n"))).toMatch(/→ Auto-compact +true/);
    });

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
                notify: (message) => {
                    notifications.push(message);
                },
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
        tab.handleInput("no matching control");
        expect(tab.focusSetting("mermaid-rendering")).toBe(true);
        expect(tab.activeScope).toBe("project");
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
                notify: (message) => {
                    notifications.push(message);
                },
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
