import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
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
import { ModesStore } from "../src/modes-store.ts";
import type { ModesFile, ModeSpec } from "../src/modes.ts";

type StartupConfig = Partial<Pick<ModesFile, "currentMode" | "defaultModel" | "modes">>;

const first: ModeSpec = { provider: "synthetic", modelId: "first", thinkingLevel: "high" };
const second: ModeSpec = { provider: "synthetic", modelId: "second", thinkingLevel: "low" };
const configured = {
    currentMode: "second",
    defaultModel: { provider: "synthetic", modelId: "legacy", thinkingLevel: "off" },
    modes: { first, second },
} satisfies StartupConfig;

async function createFixture(root: string, agentDir: string, config: StartupConfig | undefined) {
    const configPath = join(agentDir, "extension-settings", "pi-model-modes.json");
    await mkdir(join(configPath, ".."), { recursive: true });

    if (config !== undefined) await writeFile(configPath, JSON.stringify(config));

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
        models: ["first", "second", "legacy", "existing", "manual"].map((id) => ({
            id,
            name: id,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 10000,
            maxTokens: 100,
        })),
    });
    const registry = new ModelRegistry(models);
    const sessions = SessionManager.inMemory(root);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, sessions, registry);
    const menus: { title: string; options: string[] }[] = [];
    const choices: (string | undefined)[] = [];
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            select: async (title, options) => {
                menus.push({ title, options: [...options] });
                return choices.shift();
            },
            notify: () => {},
        },
        "rpc",
    );
    function model(id: string): Model<Api> {
        const found = registry.find("synthetic", id);
        assert.ok(found);
        return found;
    }

    let activeModel = model("existing");
    let thinking: ThinkingLevel = "medium";
    const modelSelections: string[] = [];
    const thinkingSelections: ThinkingLevel[] = [];
    const published: string[] = [];
    let selectModel: () => Promise<boolean> = async () => true;
    const controller = new ModeController(
        {
            getThinkingLevel: () => thinking,
            setThinkingLevel: (level) => {
                thinking = level;
                thinkingSelections.push(level);
            },
            setModel: async (next) => {
                modelSelections.push(next.id);
                const applied = await selectModel();
                if (applied) activeModel = model(next.id);
                return applied;
            },
        },
        undefined,
        (name) => {
            published.push(name);
        },
    );
    const ctx = runner.createContext();

    // Preserve the SDK context while modeling the host's live model getter.
    Object.defineProperty(ctx, "model", { get: () => activeModel });

    return {
        controller,
        ctx,
        sessions,
        configPath,
        menus,
        choices,
        modelSelections,
        thinkingSelections,
        published,
        get thinking() {
            return thinking;
        },
        setSelectionBehavior(behavior: typeof selectModel) {
            selectModel = behavior;
        },
        async manuallySelect(id: string) {
            activeModel = model(id);
            await controller.handleModelSelect(ctx, { model: activeModel });
        },
    };
}

async function withFixture(
    config: StartupConfig | undefined,
    run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "pi-model-modes-startup-"));
    const agentDir = join(root, "agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
        const fixture = await createFixture(root, agentDir, config);
        await run(fixture);
    } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
    }
}

test.each(["startup", "new"] as const)(
    "%s selects the first configured model and thinking, ignoring legacy defaults/currentMode",
    async (reason) => {
        await withFixture(configured, async (f) => {
            f.sessions.appendModelChange("synthetic", "existing");
            f.sessions.appendThinkingLevelChange("medium");

            if (reason === "new") {
                f.sessions.appendMessage({
                    role: "user",
                    content: "previous session",
                    timestamp: 1,
                });
            }

            await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason });
            assert.deepEqual(f.modelSelections, ["first"]);
            assert.deepEqual(f.thinkingSelections, ["high"]);
            assert.equal(f.ctx.model?.id, "first");
            assert.equal(f.controller.currentMode, "first");
            assert.deepEqual(f.published, ["first"]);
            assert.equal(await readFile(f.configPath, "utf8"), JSON.stringify(configured));
        });
    },
);

test.each(["resume", "fork", "reload", "startup"] as const)(
    "%s preserves a restored model and thinking level",
    async (reason) => {
        await withFixture(configured, async (f) => {
            f.sessions.appendMessage({ role: "user", content: "restored message", timestamp: 1 });
            await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason });
            assert.deepEqual(f.modelSelections, []);
            assert.deepEqual(f.thinkingSelections, []);
            assert.equal(f.ctx.model?.id, "existing");
            assert.equal(f.thinking, "medium");
        });
    },
);

