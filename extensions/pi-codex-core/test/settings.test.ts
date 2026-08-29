import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import {
    initTheme,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { JsonObjectDecoder } from "../src/compaction/responses-input.ts";
import { registerCodexCommand } from "../src/settings/command.ts";
import { registerCodexIntegration } from "../src/settings/integration.ts";
import { openCodexSettingsScreen, type CodexSettingsTab } from "../src/settings/screen.ts";
import {
    DEFAULT_CODEX_CORE_CONFIG,
    type CodexCoreConfig,
    getCodexCoreConfigPath,
    getCodexCoreProjectConfigPath,
} from "../src/config/config.ts";
import {
    DEFAULT_TEST_EXTENSION_MODEL,
    TEST_THEME,
    makeExtensionContext,
    testDouble,
} from "./helpers.ts";

test("codex command only opens settings UI for the bare command", async () => {
    let opened = 0;
    const notifications: Array<{ readonly message: string; readonly type: string }> = [];
    const command = makeCodexCommandHarness();
    registerCodexCommand(command.api, {
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        applyConfig() {},
    });
    const ctx = makeSettingsContext({
        run() {
            opened += 1;
        },
        notify(message, type) {
            notifications.push({ message, type });
        },
    });

    await command.run("", ctx);
    await command.run("traces", ctx);

    assert.deepEqual(command.registeredCommands, ["codex"]);
    assert.equal(command.hasArgumentCompletions, false);
    assert.equal(opened, 1);
    assert.deepEqual(notifications, [{ message: "Usage: /codex", type: "warning" }]);
});

test("codex command persists changed global settings and applies trusted project overrides", async () => {
    initTheme(undefined, false);
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-command-save-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const globalConfigPath = getCodexCoreConfigPath(agentDir);
        const projectConfigPath = getCodexCoreProjectConfigPath(cwd);
        await mkdir(dirname(globalConfigPath), { recursive: true });
        await mkdir(dirname(projectConfigPath), { recursive: true });
        await writeFile(
            globalConfigPath,
            JSON.stringify({ scope: { tools: "codex" }, prompt: { mode: "pi" } }),
        );
        await writeFile(projectConfigPath, JSON.stringify({ prompt: { mode: "codex" } }));
        const appliedConfigs: CodexCoreConfig[] = [];
        const notifications: Array<{ readonly message: string; readonly type: string }> = [];
        const command = makeCodexCommandHarness();
        registerCodexCommand(command.api, {
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            applyConfig(config) {
                appliedConfigs.push(config);
            },
        });
        const ctx = makeSettingsContext({
            cwd,
            trusted: true,
            run(factory) {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                component.handleInput?.(" ");
            },
            notify(message, type) {
                notifications.push({ message, type });
            },
        });

        await command.run("", ctx);

        const persisted = JsonObjectDecoder.Parse(
            JSON.parse(await readFile(globalConfigPath, "utf8")),
        );
        const persistedScope = JsonObjectDecoder.Parse(persisted.scope);
        assert.equal(persistedScope.tools, "all");
        const persistedPrompt = JsonObjectDecoder.Parse(persisted.prompt);
        assert.equal(persistedPrompt.mode, "pi");
        assert.equal(appliedConfigs.length, 1);
        assert.equal(appliedConfigs[0]?.prompt.mode, "codex");
        assert.deepEqual(notifications, [{ message: "Codex settings saved.", type: "info" }]);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("codex command refuses malformed config without applying or overwriting it", async () => {
    initTheme(undefined, false);
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-command-malformed-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, "{not json");
        let applied = 0;
        const notifications: Array<{ readonly message: string; readonly type: string }> = [];
        const command = makeCodexCommandHarness();
        registerCodexCommand(command.api, {
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            applyConfig() {
                applied += 1;
            },
        });
        const ctx = makeSettingsContext({
            run(factory) {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                component.handleInput?.(" ");
            },
            notify(message, type) {
                notifications.push({ message, type });
            },
        });

        await command.run("", ctx);

        assert.equal(applied, 0);
        assert.equal(await readFile(configPath, "utf8"), "{not json");
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]?.type, "error");
        assert.match(notifications[0]?.message ?? "", /not saved.*malformed/);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("codex command reports write errors without applying settings", async () => {
    initTheme(undefined, false);
    const root = await mkdtemp(join(tmpdir(), "pi-codex-core-command-write-error-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
        const agentDir = join(root, "agent");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const configPath = getCodexCoreConfigPath(agentDir);
        const configDirectory = dirname(configPath);
        const blocker = "not a directory";
        await mkdir(dirname(configDirectory), { recursive: true });
        await writeFile(configDirectory, blocker);
        let applied = 0;
        const notifications: Array<{ readonly message: string; readonly type: string }> = [];
        const command = makeCodexCommandHarness();
        registerCodexCommand(command.api, {
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            applyConfig() {
                applied += 1;
            },
        });
        const ctx = makeSettingsContext({
            run(factory) {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                component.handleInput?.(" ");
            },
            notify(message, type) {
                notifications.push({ message, type });
            },
        });

        await command.run("", ctx);

        assert.equal(applied, 0);
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0]?.type, "error");
        assert.match(notifications[0]?.message ?? "", /Failed to save Codex settings/);
        assert.equal(await readFile(configDirectory, "utf8"), blocker);
    } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
});

test("codex command merges contributed settings tabs and routes subcommands", async () => {
    initTheme(undefined, false);
    let rendered = "";
    let starts = 0;
    const unregister = registerCodexIntegration({
        id: "test-voice",
        settingsTab: {
            id: "voice",
            label: "Voice",
            aliases: ["voice", "settings"],
            create: () => ({
                getItems: () => [
                    {
                        id: "voice.enabled",
                        label: "Realtime voice",
                        description: "Enable realtime voice.",
                        currentValue: "on",
                        values: ["off", "on"],
                    },
                ],
                onChange() {},
            }),
        },
        command: {
            commands: ["start"],
            handle() {
                starts += 1;
            },
        },
    });
    try {
        const command = makeCodexCommandHarness();
        registerCodexCommand(command.api, {
            getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
            applyConfig() {},
        });
        const ctx = makeSettingsContext({
            run(factory) {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                rendered = component.render(120).join("\n");
            },
        });

        await command.run("voice", ctx);
        await command.run("start", ctx);

        assert.match(rendered, /General.*Tools.*OpenAI.*Voice.*Usage/);
        assert.match(rendered, /Realtime voice/);
        assert.equal(starts, 1);
    } finally {
        unregister();
    }
});

test("settings screen refreshes draft from effective config after save", async () => {
    const initialConfig = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        tools: { ...DEFAULT_CODEX_CORE_CONFIG.tools, webSearch: false },
    };
    initTheme(undefined, false);
    let rendered = "";
    const ctx = makeSettingsContext({
        run(factory) {
            const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
            component.handleInput?.("\t");
            component.handleInput?.(" ");
            rendered = component.render(120).join("\n");
        },
    });

    await openCodexSettingsScreen(ctx, {
        initialConfig,
        onChange: (nextConfig) => {
            assert.equal(nextConfig.tools.webSearch, true);
            return { ok: true, effectiveConfig: initialConfig };
        },
    });

    const webSearchLine = rendered.split("\n").find((line) => line.includes("Web search"));
    assert.ok(webSearchLine);
    assert.ok(webSearchLine.includes("off"));
    assert.equal(webSearchLine.includes("on"), false);
});

