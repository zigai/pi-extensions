import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { loadUiTweaksSettings, resolveUiTweaksConfig } from "../src/settings.ts";

test("loadUiTweaksSettings scaffolds missing global config and schema", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-ui-tweaks-agent-"));
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-ui-tweaks-cwd-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
        const configPath = path.join(agentDir, "extension-settings", "pi-ui-tweaks.json");
        const schemaPath = path.join(
            agentDir,
            "extension-settings",
            "schemas",
            "pi-ui-tweaks.schema.json",
        );
        const loaded = loadUiTweaksSettings(cwd, false);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.config.autocompleteAboveInput, true);
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
            $schema: "./schemas/pi-ui-tweaks.schema.json",
            enabled: true,
            autocompleteAboveInput: true,
            bashExecPromptSpacing: true,
            anchorInputToBottom: false,
            compactModelSelector: true,
            hideAutocompleteScrollInfo: true,
            hideModelChangeStatus: true,
            hideModelProviderHint: true,
            hideSlashCommandSourceTags: true,
            highlightSelectedModelProvider: true,
            inputPromptPrefix: "> ",
            neutralBorderColor: true,
            pasteCollapseCharThreshold: 1000,
            pasteCollapseEnabled: true,
            pasteCollapseExpandKey: null,
            pasteCollapseLineThreshold: 10,
            pasteCollapseUseToolExpandKey: true,
            preserveCompactionHistory: false,
            restoreContentAfterAutocompleteClose: true,
            refreshTmuxHyperlinks: true,
            selectedOptionPrefix: "→ ",
        });
        assert.match(await readFile(schemaPath, "utf8"), /Pi UI Tweaks settings/);
        const customConfig = JSON.stringify({ enabled: false, selectedOptionPrefix: ">> " });
        await writeFile(configPath, customConfig, "utf8");
        await writeFile(schemaPath, "stale schema", "utf8");
        const loadedAgain = loadUiTweaksSettings(cwd, false);
        assert.equal(loadedAgain.config.autocompleteAboveInput, false);
        assert.equal(await readFile(configPath, "utf8"), customConfig);
        assert.match(await readFile(schemaPath, "utf8"), /Pi UI Tweaks settings/);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
        await rm(cwd, { recursive: true, force: true });

        if (originalAgentDir === undefined) {
            delete process.env.PI_CODING_AGENT_DIR;
        } else {
            process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        }
    }
});

test("ui tweaks settings default to enabled tweaks", () => {
    const loaded = resolveUiTweaksConfig([]);
    assert.equal(loaded.config.autocompleteAboveInput, true);
    assert.equal(loaded.config.anchorInputToBottom, false);
    assert.equal(loaded.config.bashExecPromptSpacing, true);
    assert.equal(loaded.config.compactModelSelector, true);
    assert.equal(loaded.config.hideAutocompleteScrollInfo, true);
    assert.equal(loaded.config.hideModelChangeStatus, true);
    assert.equal(loaded.config.hideModelProviderHint, true);
    assert.equal(loaded.config.hideSlashCommandSourceTags, true);
    assert.equal(loaded.config.highlightSelectedModelProvider, true);
    assert.equal(loaded.config.inputPromptPrefix, "> ");
    assert.equal(loaded.config.neutralBorderColor, true);
    assert.equal(loaded.config.pasteCollapseCharThreshold, 1000);
    assert.equal(loaded.config.pasteCollapseEnabled, true);
    assert.equal(loaded.config.pasteCollapseExpandKey, null);
    assert.equal(loaded.config.pasteCollapseLineThreshold, 10);
    assert.equal(loaded.config.pasteCollapseUseToolExpandKey, true);
    assert.equal(loaded.config.preserveCompactionHistory, false);
    assert.equal(loaded.config.restoreContentAfterAutocompleteClose, true);
    assert.equal(loaded.config.refreshTmuxHyperlinks, true);
    assert.equal(loaded.config.selectedOptionPrefix, "→ ");
    assert.deepEqual(loaded.errors, []);
});