test.each(["resume", "fork", "reload"] as const)(
    "%s does not apply startup modes even without conversation entries",
    async (reason) => {
        await withFixture(configured, async (f) => {
            await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason });
            assert.deepEqual(f.modelSelections, []);
            assert.deepEqual(f.thinkingSelections, []);
        });
    },
);

test.each(["missing file", "missing modes", "empty modes"])(
    "%s leaves the active model and thinking untouched",
    async (kind) => {
        let config: StartupConfig | undefined;
        if (kind === "missing modes") config = { defaultModel: configured.defaultModel };
        if (kind === "empty modes") config = { ...configured, modes: {} };

        await withFixture(config, async (f) => {
            for (const reason of ["startup", "new"] as const) {
                await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason });
            }

            assert.deepEqual(f.modelSelections, []);
            assert.deepEqual(f.thinkingSelections, []);
            assert.equal(f.ctx.model?.id, "existing");
            assert.equal(f.thinking, "medium");
        });
    },
);

test.each(["unavailable", "rejected"])(
    "%s first model preserves thinking and never falls through to the second mode",
    async (failure) => {
        let spec = first;

        if (failure === "unavailable") spec = { ...first, modelId: "missing" };

        await withFixture({ ...configured, modes: { first: spec, second } }, async (f) => {
            f.setSelectionBehavior(async () => false);
            await f.controller.handleSessionActivated(f.ctx, {
                type: "session_start",
                reason: "startup",
            });
            let expected: string[] = [];
            if (failure === "rejected") expected = ["first"];
            assert.deepEqual(f.modelSelections, expected);
            assert.deepEqual(f.thinkingSelections, []);
            assert.equal(f.ctx.model?.id, "existing");
            assert.equal(f.thinking, "medium");
        });
    },
);

test.each([
    { selection: "startup", interruption: "reset" },
    { selection: "startup", interruption: "manual selection" },
    { selection: "mode", interruption: "reset" },
    { selection: "mode", interruption: "manual selection" },
])(
    "pending $selection selection cannot publish or set thinking after $interruption",
    async ({ selection, interruption }) => {
        await withFixture(configured, async (f) => {
            let entered: () => void = () => {};
            let finish: (value: boolean) => void = () => {};
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const pending = new Promise<boolean>((resolve) => {
                finish = resolve;
            });
            f.setSelectionBehavior(async () => {
                entered();
                return pending;
            });
            let operation: Promise<unknown>;
            if (selection === "mode") operation = f.controller.applyMode(f.ctx, "first");
            else {
                operation = f.controller.handleSessionActivated(f.ctx, {
                    type: "session_start",
                    reason: "startup",
                });
            }

            try {
                await started;

                if (interruption === "reset") f.controller.resetSession();
                else await f.manuallySelect("manual");

                const published = [...f.published];
                const selected = f.controller.currentMode;
                finish(true);
                await operation;
                assert.deepEqual(f.thinkingSelections, []);
                assert.deepEqual(f.published, published);
                assert.equal(f.controller.currentMode, selected);
            } finally {
                finish(true);
                await operation;
            }
        });
    },
);

test("moving a mode first persists order without changing this session; new uses the moved mode", async () => {
    await withFixture(configured, async (f) => {
        await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason: "new" });
        f.modelSelections.length = 0;
        f.thinkingSelections.length = 0;
        f.published.length = 0;
        await f.controller.moveModeToFirst(f.ctx, "second");
        const saved = await new ModesStore().load(f.configPath, {}, { throwOnInvalid: true });
        assert.deepEqual(Object.keys(saved.modes), ["second", "first"]);
        assert.equal("defaultModel" in saved, false);
        assert.deepEqual(Object.keys(f.controller.modes.modes), ["second", "first"]);
        assert.equal(f.controller.currentMode, "first");
        assert.equal(f.ctx.model?.id, "first");
        assert.equal(f.thinking, "high");
        assert.deepEqual(f.modelSelections, []);
        assert.deepEqual(f.thinkingSelections, []);
        assert.deepEqual(f.published, []);
        f.controller.resetSession();
        await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason: "new" });
        assert.deepEqual(f.modelSelections, ["second"]);
        assert.deepEqual(f.thinkingSelections, ["low"]);
        assert.equal(f.controller.currentMode, "second");
    });
});

