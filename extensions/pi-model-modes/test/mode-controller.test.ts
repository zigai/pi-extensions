import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ExtensionRunner,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
    discoverAndLoadExtensions,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";

import { ModeController } from "../src/mode-controller.ts";
import { ModePicker } from "../src/mode-picker.ts";

function createController(): ModeController {
    return new ModeController({
        getThinkingLevel: () => "medium",
        setThinkingLevel: () => {},
        setModel: async () => true,
    });
}

test("mode controllers own independent runtime state", () => {
    const first = createController();
    const second = createController();

    first.setEditorRenderRequest(() => {});
    first.setUseThinkingBorderColors(true);
    first.setShowThinkingLevelStatus(true);
    assert.equal(first.currentMode, "default");
    assert.equal(second.currentMode, "default");
    assert.notEqual(first.modes, second.modes);
    assert.equal(first.thinkingBorderColorsEnabled, true);
    assert.equal(second.thinkingBorderColorsEnabled, false);
    assert.equal(first.thinkingLevelStatusEnabled, true);
    assert.equal(second.thinkingLevelStatusEnabled, false);
});

test.each(["__proto__", "constructor", "prototype"])(
    "renaming a mode to %s is rejected without losing the saved mode",
    async (name) => {
        const root = await mkdtemp(join(tmpdir(), "pi-model-modes-rename-"));
        vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
        const configPath = join(root, "agent", "extension-settings", "pi-model-modes.json");
        const original = JSON.stringify({
            currentMode: "review",
            modes: { review: { provider: "local", modelId: "small" } },
        });
        try {
            await mkdir(join(configPath, ".."), { recursive: true });
            await writeFile(configPath, original);
            const loaded = await discoverAndLoadExtensions([], root, join(root, "agent"));
            const models = await ModelRuntime.create({
                authPath: join(root, "auth.json"),
                modelsPath: null,
                refreshOnCreate: false,
            });
            const runner = new ExtensionRunner(
                loaded.extensions,
                loaded.runtime,
                root,
                SessionManager.inMemory(root),
                new ModelRegistry(models),
            );
            const choices = ["Configure modes…", "review", "Change name"];
            const inputs = [name];
            const notifications: string[] = [];
            runner.setUIContext(
                {
                    ...runner.getUIContext(),
                    select: async () => choices.shift(),
                    input: async () => inputs.shift(),
                    notify: (message) => {
                        notifications.push(message);
                    },
                },
                "rpc",
            );
            const controller = createController();

            await new ModePicker(controller).select(runner.createContext());
            assert.equal(await readFile(configPath, "utf8"), original);
            assert.deepEqual(controller.modes.modes, {
                review: { provider: "local", modelId: "small" },
            });
            assert.deepEqual(notifications, [`Mode name "${name}" is reserved`]);
        } finally {
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    },
);

test("mode controller derives settings reads from the explicit extension context", () => {
    const controller = createController();
    assert.deepEqual(
        controller.getSettingsContext({
            cwd: "/workspace/project",
            isProjectTrusted: () => true,
        }),
        { cwd: "/workspace/project", projectTrusted: true },
    );
});