test("contributed settings keep the changed item selected after save", async () => {
    initTheme(undefined, false);
    let secondValue = "off";
    let rendered = "";
    const ctx = makeSettingsContext({
        async run(factory) {
            const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
            component.handleInput?.("\x1b[B");
            component.handleInput?.(" ");
            await new Promise((resolve) => setImmediate(resolve));
            rendered = component.render(120).join("\n");
        },
    });

    await openCodexSettingsScreen(ctx, {
        initialConfig: DEFAULT_CODEX_CORE_CONFIG,
        initialTab: "voice",
        additionalTabs: [
            {
                id: "voice",
                label: "Voice",
                create: () => ({
                    getItems: () => [
                        {
                            id: "first",
                            label: "First",
                            description: "First contributed description.",
                            currentValue: "off",
                            values: ["off", "on"],
                        },
                        {
                            id: "second",
                            label: "Second",
                            description: "Second contributed description.",
                            currentValue: secondValue,
                            values: ["off", "on"],
                        },
                    ],
                    onChange(_id, value) {
                        secondValue = value;
                    },
                }),
            },
        ],
        onChange: () => ({ ok: false }),
    });

    assert.equal(secondValue, "on");
    assert.match(rendered, /Second contributed description/);
    assert.doesNotMatch(rendered, /First contributed description/);
});

