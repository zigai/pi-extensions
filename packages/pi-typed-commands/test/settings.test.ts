import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getPiTypedCommandsSettings } from "../src/settings.js";

const ORIGINAL_ENV = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_TYPED_COMMANDS: process.env.PI_TYPED_COMMANDS,
    PI_TYPED_COMMANDS_UX: process.env.PI_TYPED_COMMANDS_UX,
    PI_TYPED_COMMANDS_UX_SHOW_TYPES: process.env.PI_TYPED_COMMANDS_UX_SHOW_TYPES,
};

function restoreEnvValue(name: keyof typeof ORIGINAL_ENV): void {
    const value = ORIGINAL_ENV[name];
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

function createSettingsWorkspace(): { agentDir: string; cwd: string } {
    const root = mkdtempSync(join(tmpdir(), "pi-typed-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return { agentDir, cwd };
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value));
}

afterEach(() => {
    restoreEnvValue("PI_CODING_AGENT_DIR");
    restoreEnvValue("PI_TYPED_COMMANDS");
    restoreEnvValue("PI_TYPED_COMMANDS_UX");
    restoreEnvValue("PI_TYPED_COMMANDS_UX_SHOW_TYPES");
});

void describe("getPiTypedCommandsSettings", () => {
    void it("applies project settings over agent settings", () => {
        const { agentDir, cwd } = createSettingsWorkspace();
        writeJson(join(agentDir, "settings.json"), {
            piTypedCommands: {
                enabled: false,
                uxShowTypes: true,
            },
        });
        writeJson(join(cwd, ".pi", "settings.json"), {
            piTypedCommands: {
                enabled: true,
                uxEnabled: false,
            },
        });

        assert.deepEqual(getPiTypedCommandsSettings(cwd), {
            enabled: true,
            uxEnabled: false,
            uxShowTypes: true,
        });
    });

    void it("lets environment variables override files and forces UX off when disabled", () => {
        const { agentDir, cwd } = createSettingsWorkspace();
        writeJson(join(agentDir, "settings.json"), {
            piTypedCommands: {
                enabled: true,
                uxEnabled: true,
                uxShowTypes: false,
            },
        });
        process.env.PI_TYPED_COMMANDS = "0";
        process.env.PI_TYPED_COMMANDS_UX = "1";
        process.env.PI_TYPED_COMMANDS_UX_SHOW_TYPES = "1";

        assert.deepEqual(getPiTypedCommandsSettings(cwd), {
            enabled: false,
            uxEnabled: false,
            uxShowTypes: true,
        });
    });

    void it("ignores invalid JSON settings files", () => {
        const { cwd } = createSettingsWorkspace();
        writeFileSync(join(cwd, ".pi", "settings.json"), "not json");

        assert.deepEqual(getPiTypedCommandsSettings(cwd), {
            enabled: true,
            uxEnabled: true,
            uxShowTypes: false,
        });
    });
});