test("forward and backward cycling wrap in the persisted startup order", async () => {
    await withFixture(configured, async (f) => {
        await f.controller.moveModeToFirst(f.ctx, "second");
        await f.controller.handleSessionActivated(f.ctx, { type: "session_start", reason: "new" });

        for (const direction of [1, 1, -1, -1] as const) {
            await f.controller.cycle(f.ctx, direction);
        }

        assert.deepEqual(f.modelSelections, ["second", "first", "second", "first", "second"]);
        assert.deepEqual(f.thinkingSelections, ["low", "high", "low", "high", "low"]);
        assert.equal(f.ctx.model?.id, "second");
    });
});

test("picker labels startup mode, moves another mode first, and omits legacy default UI", async () => {
    await withFixture(configured, async (f) => {
        f.choices.push(
            "Configure modes…",
            "second",
            "Move to first / use on startup",
            "Back",
            "first",
            "Back",
            "Back",
            undefined,
        );
        await new ModePicker(f.controller).select(f.ctx);
        assert.deepEqual(f.menus[0]?.options, ["first (startup)", "second", "Configure modes…"]);
        assert.deepEqual(f.menus[1]?.options.slice(0, 2), ["first (startup)", "second"]);
        assert.ok(f.menus[2]?.options.includes("Move to first / use on startup"));
        assert.equal(f.menus[3]?.options.includes("Move to first / use on startup"), false);
        assert.deepEqual(f.menus[4]?.options.slice(0, 2), ["second (startup)", "first"]);
        assert.ok(f.menus[5]?.options.includes("Move to first / use on startup"));
        assert.deepEqual(f.menus.at(-1)?.options, [
            "second (startup)",
            "first",
            "Configure modes…",
        ]);

        for (const menu of f.menus) {
            assert.equal(
                menu.options.some((option) =>
                    /default model|set as default|clear default/i.test(option),
                ),
                false,
            );
        }

        assert.deepEqual(f.modelSelections, []);
        assert.deepEqual(f.thinkingSelections, []);
    });
});

test("selecting the startup label resolves to the actual mode name", async () => {
    await withFixture(configured, async (f) => {
        f.choices.push("first (startup)");
        await new ModePicker(f.controller).select(f.ctx);
        assert.equal(f.controller.currentMode, "first");
        assert.deepEqual(f.modelSelections, ["first"]);
        assert.deepEqual(f.thinkingSelections, ["high"]);
    });
});

test("runtime fallback modes are not labeled as configured startup modes", async () => {
    await withFixture(undefined, async (f) => {
        f.choices.push("Configure modes…", "Back", undefined);
        await new ModePicker(f.controller).select(f.ctx);
        assert.equal(f.controller.modes.hasConfiguredModes, false);
        assert.deepEqual(f.menus[0]?.options, ["default", "fast", "Configure modes…"]);
        assert.deepEqual(f.menus[1]?.options.slice(0, 2), ["default", "fast"]);
        assert.deepEqual(f.modelSelections, []);
        assert.deepEqual(f.thinkingSelections, []);
    });
});

test("integer-like keys cannot silently prevent a requested startup reorder", async () => {
    const config = { modes: { "1": first, second } };
    await withFixture(config, async (f) => {
        await assert.rejects(
            f.controller.moveModeToFirst(f.ctx, "second"),
            /Integer-like mode names/,
        );
        assert.deepEqual(Object.keys(f.controller.modes.modes), ["1", "second"]);
        assert.equal(await readFile(f.configPath, "utf8"), JSON.stringify(config));
        assert.deepEqual(f.modelSelections, []);
        assert.deepEqual(f.thinkingSelections, []);
        assert.deepEqual(f.published, []);
    });
});

test("startup label does not hide a mode with the same name", async () => {
    await withFixture({ modes: { first, "first (startup)": second } }, async (f) => {
        f.choices.push("first (startup) (startup)");
        await new ModePicker(f.controller).select(f.ctx);
        assert.deepEqual(f.menus[0]?.options, [
            "first (startup) (startup)",
            "first (startup)",
            "Configure modes…",
        ]);
        assert.equal(f.controller.currentMode, "first");
        f.choices.push("first (startup)");
        await new ModePicker(f.controller).select(f.ctx);
        assert.equal(f.controller.currentMode, "first (startup)");
        f.choices.push("Configure modes…", "first (startup) (startup)", "Back", "Back", undefined);
        await new ModePicker(f.controller).select(f.ctx);
        assert.match(f.menus.at(-3)?.title ?? "", /^Edit mode "first"/);
    });
});