test("settings screen saves standalone web search mode", async () => {
    initTheme(undefined, false);
    const ctx = makeSettingsContext({
        run(factory) {
            const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
            component.handleInput?.("\x1b[B");
            component.handleInput?.(" ");
        },
    });
    let savedMode = "";

    await openCodexSettingsScreen(ctx, {
        initialConfig: DEFAULT_CODEX_CORE_CONFIG,
        initialTab: "tools",
        onChange: (nextConfig) => {
            savedMode = nextConfig.tools.webSearchMode;
            return { ok: true, effectiveConfig: nextConfig };
        },
    });

    assert.equal(savedMode, "cached");
});

test("settings screen keeps the changed setting selected after save", async () => {
    initTheme(undefined, false);
    let rendered = "";
    const ctx = makeSettingsContext({
        run(factory) {
            const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
            component.handleInput?.("\x1b[B");
            component.handleInput?.(" ");
            rendered = component.render(120).join("\n");
        },
    });

    await openCodexSettingsScreen(ctx, {
        initialConfig: DEFAULT_CODEX_CORE_CONFIG,
        initialTab: "tools",
        onChange: (nextConfig) => ({ ok: true, effectiveConfig: nextConfig }),
    });

    assert.ok(
        rendered.includes("Use cached, indexed, or live results for standalone web_run searches."),
    );
    assert.equal(rendered.includes("Codex web.run / web_run search tool."), false);
});

test("settings screen shows personality only for supported bundled prompts", async () => {
    const renderForModel = async (modelId: string): Promise<string> => {
        let rendered = "";
        const ctx = makeSettingsContext({
            model: { ...DEFAULT_TEST_EXTENSION_MODEL, id: modelId },
            run(factory) {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                rendered = component.render(120).join("\n");
            },
        });
        await openCodexSettingsScreen(ctx, {
            initialConfig: DEFAULT_CODEX_CORE_CONFIG,
            onChange: () => ({ ok: false }),
        });
        return rendered;
    };

    assert.match(await renderForModel("gpt-5.5"), /Personality/);
    assert.doesNotMatch(await renderForModel("gpt-5.6-sol"), /Personality/);
});

test("settings screen renders a description for every setting", async () => {
    const descriptionsByTab = {
        general: [
            "Expose Codex extras only on Codex-like models, or on all models.",
            "Use Pi's prompt or the active GPT model's bundled Codex prompt.",
            "Set the Codex communication style; none disables personality instructions.",
            "Use OpenAI Codex responses compaction checkpoints when available.",
            "Automatically run native Codex compaction between turns.",
            "Context usage percentage that triggers native auto-compaction.",
        ],
        tools: [
            "Codex web.run / web_run search tool.",
            "Use cached, indexed, or live results for standalone web_run searches.",
            "Generate or edit images through Codex image APIs.",
            "Return local images to image-capable models.",
            "Fallback image descriptions for text-only models.",
            "Use apply_patch instead of edit: off, OpenAI/Codex-like models, or all models.",
        ],
        openai: [
            "Up to 1.5× faster token velocity; credit usage is higher and varies by model and pricing.",
            "Show streamed reasoning summaries for GPT Responses models.",
            "Text verbosity for Codex-native calls that support it.",
            "Model used by web_run; current follows the active Codex model.",
            "OpenAI image model used by imagegen generation and editing.",
            "Model used for optional image descriptions; current follows the active Codex model.",
            "Model used for native Codex compaction; current follows the active Codex model.",
            "Reasoning effort for native compaction calls.",
        ],
        usage: [
            "Fetch current Codex usage and banked reset credits.",
            "Spend one banked reset credit after an in-screen confirmation.",
        ],
    } satisfies Readonly<Record<CodexSettingsTab, readonly string[]>>;

    for (const tab of ["general", "tools", "openai", "usage"] as const) {
        const renderedSelections: string[] = [];
        const ctx = makeSettingsContext({
            model: DEFAULT_TEST_EXTENSION_MODEL,
            run(factory) {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                for (const _description of descriptionsByTab[tab]) {
                    renderedSelections.push(component.render(160).join("\n"));
                    component.handleInput?.("\x1b[B");
                }
            },
        });

        await openCodexSettingsScreen(ctx, {
            initialConfig: DEFAULT_CODEX_CORE_CONFIG,
            initialTab: tab,
            initialUsage: { error: "Usage unavailable in this UI test." },
            onChange: () => ({ ok: false }),
        });

        const rendered = renderedSelections.join("\n");
        for (const description of descriptionsByTab[tab]) {
            assert.ok(
                rendered.includes(description),
                `${tab} description was not rendered: ${description}`,
            );
        }
    }
});