test("ui tweaks settings merge sources in precedence order", () => {
    const loaded = resolveUiTweaksConfig([
        {
            label: "global",
            settings: {
                autocompleteAboveInput: false,
                anchorInputToBottom: true,
                bashExecPromptSpacing: false,
                compactModelSelector: false,
                hideAutocompleteScrollInfo: false,
                hideModelChangeStatus: false,
                hideModelProviderHint: false,
                hideSlashCommandSourceTags: true,
                highlightSelectedModelProvider: false,
                inputPromptPrefix: "> ",
                neutralBorderColor: false,
                pasteCollapseCharThreshold: 2000,
                pasteCollapseEnabled: false,
                pasteCollapseExpandKey: "ctrl+shift+o",
                pasteCollapseLineThreshold: 20,
                pasteCollapseUseToolExpandKey: false,
                preserveCompactionHistory: false,
                restoreContentAfterAutocompleteClose: false,
                selectedOptionPrefix: "❯ ",
            },
        },
        {
            label: "project",
            settings: {
                autocompleteAboveInput: true,
                anchorInputToBottom: false,
                bashExecPromptSpacing: true,
                hideAutocompleteScrollInfo: true,
                hideModelChangeStatus: true,
                hideModelProviderHint: true,
                hideSlashCommandSourceTags: false,
                highlightSelectedModelProvider: true,
                inputPromptPrefix: "❯",
                pasteCollapseCharThreshold: 500,
                pasteCollapseEnabled: true,
                pasteCollapseExpandKey: null,
                pasteCollapseLineThreshold: 5,
                pasteCollapseUseToolExpandKey: true,
                preserveCompactionHistory: true,
                restoreContentAfterAutocompleteClose: true,
                selectedOptionPrefix: "▌",
            },
        },
    ]);

    assert.equal(loaded.config.autocompleteAboveInput, true);
    assert.equal(loaded.config.anchorInputToBottom, false);
    assert.equal(loaded.config.bashExecPromptSpacing, true);
    assert.equal(loaded.config.compactModelSelector, false);
    assert.equal(loaded.config.hideAutocompleteScrollInfo, true);
    assert.equal(loaded.config.hideModelChangeStatus, true);
    assert.equal(loaded.config.hideModelProviderHint, true);
    assert.equal(loaded.config.hideSlashCommandSourceTags, false);
    assert.equal(loaded.config.highlightSelectedModelProvider, true);
    assert.equal(loaded.config.inputPromptPrefix, "❯");
    assert.equal(loaded.config.neutralBorderColor, false);
    assert.equal(loaded.config.pasteCollapseCharThreshold, 500);
    assert.equal(loaded.config.pasteCollapseEnabled, true);
    assert.equal(loaded.config.pasteCollapseExpandKey, null);
    assert.equal(loaded.config.pasteCollapseLineThreshold, 5);
    assert.equal(loaded.config.pasteCollapseUseToolExpandKey, true);
    assert.equal(loaded.config.preserveCompactionHistory, true);
    assert.equal(loaded.config.restoreContentAfterAutocompleteClose, true);
    assert.equal(loaded.config.selectedOptionPrefix, "▌");
});

test("ui tweaks enabled false disables every tweak", () => {
    const loaded = resolveUiTweaksConfig([
        {
            label: "global",
            settings: {
                enabled: false,
                hideModelProviderHint: true,
                inputPromptPrefix: "❯",
                selectedOptionPrefix: "▌",
            },
        },
    ]);

    assert.equal(loaded.config.autocompleteAboveInput, false);
    assert.equal(loaded.config.anchorInputToBottom, false);
    assert.equal(loaded.config.bashExecPromptSpacing, false);
    assert.equal(loaded.config.compactModelSelector, false);
    assert.equal(loaded.config.hideAutocompleteScrollInfo, false);
    assert.equal(loaded.config.hideModelChangeStatus, false);
    assert.equal(loaded.config.hideModelProviderHint, false);
    assert.equal(loaded.config.hideSlashCommandSourceTags, false);
    assert.equal(loaded.config.highlightSelectedModelProvider, false);
    assert.equal(loaded.config.inputPromptPrefix, "> ");
    assert.equal(loaded.config.neutralBorderColor, false);
    assert.equal(loaded.config.pasteCollapseCharThreshold, 1000);
    assert.equal(loaded.config.pasteCollapseEnabled, false);
    assert.equal(loaded.config.pasteCollapseExpandKey, null);
    assert.equal(loaded.config.pasteCollapseLineThreshold, 10);
    assert.equal(loaded.config.pasteCollapseUseToolExpandKey, false);
    assert.equal(loaded.config.preserveCompactionHistory, false);
    assert.equal(loaded.config.restoreContentAfterAutocompleteClose, false);
    assert.equal(loaded.config.refreshTmuxHyperlinks, false);
    assert.equal(loaded.config.selectedOptionPrefix, "→ ");
});

