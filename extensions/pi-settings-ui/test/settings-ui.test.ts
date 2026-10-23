import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
    stripTerminalSequences,
    TuiAltScreen,
    TuiMainScreen as TUI,
    visibleWidth,
    type Component,
    type Terminal,
    type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { SettingsEditorModel } from "../src/settings-editor.ts";
import type { PiSettingsPane } from "../src/pi-settings-tab.ts";
import { parseExtensionSettingsSchema, parseSettingsDocument } from "../src/settings-schema.ts";
import { settingsSchema } from "../src/settings-input.ts";
import type { CatalogExtensionSettings } from "../src/settings-store.ts";
import { SettingsEditorComponent, type SettingsUiTheme } from "../src/settings-ui.ts";
import { editableCatalog, generatedSchemaText, parseFixtureSchema } from "./fixture.ts";
import { VirtualTerminal } from "./support/virtual-terminal.ts";

function fakeTerminal(columns = 100, rows = 30): Terminal {
    return {
        start() {},
        stop() {},
        async drainInput() {},
        write() {},
        get columns() {
            return columns;
        },
        get rows() {
            return rows;
        },
        get kittyProtocolActive() {
            return false;
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
    };
}

const plainTheme: SettingsUiTheme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
};

const ansiTheme: SettingsUiTheme = {
    fg: (color, text) => `\u001b[${color === "accent" ? 32 : 31}m${text}\u001b[39m`,
    bg: (color, text) => `\u001b[${color === "selectedBg" ? 46 : 44}m${text}\u001b[49m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

const defaultKeys: Pick<KeybindingsManager, "matches"> = {
    matches(data, binding) {
        if (binding === "tui.select.cancel") return data === "\u001b";
        if (binding === "tui.select.up") return data === "\u001b[A";
        if (binding === "tui.select.down") return data === "\u001b[B";
        if (binding === "tui.select.pageUp") return data === "\u001b[5~";
        if (binding === "tui.select.pageDown") return data === "\u001b[6~";
        if (binding === "tui.select.confirm") return data === "\r";
        return false;
    },
};

function fixtureExtension(id: string, title = "Fixture Extension"): CatalogExtensionSettings {
    const parsedSchema = parseFixtureSchema(id);
    const schema = { ...parsedSchema, title };

    return {
        schema,
        global: {
            _tag: "ReadyLayer",
            path: `/agent/extension-settings/${id}.json`,
            sourceText: undefined,
            document: { $schema: schema.schemaReference },
        },
        project: {
            _tag: "UnavailableLayer",
            path: `/project/.pi/extension-settings/${id}.json`,
            message: "Project is untrusted.",
        },
    };
}

function groupedListExtension(): CatalogExtensionSettings {
    const id = "pi-model-filter";
    const schemaText = generatedSchemaText(
        id,
        {
            include: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["provider", "models"],
                    properties: {
                        provider: { type: "string" },
                        models: { type: "array", items: { type: "string" }, minItems: 1 },
                    },
                },
                default: [],
                description: "Provider and model rules.",
            },
        },
        "Pi Model Filter settings",
    );
    const parsed = parseExtensionSettingsSchema(
        id,
        `/agent/extension-settings/schemas/${id}.schema.json`,
        schemaText,
    );
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return {
        schema: parsed.schema,
        global: {
            _tag: "ReadyLayer",
            path: `/agent/extension-settings/${id}.json`,
            sourceText: "existing",
            document: {
                $schema: parsed.schema.schemaReference,
                include: [
                    { provider: "openai-codex", models: ["gpt-5.5*", "gpt-5.6*"] },
                    { provider: "openrouter", models: ["*:free"] },
                ],
            },
        },
        project: {
            _tag: "UnavailableLayer",
            path: `/project/.pi/extension-settings/${id}.json`,
            message: "Project is untrusted.",
        },
    };
}

function textControlExtension(): CatalogExtensionSettings {
    const id = "pi-text-controls";
    const schemaText = generatedSchemaText(id, {
        name: {
            type: "string",
            default: "short value",
            description: "A single-line name.",
        },
        prompt: {
            type: "string",
            default: "First line\nSecond line",
            "x-control": "textarea",
            description: "A multiline prompt.",
        },
    });
    const parsed = parseExtensionSettingsSchema(
        id,
        `/agent/extension-settings/schemas/${id}.schema.json`,
        schemaText,
    );
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return {
        schema: parsed.schema,
        global: {
            _tag: "ReadyLayer",
            path: `/agent/extension-settings/${id}.json`,
            sourceText: undefined,
            document: { $schema: parsed.schema.schemaReference },
        },
        project: {
            _tag: "UnavailableLayer",
            path: `/project/.pi/extension-settings/${id}.json`,
            message: "Project is untrusted.",
        },
    };
}

function hintedControlExtension(): CatalogExtensionSettings {
    const id = "pi-hinted-controls";
    const schemaText = generatedSchemaText(id, {
        theme: {
            type: "string",
            enum: ["one", "two", "three", "four", "five", "six", "seven"],
            default: "one",
            description: "A searchable choice.",
        },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            default: 5,
            description: "A bounded limit.",
        },
        file: {
            type: "string",
            "x-control": "path",
            default: "alph",
            description: "A filesystem path.",
        },
        tint: {
            type: "string",
            "x-control": "color",
            pattern: "^#[0-9a-fA-F]{6}$",
            default: "#123456",
            description: "A hexadecimal color.",
        },
        border: {
            type: "string",
            "x-control": "combobox",
            examples: ["accent", "warning"],
            default: "accent",
            description: "A suggested or custom border name.",
        },
    });
    const parsed = parseExtensionSettingsSchema(
        id,
        `/agent/extension-settings/schemas/${id}.schema.json`,
        schemaText,
    );
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return {
        schema: parsed.schema,
        global: {
            _tag: "ReadyLayer",
            path: `/agent/extension-settings/${id}.json`,
            sourceText: undefined,
            document: { $schema: parsed.schema.schemaReference },
        },
        project: {
            _tag: "UnavailableLayer",
            path: `/project/.pi/extension-settings/${id}.json`,
            message: "Project is untrusted.",
        },
    };
}

function structuredPresentationExtension(): CatalogExtensionSettings {
    const id = "pi-structured";
    const schemaText = generatedSchemaText(
        id,
        {
            slots: {
                type: "array",
                items: {
                    anyOf: [
                        {
                            anyOf: [
                                { const: "cwd", type: "string" },
                                { const: "branch", type: "string" },
                            ],
                        },
                        { type: "string", pattern: "^[a-z]+\\.[a-z]+$" },
                    ],
                    "x-control": "combobox",
                    examples: ["cwd", "branch"],
                },
                default: ["cwd", "branch"],
                description: "Footer slots shown in order.",
            },
            aliases: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["provider", "model", "alias"],
                    properties: {
                        provider: { type: "string" },
                        model: { type: "string" },
                        alias: { type: "string" },
                        name: { type: "string" },
                    },
                },
                default: [
                    {
                        provider: "fireworks",
                        model: "accounts/fireworks/routers/kimi-k2p6-turbo",
                        alias: "kimi-k2.6-turbo",
                        name: "Kimi K2.6 Turbo",
                    },
                ],
                description: "Model aliases.",
            },
            modes: {
                type: "object",
                patternProperties: {
                    "^[a-z]+$": {
                        type: "object",
                        additionalProperties: false,
                        required: ["provider", "modelId"],
                        properties: {
                            provider: { type: "string" },
                            modelId: { type: "string" },
                            thinkingLevel: { type: "string" },
                        },
                    },
                },
                default: {
                    luna: {
                        provider: "openai-codex",
                        modelId: "gpt-5.6-luna",
                        thinkingLevel: "xhigh",
                    },
                    sol: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
                },
                description: "Named model modes.",
            },
            pasteCollapseExpandKey: {
                anyOf: [{ type: "string" }, { type: "null" }],
                default: null,
                description: "Optional paste expansion key.",
            },
            restoreContentAfterAutocompleteCancel: {
                type: "boolean",
                default: true,
                description: "Restore editor content after closing autocomplete.",
            },
        },
        "Pi Structured settings",
    );
    const parsed = parseExtensionSettingsSchema(
        id,
        `/agent/extension-settings/schemas/${id}.schema.json`,
        schemaText,
    );
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return {
        schema: parsed.schema,
        global: {
            _tag: "ReadyLayer",
            path: `/agent/extension-settings/${id}.json`,
            sourceText: undefined,
            document: { $schema: parsed.schema.schemaReference },
        },
        project: {
            _tag: "UnavailableLayer",
            path: `/project/.pi/extension-settings/${id}.json`,
            message: "Project is untrusted.",
        },
    };
}

function contextualCategoryExtension(): CatalogExtensionSettings {
    const id = "pi-status-bar";
    const schemaText = generatedSchemaText(
        id,
        {
            statusBar: {
                type: "object",
                additionalProperties: false,
                default: {},
                properties: {
                    active: {
                        type: "object",
                        additionalProperties: false,
                        default: {},
                        properties: {
                            text: {
                                type: "string",
                                default: "Working",
                                description: "Active status text.",
                            },
                        },
                    },
                },
            },
        },
        "Pi Status Bar settings",
    );
    const parsed = parseExtensionSettingsSchema(
        id,
        `/agent/extension-settings/schemas/${id}.schema.json`,
        schemaText,
    );
    if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);
    return {
        schema: parsed.schema,
        global: {
            _tag: "ReadyLayer",
            path: `/agent/extension-settings/${id}.json`,
            sourceText: undefined,
            document: { $schema: parsed.schema.schemaReference },
        },
        project: {
            _tag: "UnavailableLayer",
            path: `/project/.pi/extension-settings/${id}.json`,
            message: "Project is untrusted.",
        },
    };
}

function fakePiSettingsPane(): PiSettingsPane {
    let activeScope: "global" | "project" = "global";

    return {
        get activeScope() {
            return activeScope;
        },
        handleInput() {},
        settingsEntries: () => [
            {
                id: "autoCompact",
                label: "Auto-compact",
                description: "Automatically enable compaction.",
            },
        ],
        focusSetting: (id) => id === "autoCompact",
        render: () => [
            "Auto-compact  true",
            "Steering mode  one-at-a-time",
            "",
            "Type to search • Enter/Space to change • Esc to cancel",
        ],
        invalidate() {},
        leave() {},
        scopeAvailable: () => true,
        scopeMessage: () => "",
        selectScope(scope) {
            activeScope = scope;
            return true;
        },
        async flush() {},
    };
}

describe("settings TUI", () => {
    it("keeps Pi and the active extension visible when tabs overflow and resize", () => {
        const model = new SettingsEditorModel(
            editableCatalog([
                fixtureExtension("pi-first", "First"),
                fixtureExtension("pi-second", "Second"),
                fixtureExtension("pi-third", "Third"),
                fixtureExtension("pi-fourth", "Fourth"),
                fixtureExtension("pi-last", "Last Extension"),
            ]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\u0010");
        component.handleInput("last");
        component.handleInput("\r");
        const narrow = component.render(48);
        expect(narrow.join("\n")).toContain(" Pi ");
        expect(narrow.join("\n")).toContain("Last Extension");
        expect(narrow.join("\n")).toContain("More (");
        expect(narrow.join("\n")).toContain("‹");
        expect(narrow.every((line) => visibleWidth(line) <= 48)).toBe(true);
        const wide = component.render(180).join("\n");
        expect(wide).toContain("First");
        expect(wide).toContain("Last Extension");
        expect(wide).not.toContain("More (");
    });

    it("opens visible tabs and the overflow picker by clicking their labels", () => {
        const model = new SettingsEditorModel(
            editableCatalog([
                fixtureExtension("pi-first", "First"),
                fixtureExtension("pi-second", "Second"),
                fixtureExtension("pi-third", "Third"),
                fixtureExtension("pi-last", "Last Extension"),
            ]),
            false,
        );
        const component: Component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        const wide = component.render(120);
        const tabRow = wide.findIndex((line) => line.includes("Second"));
        const click: TuiMouseEvent = {
            type: "click",
            button: "left",
            x: wide[tabRow]?.indexOf("Second") ?? -1,
            y: tabRow,
            screenX: 0,
            screenY: 0,
            width: 120,
            height: 30,
            shift: false,
            alt: false,
            ctrl: false,
        };
        component.handleMouse?.(click);
        expect(model.activeExtensionId).toBe("pi-second");
        const narrow = component.render(48);
        const moreRow = narrow.findIndex((line) => line.includes("More ("));
        component.handleMouse?.({
            ...click,
            x: narrow[moreRow]?.indexOf("More (") ?? -1,
            y: moreRow,
            width: 48,
        });

        expect(component.render(48).join("\n")).toContain("Choose settings tab");
    });

    it("searches descriptions across tabs and opens the matching grouped setting", () => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-first", "First"), contextualCategoryExtension()]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\u0006");
        component.handleInput("active status text");
        const results = component.render(100).join("\n");
        expect(results).toContain("Search scope: Everything");
        expect(results).toContain("Status Bar › Active › Text");
        expect(results).not.toContain("Working");
        component.handleInput("\r");
        expect(model.activeExtensionId).toBe("pi-status-bar");
        expect(component.render(100).join("\n")).toMatch(/▎ Text\s+Working/u);
    });

    it("scopes searches to Pi or an extension without changing the save scope", () => {
        const model = new SettingsEditorModel(
            editableCatalog([
                fixtureExtension("pi-first", "First"),
                fixtureExtension("pi-second", "Second"),
            ]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\u0006");
        component.handleInput("\u0013");
        component.handleInput("second");
        component.handleInput("\r");
        component.handleInput("operating mode");
        const scoped = component.render(100).join("\n");
        expect(scoped).toContain("Search scope: Second");
        expect(scoped).toContain("Second › Mode");
        expect(scoped).not.toContain("First › Mode");
        expect(model.activeScope).toBe("global");
        component.handleInput("\u0013");
        component.handleInput("Pi");
        component.handleInput("\r");
        component.handleInput("\u0015");
        component.handleInput("\u0006");
        component.handleInput("compaction");
        expect(component.render(100).join("\n")).toContain("Pi › Auto-compact");
        expect(component.render(100).join("\n")).not.toContain("Second ›");
    });

    it("returns to the previous field when search is cancelled or cleared", () => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-first", "First")]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\t");
        component.handleInput("\u001b[B");
        const before = component.render(100).join("\n");
        component.handleInput("\u0006");
        component.handleInput("no matching setting");
        expect(component.render(100).join("\n")).toContain("No matching settings");
        component.handleInput("\u001b");
        expect(component.render(100).join("\n")).toBe(before);
        component.handleInput("\u0006");
        component.handleInput("threshold");
        component.handleInput("\u0015");
        expect(component.render(100).join("\n")).toBe(before);
    });

    it("keeps a search result visible near the end of a heavily grouped tab", () => {
        const extension = fixtureExtension("pi-grouped", "Grouped");
        const parsed = parseExtensionSettingsSchema(
            "pi-grouped",
            extension.schema.schemaPath,
            generatedSchemaText(
                "pi-grouped",
                Object.fromEntries(
                    Array.from({ length: 12 }, (_value, index) => [
                        `group${index}`,
                        {
                            type: "object",
                            additionalProperties: false,
                            default: {},
                            properties: {
                                setting: {
                                    type: "boolean",
                                    default: false,
                                    description: "A grouped switch.",
                                },
                            },
                        },
                    ]),
                ),
            ),
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        const model = new SettingsEditorModel(
            editableCatalog([{ ...extension, schema: parsed.schema }]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(100, 30)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\u0006");
        component.handleInput("group11.setting");
        component.handleInput("\r");
        const lines = component.render(100);
        expect(lines.length).toBeLessThanOrEqual(30);
        expect(lines.slice(0, 27).join("\n")).toMatch(/▎ Setting\s+false/u);
        expect(lines.join("\n")).toContain("Group11");
    });

    it("does not search stored values or alter drafts while searching", () => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-first", "First")]),
            false,
        );
        model.setFieldValue(3, "invented-private-value");
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\u0006");
        component.handleInput("invented-private-value");
        expect(component.render(100).join("\n")).toContain("No matching settings");
        expect(model.hasDirtySettings()).toBe(true);
        expect(model.fields()[3]?.value).toBe("invented-private-value");
    });

    it("opens on Pi settings, then switches through extension tabs and autosaves controls", async () => {
        const model = new SettingsEditorModel(
            editableCatalog([
                fixtureExtension("pi-first", "First Extension"),
                fixtureExtension("pi-second", "Second Extension"),
            ]),
            false,
        );
        const tui = new TuiAltScreen(fakeTerminal());
        let saveCount = 0;
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui,
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async (requests) => {
                saveCount += requests.length;

                return requests.map((request) => ({
                    _tag: "SavedLayer" as const,
                    extensionId: request.extensionId,
                    scope: request.scope,
                    content: request.content,
                    changed: true,
                }));
            },
            close() {},
        });

        const initial = component.render(100).join("\n");
        expect(initial).toContain("Settings");
        expect(initial).toContain(" Pi ");
        expect(initial).toContain("Save to:");
        expect(initial).toContain("Auto-compact");
        expect(initial).toContain("Steering mode");
        expect(initial).not.toContain(" Extensions ");
        expect(initial).toContain("Type to search");
        expect(initial).not.toContain("Tab switch • Ctrl+P choose");
        expect(initial).toContain("First Extension");
        expect(initial).toContain("Second Extension");
        expect(model.activeExtensionId).toBe("pi-first");

        component.handleInput("\t");
        expect(model.activeExtensionId).toBe("pi-first");
        const firstExtension = component.render(100).join("\n");
        expect(firstExtension.split("\n")[0]).toMatch(/\(1\/10\)$/);
        expect(firstExtension.split("\n")[0]).toContain(" Pi ");
        expect(firstExtension.split("\n").filter((line) => line.trim() === "(1/10)")).toEqual([]);
        expect(firstExtension).toContain("Global");
        expect(firstExtension).toContain("First Extension");
        expect(firstExtension).toContain("Nested");
        expect(firstExtension).toContain("Enable the fixture.");
        expect(firstExtension).toMatch(/Mode\s+Safe/u);
        expect(firstExtension).not.toContain("[toggle]");
        const fieldLines = firstExtension.split("\n");
        const enabledLine = fieldLines.find((line) => line.startsWith("▎ Enabled"));
        const nestedTitle = fieldLines.find((line) => line.trim() === "Nested");
        const nestedLabelLine = fieldLines.find((line) => line.startsWith("  Label"));
        expect(nestedTitle).toMatch(/^ {2}Nested$/);
        expect(nestedLabelLine).toBeDefined();
        expect(nestedLabelLine).not.toMatch(/^ {4}Label/);
        expect(enabledLine?.indexOf("true")).toBe(nestedLabelLine?.indexOf("default label"));
        const descriptionIndex = firstExtension
            .split("\n")
            .findIndex((line) => line.trimStart().startsWith("Enable the fixture."));
        expect(descriptionIndex).toBeGreaterThan(0);
        expect(firstExtension.split("\n")[descriptionIndex - 1]).toBe("");
        expect(firstExtension.split("\n")[descriptionIndex]).toMatch(/^ {2}Enable the fixture\./);

        component.handleInput("\t");
        expect(model.activeExtensionId).toBe("pi-second");
        component.handleInput(" ");
        await expect.poll(() => model.hasDirtySettings()).toBe(false);
        expect(saveCount).toBe(1);
        expect(component.render(100).join("\n")).not.toContain("Second Extension*");
    });

    it.each([24, 40, 80, 120])("keeps navigation and scope distinct at %s columns", (width) => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-sample", "Sample")]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(width)),
            theme: ansiTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
            header: { layout: "stacked", showHints: true, showFieldCounter: true },
        });
        component.handleInput("\t");
        const lines = component.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        const location = lines.find((line) => line.includes("Sample"));
        const scope = lines.find((line) => line.includes("Save to:"));
        expect(location).toBeDefined();
        expect(scope).toBeDefined();
        expect(location).not.toBe(scope);
        expect(lines.join("\n")).toContain("Global");
        expect(lines.join("\n")).toContain("(1/10)");
    });

    it("lets users choose a compact header and hide secondary header information", () => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-sample", "Sample")]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
            header: { layout: "compact", showHints: false, showFieldCounter: false },
        });
        component.handleInput("\t");
        const first = component.render(120)[0];
        expect(first).toContain("Sample");
        expect(first).toContain("Save to:");
        expect(first).not.toContain("Ctrl+P");
        expect(first).not.toContain("(1/10)");
    });

    it("shows the tab-picker hint in a compact header when field counters are hidden", () => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-sample", "Sample")]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(160)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
            header: { layout: "compact", showHints: true, showFieldCounter: false },
        });
        component.handleInput("\t");

        const first = component.render(160)[0];

        expect(first).toContain("Sample");
        expect(first).toContain("Save to:");
        expect(first).toContain("Ctrl+P choose");
        expect(first).not.toContain("(1/10)");
    });

    it.each([
        { shortcut: "ctrl+shift+k", input: "\u001b[107;6u", hint: "Ctrl+Shift+K choose" },
        { shortcut: "shift+ctrl+k", input: "\u001b[107;6u", hint: "Shift+Ctrl+K choose" },
        { shortcut: "alt+k", input: "\u001bk", hint: "Alt+K choose" },
        { shortcut: "shift+k", input: "K", hint: "Shift+K choose" },
        { shortcut: "return", input: "\r", hint: "Return choose" },
        { shortcut: "esc", input: "\u001b", hint: "Esc choose" },
        { shortcut: "ctrl+f", input: "\u0006", hint: "Ctrl+F choose" },
        { shortcut: "ctrl+s", input: "\u0013", hint: "Ctrl+S choose" },
        { shortcut: "ctrl++", input: "\u001b[43;5u", hint: "Ctrl++ choose" },
        { shortcut: "alt+?", input: "\u001b?", hint: "Alt+? choose" },
        { shortcut: "ctrl+\\", input: "\u001c", hint: "Ctrl+\\ choose" },
        { shortcut: "pageUp", input: "\u001b[5~", hint: "Pageup choose" },
        { shortcut: " CTRL+PAGEDOWN ", input: "\u001b[6;5~", hint: "Ctrl+Pagedown choose" },
    ])("uses the configured picker shortcut and hint ($shortcut)", ({ shortcut, input, hint }) => {
        expect(Value.Check(settingsSchema.properties.tabPickerShortcut, shortcut)).toBe(true);
        const model = new SettingsEditorModel(
            editableCatalog([
                fixtureExtension("pi-first", "First Extension"),
                fixtureExtension("pi-second", "Second Extension"),
            ]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            tabPickerShortcut: shortcut,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        expect(component.render(100).join("\n")).toContain(hint);
        component.handleInput("\u0010");
        expect(component.render(100).join("\n")).not.toContain("Choose settings tab");
        component.handleInput(input);
        expect(component.render(100).join("\n")).toContain("Choose settings tab");
        component.handleInput("second");
        component.handleInput("\r");
        expect(model.activeExtensionId).toBe("pi-second");
    });

    it.each([
        {
            shortcut: "ctrl+f",
            searchInput: "\u0013",
            searchHint: "Search settings… · Search scope: Everything Ctrl+S",
        },
        {
            shortcut: "ctrl+s",
            searchInput: "\u0006",
            searchHint: "Search settings… Ctrl+F · Search scope: Everything",
        },
    ])(
        "keeps search accessible with picker shortcut $shortcut",
        ({ shortcut, searchInput, searchHint }) => {
            const component = new SettingsEditorComponent({
                cwd: "/project",
                model: new SettingsEditorModel(
                    editableCatalog([fixtureExtension("pi-sample")]),
                    false,
                ),
                piSettings: fakePiSettingsPane(),
                tui: new TUI(fakeTerminal()),
                theme: plainTheme,
                keybindings: defaultKeys,
                tabPickerShortcut: shortcut,
                save: async () => [],
                close() {},
            });
            component.handleInput("\t");
            expect(
                component
                    .render(100)
                    .find((line) => line.startsWith("Search settings"))
                    ?.trimEnd(),
            ).toBe(searchHint);

            component.handleInput(searchInput);
            expect(component.render(100).join("\n")).toContain("Type to search");
            expect(component.render(100).join("\n")).not.toContain("Choose settings tab");
        },
    );

    it("rejects malformed picker shortcuts at settings load and before creating save requests", () => {
        const id = "pi-settings-ui";
        const parsed = parseExtensionSettingsSchema(
            id,
            `/agent/${id}.schema.json`,
            JSON.stringify({
                ...settingsSchema,
                $schema: "https://json-schema.org/draft/2020-12/schema",
                $id: `urn:fixture:${id}`,
                title: "Pi Settings UI settings",
                description: "Settings for Pi Settings UI.",
                required: [],
                properties: {
                    ...settingsSchema.properties,
                    $schema: {
                        type: "string",
                        default: `./schemas/${id}.schema.json`,
                        description: "JSON Schema used by editors for this settings file.",
                    },
                },
            }),
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        const model = new SettingsEditorModel(
            editableCatalog([{ ...fixtureExtension(id), schema: parsed.schema }]),
            false,
        );
        const fieldIndex = model
            .fields()
            .findIndex((field) => field.path.join(".") === "tabPickerShortcut");
        expect(fieldIndex).toBeGreaterThanOrEqual(0);

        for (const shortcut of [
            "ctrl+banana",
            "ctrl+ctrl+p",
            "ctrl+shift+ctrl+p",
            "CTRL+ctrl+p",
            "ctrl+",
            "ctrl+++",
            "meta+p",
            "p extra",
            "",
            "   ",
        ]) {
            expect
                .soft(Value.Check(settingsSchema.properties.tabPickerShortcut, shortcut), shortcut)
                .toBe(false);

            expect
                .soft(
                    parseSettingsDocument(
                        parsed.schema,
                        JSON.stringify({ tabPickerShortcut: shortcut }),
                    )._tag,
                    shortcut,
                )
                .toBe("InvalidDocument");

            expect
                .soft(model.setFieldValue(fieldIndex, shortcut)._tag, shortcut)
                .toBe("EditRejected");
        }

        expect(model.saveRequests()).toEqual([]);
        expect(model.hasDirtySettings()).toBe(false);

        expect(
            parseSettingsDocument(
                parsed.schema,
                JSON.stringify({ tabPickerShortcut: "alt+pageUp" }),
            )._tag,
        ).toBe("ParsedDocument");

        expect(model.setFieldValue(fieldIndex, "alt+pageUp")._tag).toBe("EditApplied");
        expect(model.saveRequests()).toHaveLength(1);
        expect(model.saveRequests()[0]?.content).toContain('"tabPickerShortcut": "alt+pageUp"');
    });

    it.each([11, 12])("keeps a selected grouped field visible at %s terminal rows", (rows) => {
        const id = "pi-grouped-amount";
        const parsed = parseExtensionSettingsSchema(
            id,
            `/agent/${id}.schema.json`,
            generatedSchemaText(id, {
                group: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        amount: { type: "number", default: 5, description: "Amount to use." },
                    },
                },
            }),
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        const component = new SettingsEditorComponent({
            cwd: "/project",
            model: new SettingsEditorModel(
                editableCatalog([{ ...fixtureExtension(id), schema: parsed.schema }]),
                false,
            ),
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(100, rows)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\t");
        const lines = component.render(100);
        expect(lines.join("\n")).toMatch(/^▎ Amount\b/mu);
        expect(lines.length).toBeLessThanOrEqual(rows);
    });

    it("does not treat legacy Shift+letter input as an unmodified picker shortcut", () => {
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model: new SettingsEditorModel(editableCatalog([fixtureExtension("pi-sample")]), false),
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            tabPickerShortcut: "k",
            save: async () => [],
            close() {},
        });
        component.handleInput("\t");
        component.handleInput("K");
        expect(component.render(100).join("\n")).not.toContain("Choose settings tab");
        component.handleInput("k");
        expect(component.render(100).join("\n")).toContain("Choose settings tab");
    });

    it("keeps inline validation visible when the description fills a short viewport", () => {
        const id = "pi-number-input";
        const parsed = parseExtensionSettingsSchema(
            id,
            `/agent/${id}.schema.json`,
            generatedSchemaText(id, {
                count: {
                    type: "integer",
                    default: 5,
                    description: "A detailed explanation of this value. ".repeat(40),
                },
            }),
        );
        if (parsed._tag === "InvalidSchema") throw new Error(parsed.message);

        const model = new SettingsEditorModel(
            editableCatalog([{ ...fixtureExtension(id), schema: parsed.schema }]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(40, 18)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });
        component.handleInput("\t");
        component.handleInput("\r");
        component.handleInput("\u0015");
        component.handleInput("not-number");
        component.handleInput("\r");
        const lines = component.render(40);
        expect(lines.join("\n")).toContain("Enter a finite number.");
        expect(lines.length).toBeLessThanOrEqual(18);
        expect(model.fields()[0]?.value).toBe(5);
    });

    it("offers every settings tab through a searchable compact picker", () => {
        const model = new SettingsEditorModel(
            editableCatalog([
                fixtureExtension("pi-first", "Pi First Extension"),
                fixtureExtension("pi-second", "Second Extension"),
                fixtureExtension("pi-third", "Third Extension"),
            ]),
            false,
        );
        const tui = new TUI(fakeTerminal());
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui,
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\u0010");
        const picker = component.render(100).join("\n");
        expect(picker).toContain("Choose settings tab");
        expect(picker.split("\n").find((line) => line.startsWith("›"))).toMatch(/\(1\/4\)$/);
        expect(picker.split("\n").filter((line) => line.trim() === "(1/4)")).toEqual([]);
        expect(picker).toContain("First Extension");
        expect(picker).not.toContain("Pi First Extension");
        component.handleInput("third");
        const filtered = component.render(100).join("\n").split("Choose settings tab")[1] ?? "";
        expect(filtered).toContain("Third Extension");
        expect(filtered).not.toContain("First Extension");
        component.handleInput("\r");
        expect(model.activeExtensionId).toBe("pi-third");
        expect(component.render(100).join("\n")).toContain("Third Extension");
    });

    it("edits numbers inline and keeps editor help concise", () => {
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-first", "First Extension")]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        component.handleInput("\u001b[B");
        component.handleInput("\u001b[B");
        component.handleInput("\r");
        const rendered = component.render(100).join("\n");
        expect(rendered).toContain("Threshold");
        expect(rendered).toContain("Nested");
        expect(rendered).toContain("Enter apply • Esc cancel");
        expect(rendered).not.toContain("Shift+Enter newline");

        component.handleInput("\u001b");
        const cancelledLines = component.render(100);
        const statusIndex = cancelledLines.findIndex((line) => line.includes("Edit cancelled."));
        const helpIndex = cancelledLines.findIndex((line) => line.includes("Tab switch"));
        expect(statusIndex).toBeGreaterThan(-1);
        expect(helpIndex).toBeGreaterThan(statusIndex);
        expect(cancelledLines.at(-1)).toMatch(/^─+$/u);
    });

    it("uses the full editor only for multiline text controls", () => {
        const model = new SettingsEditorModel(editableCatalog([textControlExtension()]), false);
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        component.handleInput("\u001b[B");
        component.handleInput("\r");
        const rendered = component.render(100).join("\n");
        expect(rendered.split("\n")).toContain("  prompt");
        expect(rendered).toContain("First line");
        expect(rendered).toContain("Second line");
        expect(rendered).not.toContain("Name  short value");
        expect(rendered).toContain("Enter apply • Esc cancel");
    });

    it("renders searchable choices, sliders, path completion, colors, and comboboxes", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
        try {
            mkdirSync(join(cwd, "alpha"));
            const model = new SettingsEditorModel(
                editableCatalog([hintedControlExtension()]),
                false,
            );
            let saveCount = 0;
            const component = new SettingsEditorComponent({
                cwd,
                model,
                piSettings: fakePiSettingsPane(),
                tui: new TUI(fakeTerminal()),
                theme: plainTheme,
                keybindings: defaultKeys,
                save: async (requests) => {
                    saveCount += requests.length;

                    return requests.map((request) => ({
                        _tag: "SavedLayer" as const,
                        extensionId: request.extensionId,
                        scope: request.scope,
                        content: request.content,
                        changed: true,
                    }));
                },
                close() {},
            });

            component.handleInput("\t");
            expect(component.render(100).join("\n")).toContain("5 [████░░░░]");

            component.handleInput("\r");
            expect(component.render(100).join("\n")).toContain("Choose theme");
            component.handleInput("\r");
            expect(component.render(100).join("\n")).toContain("No change.");
            expect(saveCount).toBe(0);

            component.handleInput("\r");
            component.handleInput("seven");
            expect(component.render(100).join("\n")).toContain("Seven");
            component.handleInput("\r");
            await expect.poll(() => model.hasDirtySettings()).toBe(false);
            expect(component.render(100).join("\n")).toMatch(/Theme\s+Seven/u);

            component.handleInput("\u001b[B");
            component.handleInput("\u001b[C");
            await expect.poll(() => model.hasDirtySettings()).toBe(false);
            expect(component.render(100).join("\n")).toContain("6 [");

            component.handleInput("\u001b[B");
            component.handleInput("\r");
            component.handleInput("\t");
            const completedPath = component.render(100).join("\n");
            expect(stripTerminalSequences(completedPath)).toContain("alpha/");

            expect(completedPath).toContain("Path completed.");
            component.handleInput("\u001b");
            component.handleInput("\u001b[B");
            expect(component.render(100).join("\n")).toContain("\u001b[48;2;18;52;86m");

            component.handleInput("\u001b[B");
            component.handleInput("\r");
            expect(component.render(100).join("\n")).toContain("Choose border");
            component.handleInput("customColor");
            expect(component.render(100).join("\n")).toContain("Use “customColor”");
            component.handleInput("\r");
            await expect.poll(() => model.hasDirtySettings()).toBe(false);
            expect(component.render(100).join("\n")).toContain("customColor");
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it("renders grouped string lists as readable nested entries", () => {
        const model = new SettingsEditorModel(editableCatalog([groupedListExtension()]), false);
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(80, 24)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        const rendered = component.render(100).join("\n");
        expect(rendered).toContain("2 providers · 3 models");
        expect(rendered).toContain("    openai-codex");
        expect(rendered).toContain("      gpt-5.6*");
        expect(rendered).toContain("    openrouter");
        expect(rendered).not.toContain("2 items");
    });

    it("renders choice lists, record lists, maps, nulls, and long labels clearly", () => {
        const model = new SettingsEditorModel(
            editableCatalog([structuredPresentationExtension()]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(80, 24)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        const slots = component.render(80).join("\n");
        expect(slots).toContain("Slots");
        expect(slots).toContain("2 entries");
        expect(slots).toContain("    cwd");
        expect(slots).toContain("    branch");

        component.handleInput("\u001b[B");
        const aliases = component.render(80).join("\n");
        expect(aliases).toContain("Aliases");
        expect(aliases).toContain("1 entry");
        expect(aliases).toContain("fireworks/accounts/fireworks/routers/kimi-k2p6-turbo");
        expect(aliases).toContain("Alias  kimi-k2.6-turbo");
        expect(aliases).toContain("Name   Kimi K2.6 Turbo");
        const aliasLine = aliases.split("\n").find((line) => line.includes("kimi-k2.6-turbo"));
        const nameLine = aliases.split("\n").find((line) => line.includes("Kimi K2.6 Turbo"));
        expect(aliasLine?.indexOf("kimi-k2.6-turbo")).toBe(nameLine?.indexOf("Kimi K2.6 Turbo"));

        component.handleInput("\u001b[B");
        const modes = component.render(80).join("\n");
        expect(modes).toContain("Modes");
        expect(modes).toContain("2 entries");
        expect(modes).toContain("    luna");
        expect(modes).toMatch(/Provider\s+openai-codex/u);
        expect(modes).toMatch(/Model ID\s+gpt-5\.6-luna/u);
        const providerLine = modes.split("\n").find((line) => line.includes("Provider"));
        const thinkingLine = modes.split("\n").find((line) => line.includes("Thinking level"));
        expect(providerLine?.indexOf("openai-codex")).toBe(thinkingLine?.indexOf("xhigh"));

        component.handleInput("\u001b[B");
        expect(component.render(80).join("\n")).toMatch(/Paste collapse expand key\s+<none>/u);

        component.handleInput("\u001b[B");
        const longLabel = component.render(80).join("\n");
        expect(longLabel).toContain("Restore content after autocomplete cancel");
        expect(longLabel).not.toContain("Restore content after autocomplete…");
    });

    it("edits lists, records, and maps through schema-shaped nested controls", () => {
        const model = new SettingsEditorModel(
            editableCatalog([structuredPresentationExtension()]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal(80, 24)),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        component.handleInput("\r");
        const slots = component.render(80).join("\n");
        expect(slots).toContain("Slots");
        expect(slots).toContain("Entry 1");
        expect(slots).toContain("+ Add entry");
        expect(slots).toContain("Enter change • Del remove • Esc back");
        expect(slots).not.toContain('[\n  "cwd"');

        component.handleInput("\r");
        const slotPicker = component.render(80).join("\n");
        expect(slotPicker).toContain("Choose entry");
        expect(slotPicker).toContain("CWD");
        expect(slotPicker).toContain("Branch");
        component.handleInput("custom.slot");
        expect(component.render(80).join("\n")).toContain("Use “custom.slot”");
        component.handleInput("\u001b");
        component.handleInput("\u001b");
        component.handleInput("\u001b[B");
        component.handleInput("\r");
        const aliases = component.render(80).join("\n");
        expect(aliases).toContain("Aliases");
        expect(aliases).toContain("fireworks/accounts/fireworks/routers/kimi-k2p6-turbo");
        expect(aliases).toContain("Provider");
        expect(aliases).toContain("Model");
        expect(aliases).toContain("Alias");

        component.handleInput("\u001b[B");
        component.handleInput("\r");
        const inlineProvider = component.render(80).join("\n");
        expect(inlineProvider).toContain("Provider");
        expect(inlineProvider).toContain("Model");
        expect(inlineProvider).toContain("+ Add entry");
        expect(inlineProvider).toContain("Enter apply • Esc cancel");

        component.handleInput("\u001b");
        component.handleInput("\u001b");
        component.handleInput("\u001b[B");
        component.handleInput("\r");
        const modes = component.render(80).join("\n");
        expect(modes).toContain("Modes");
        expect(modes).toContain("luna");
        expect(modes).toContain("Provider");
        expect(modes).toContain("Model ID");
        expect(modes).toContain("+ Add entry");
    });

    it("removes a redundant extension root from nested category headings", () => {
        const model = new SettingsEditorModel(
            editableCatalog([contextualCategoryExtension()]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui: new TUI(fakeTerminal()),
            theme: plainTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        component.handleInput("\t");
        const rendered = component.render(80).join("\n");
        expect(rendered.split("\n")).toContain("  Active");
        expect(rendered).not.toContain("Status bar › Active");
    });
});

describe.each([
    { name: "main screen", createTui: (terminal: VirtualTerminal) => new TUI(terminal, true) },
    {
        name: "alternate screen",
        createTui: (terminal: VirtualTerminal) => new TuiAltScreen(terminal, true),
    },
] as const)("settings TUI terminal seam on $name", ({ createTui }) => {
    it("owns input, focus, resizing, cursor state, and complete terminal rows", async () => {
        const terminal = new VirtualTerminal(68, 18);
        const tui = createTui(terminal);
        const model = new SettingsEditorModel(
            editableCatalog([fixtureExtension("pi-first", "First Extension")]),
            false,
        );
        const component = new SettingsEditorComponent({
            cwd: "/project",
            model,
            piSettings: fakePiSettingsPane(),
            tui,
            theme: ansiTheme,
            keybindings: defaultKeys,
            save: async () => [],
            close() {},
        });

        tui.addChild(component);
        tui.setFocus(component);
        tui.start();

        try {
            tui.renderNow(true);
            await terminal.settle();
            expect(component.focused).toBe(true);
            expect(terminal.screenText()).toContain("Settings");
            const expandedRows = terminal.screenRows();
            const visibleControlRows = new Set(
                ["Auto-compact", "Steering mode"].map((label) => {
                    const row = expandedRows.findIndex((screenRow) => screenRow.includes(label));
                    expect(row).toBeGreaterThanOrEqual(0);
                    return row;
                }),
            );
            const structuralRows = new Set<number>();
            expandedRows.forEach((row, index) => {
                const isBorder = row.length > 0 && row.split("─").join("").length === 0;
                if (isBorder || row.includes("Settings")) structuralRows.add(index);
            });
            const allowedStyledMarginRows = new Set([...structuralRows, ...visibleControlRows]);
            const expandedStyledMarginCells = terminal.styledRightMarginCells();
            expect(
                expandedStyledMarginCells.filter(({ row }) => !allowedStyledMarginRows.has(row)),
            ).toEqual([]);

            terminal.feed("\u0010");
            tui.renderNow();
            await terminal.settle();
            expect(terminal.screenText()).toContain("Choose settings tab");

            terminal.resize(52, 12);
            tui.renderNow();
            await terminal.settle();
            expect(terminal.wrappedRows()).toEqual([]);
            expect(terminal.screenRows().every((row) => row.length <= terminal.columns)).toBe(true);

            terminal.feed("\u001b");
            tui.renderNow();
            await terminal.settle();
            expect(terminal.screenText()).not.toContain("Choose settings tab");

            terminal.feed("\t");
            terminal.feed("\u001b[B");
            terminal.feed("\u001b[B");
            const beforeInlineEditor = terminal.rawOutput().length;
            terminal.feed("\r");
            tui.renderNow(true);
            await terminal.settle();

            const inlineEditorOutput = terminal.rawOutput().slice(beforeInlineEditor);
            expect(terminal.screenText()).toContain("Threshold");
            expect(inlineEditorOutput).toContain("\u001b[?25h");
            const nonemptyRows = terminal.screenRows().filter((row) => row.length > 0);
            const resetCount = inlineEditorOutput.split("\u001b[0m").length - 1;
            expect(resetCount).toBeGreaterThanOrEqual(nonemptyRows.length);

            terminal.resize(31, 9);
            tui.renderNow();
            await terminal.settle();
            const screenRows = terminal.screenRows();
            const screenText = terminal.screenText();
            expect(screenText).toContain("Threshold");
            expect(screenText).not.toContain("Choose settings tab");
            const styledMarginCells = terminal.styledRightMarginCells();
            const thresholdRow = screenRows.findIndex((row) => row.includes("Threshold"));
            expect(thresholdRow).toBeGreaterThanOrEqual(0);
            expect(
                styledMarginCells.filter(({ row }) => row < 0 || row >= screenRows.length),
            ).toEqual([]);

            expect(styledMarginCells.filter(({ row }) => screenRows[row]?.trim() === "")).toEqual(
                [],
            );

            expect(
                styledMarginCells.filter(({ column }) => column < 0 || column >= terminal.columns),
            ).toEqual([]);

            expect(terminal.wrappedRows()).toEqual([]);
            expect(terminal.screenRows().every((row) => row.length <= terminal.columns)).toBe(true);

            const beforeCancel = terminal.rawOutput().length;
            terminal.feed("\u001b");
            tui.renderNow();
            await terminal.settle();
            expect(terminal.rawOutput().slice(beforeCancel)).toContain("\u001b[?25l");
        } finally {
            tui.stop();
            await terminal.settle();
            terminal.dispose();
        }
    });
});