test("settings screen cancels owned reset work when the custom UI closes", async () => {
    let resetTaskCancelled = false;
    const ctx = makeSettingsContext({
        run(factory) {
            const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
            component.handleInput?.("\x1b[B");
            component.handleInput?.(" ");
            component.handleInput?.("y");
        },
    });

    await openCodexSettingsScreen(ctx, {
        initialConfig: DEFAULT_CODEX_CORE_CONFIG,
        initialTab: "usage",
        initialUsage: {
            limits: [],
            resetCredits: { availableCount: 1, credits: [], raw: {} },
            raw: {},
        },
        onChange: () => ({ ok: false }),
        onConsumeResetCredit: async (_redeemRequestId, options) =>
            await new Promise<never>((_resolve, reject) => {
                const signal = options?.signal;
                if (signal?.aborted) {
                    resetTaskCancelled = true;
                    reject(signal.reason);
                    return;
                }
                signal?.addEventListener(
                    "abort",
                    () => {
                        resetTaskCancelled = true;
                        reject(signal.reason);
                    },
                    { once: true },
                );
            }),
    });

    assert.equal(resetTaskCancelled, true);
});

type SettingsScreenComponent = {
    readonly render: (width: number) => readonly string[];
    readonly handleInput?: (data: string) => void;
};

type SettingsKeybindings = Readonly<Record<string, never>>;

type SettingsScreenFactory = (
    tui: { readonly requestRender: () => void },
    theme: Theme,
    keybindings: SettingsKeybindings,
    done: () => void,
) => SettingsScreenComponent;

function makeSettingsContext(options: {
    readonly cwd?: string | undefined;
    readonly trusted?: boolean | undefined;
    readonly model?: typeof DEFAULT_TEST_EXTENSION_MODEL | undefined;
    readonly run: (factory: SettingsScreenFactory) => Promise<void> | void;
    readonly notify?: ((message: string, type: string) => void) | undefined;
}): ExtensionContext {
    const ctx = makeExtensionContext(options.cwd ?? "/workspace", options.trusted ?? true);
    if (options.model) {
        Object.defineProperty(ctx, "model", { configurable: true, value: options.model });
    }
    Object.defineProperty(ctx, "hasUI", { configurable: true, value: true });
    Object.defineProperty(ctx, "ui", {
        configurable: true,
        value: {
            custom: async (factory: SettingsScreenFactory) => await options.run(factory),
            notify: options.notify ?? (() => {}),
        },
    });
    return ctx;
}

type CodexCommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

type CodexCommandHarness = {
    readonly api: ExtensionAPI;
    readonly registeredCommands: readonly string[];
    readonly hasArgumentCompletions: boolean;
    readonly run: (args: string, ctx: ExtensionContext) => Promise<void>;
};

function makeCodexCommandHarness(): CodexCommandHarness {
    let codexHandler: CodexCommandHandler | undefined;
    let hasArgumentCompletions = false;
    const registeredCommands: string[] = [];
    const api = {
        registerCommand(
            name: string,
            command: {
                readonly handler: CodexCommandHandler;
                readonly getArgumentCompletions?: unknown;
            },
        ) {
            registeredCommands.push(name);
            hasArgumentCompletions = command.getArgumentCompletions !== undefined;
            if (name === "codex") codexHandler = command.handler;
        },
    };
    return {
        api: testDouble<ExtensionAPI>()(api),
        registeredCommands,
        get hasArgumentCompletions() {
            return hasArgumentCompletions;
        },
        async run(args: string, ctx: ExtensionContext): Promise<void> {
            assert.ok(codexHandler);
            await codexHandler(args, ctx);
        },
    };
}