test("ui tweaks settings report invalid custom values", () => {
    const loaded = resolveUiTweaksConfig([
        {
            label: "global",
            settings: {
                autocompleteAboveInput: "nah",
                anchorInputToBottom: "nah",
                bashExecPromptSpacing: "nah",
                compactModelSelector: "nah",
                hideAutocompleteScrollInfo: "nah",
                hideModelChangeStatus: "nah",
                hideModelProviderHint: "no",
                hideSlashCommandSourceTags: "yes",
                highlightSelectedModelProvider: "nah",
                inputPromptPrefix: "",
                neutralBorderColor: "nope",
                restoreContentAfterAutocompleteClose: "nah",
                selectedOptionPrefix: "",
            },
        },
    ]);

    assert.equal(loaded.config.autocompleteAboveInput, true);
    assert.equal(loaded.config.anchorInputToBottom, false);
    assert.equal(loaded.config.bashExecPromptSpacing, true);
    assert.equal(loaded.config.compactModelSelector, true);
    assert.equal(loaded.config.hideAutocompleteScrollInfo, true);
    assert.equal(loaded.config.hideModelChangeStatus, true);
    assert.equal(loaded.config.hideModelProviderHint, true);
    assert.equal(loaded.config.hideSlashCommandSourceTags, true);
    assert.equal(loaded.config.highlightSelectedModelProvider, true);
    assert.equal(loaded.config.inputPromptPrefix, "> ");
    assert.equal(loaded.config.neutralBorderColor, true);
    assert.equal(loaded.config.pasteCollapseCharThreshold, 1000);
    assert.equal(loaded.config.pasteCollapseEnabled, true);
    assert.equal(loaded.config.pasteCollapseExpandKey, null);
    assert.equal(loaded.config.pasteCollapseLineThreshold, 10);
    assert.equal(loaded.config.pasteCollapseUseToolExpandKey, true);
    assert.equal(loaded.config.restoreContentAfterAutocompleteClose, true);
    assert.equal(loaded.config.selectedOptionPrefix, "→ ");
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global is invalid:/);
    assert.match(loaded.errors[0] ?? "", /autocompleteAboveInput/);
    assert.match(loaded.errors[0] ?? "", /anchorInputToBottom/);
    assert.match(loaded.errors[0] ?? "", /bashExecPromptSpacing/);
    assert.match(loaded.errors[0] ?? "", /hideAutocompleteScrollInfo/);
});

test("ui tweaks settings report invalid paste collapse values", () => {
    const loaded = resolveUiTweaksConfig([
        {
            label: "global",
            settings: {
                pasteCollapseCharThreshold: -1,
                pasteCollapseEnabled: "nah",
                pasteCollapseExpandKey: "",
                pasteCollapseLineThreshold: -1,
                pasteCollapseUseToolExpandKey: "nah",
            },
        },
    ]);

    assert.equal(loaded.config.pasteCollapseCharThreshold, 1000);
    assert.equal(loaded.config.pasteCollapseEnabled, true);
    assert.equal(loaded.config.pasteCollapseExpandKey, null);
    assert.equal(loaded.config.pasteCollapseLineThreshold, 10);
    assert.equal(loaded.config.pasteCollapseUseToolExpandKey, true);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global is invalid:/);
    assert.match(loaded.errors[0] ?? "", /pasteCollapseCharThreshold/);
    assert.match(loaded.errors[0] ?? "", /pasteCollapseEnabled/);
    assert.match(loaded.errors[0] ?? "", /pasteCollapseExpandKey/);
    assert.match(loaded.errors[0] ?? "", /pasteCollapseLineThreshold/);
    assert.match(loaded.errors[0] ?? "", /pasteCollapseUseToolExpandKey/);
});

test("ui tweaks settings reject invalid paste collapse expand key syntax", () => {
    const loaded = resolveUiTweaksConfig([
        {
            label: "global",
            settings: {
                pasteCollapseExpandKey: "ctr+e",
            },
        },
    ]);

    assert.equal(loaded.config.pasteCollapseExpandKey, null);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global is invalid:/);
    assert.match(loaded.errors[0] ?? "", /pasteCollapseExpandKey/);
});

test("ui tweaks settings reject unknown config keys", () => {
    const loaded = resolveUiTweaksConfig([
        {
            label: "global",
            settings: {
                hideModelProviderHnit: false,
            },
        },
    ]);

    assert.equal(loaded.config.hideModelProviderHint, true);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0] ?? "", /global is invalid:/);
    assert.match(loaded.errors[0] ?? "", /additional properties/);
});
