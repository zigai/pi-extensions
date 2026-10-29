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

test.each(["mode", "default"] as const)(
    "%s model selection cannot publish or set thinking after session reset",
    async (selection) => {
        const root = await mkdtemp(join(tmpdir(), "pi-model-modes-stale-"));
        const agentDir = join(root, "agent");
        vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
        let started: () => void = () => {};
        let finish: (applied: boolean) => void = () => {};
        const entered = new Promise<void>((resolve) => {
            started = resolve;
        });
        const pending = new Promise<boolean>((resolve) => {
            finish = resolve;
        });
        const thinkingSelections: string[] = [];
        const published: string[] = [];
        try {
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            const spec = { provider: "synthetic", modelId: "small", thinkingLevel: "high" };
            await writeFile(
                join(agentDir, "extension-settings", "pi-model-modes.json"),
                JSON.stringify({
                    currentMode: "review",
                    modes: { review: spec },
                    defaultModel: spec,
                }),
            );
            const loaded = await discoverAndLoadExtensions([], root, agentDir);
            const models = await ModelRuntime.create({
                authPath: join(root, "auth.json"),
                modelsPath: null,
                refreshOnCreate: false,
            });
            models.registerProvider("synthetic", {
                api: "openai-completions",
                apiKey: "synthetic-key",
                baseUrl: "https://example.invalid",
                models: [
                    {
                        id: "small",
                        name: "Small",
                        reasoning: true,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 10000,
                        maxTokens: 100,
                    },
                ],
            });
            const runner = new ExtensionRunner(
                loaded.extensions,
                loaded.runtime,
                root,
                SessionManager.inMemory(root),
                new ModelRegistry(models),
            );
            const controller = new ModeController(
                {
                    getThinkingLevel: () => "medium",
                    setThinkingLevel: (level) => {
                        thinkingSelections.push(level);
                    },
                    setModel: async () => {
                        started();
                        return pending;
                    },
                },
                undefined,
                (mode) => {
                    published.push(mode);
                },
            );
            const ctx = runner.createContext();
            let operation: Promise<unknown>;
            if (selection === "mode") operation = controller.applyMode(ctx, "review");
            else
                operation = controller.handleSessionActivated(ctx, {
                    type: "session_start",
                    reason: "new",
                });

            await entered;
            controller.resetSession();
            finish(true);
            await operation;
            assert.deepEqual(thinkingSelections, []);
            assert.deepEqual(published, []);
        } finally {
            finish(true);
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    },
);

test.each(["rename", "delete"] as const)(
    "%s publishes only when the current mode changes",
    async (action) => {
        const root = await mkdtemp(join(tmpdir(), "pi-model-modes-selection-"));
        const agentDir = join(root, "agent");
        vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
        const published: string[] = [];
        try {
            await mkdir(join(agentDir, "extension-settings"), { recursive: true });
            await writeFile(
                join(agentDir, "extension-settings", "pi-model-modes.json"),
                JSON.stringify({
                    currentMode: "review",
                    modes: {
                        review: { provider: "local", modelId: "small" },
                        inactive: { provider: "local", modelId: "large" },
                        remaining: { provider: "local", modelId: "other" },
                    },
                }),
            );
            const loaded = await discoverAndLoadExtensions([], root, agentDir);
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
            const controller = new ModeController(
                {
                    getThinkingLevel: () => "medium",
                    setThinkingLevel: () => {},
                    setModel: async () => true,
                },
                undefined,
                (mode) => {
                    published.push(mode);
                },
            );
            const ctx = runner.createContext();
            await controller.ensure(ctx);

            if (action === "rename") {
                await controller.renameMode(ctx, "review", "review");
                await controller.renameMode(ctx, "inactive", "renamed");
            } else await controller.deleteMode(ctx, "inactive");

            assert.equal(controller.currentMode, "review");
            assert.deepEqual(published, []);

            if (action === "rename") await controller.renameMode(ctx, "review", "selected");
            else await controller.deleteMode(ctx, "review");

            assert.deepEqual(published, [controller.currentMode]);

            if (action === "rename") assert.equal(controller.currentMode, "selected");
            else assert.equal(controller.currentMode, "custom");
        } finally {
            vi.unstubAllEnvs();
            await rm(root, { recursive: true, force: true });
        }
    },
);
