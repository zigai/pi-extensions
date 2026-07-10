import assert from "node:assert/strict";
import { test } from "vitest";
import {
    initTheme,
    type ExtensionAPI,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import { registerCodexCommand } from "../src/settings/command.ts";
import { openCodexSettingsScreen, type CodexSettingsTab } from "../src/settings/screen.ts";
import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import { DEFAULT_TEST_EXTENSION_MODEL, TEST_THEME, makeExtensionContext } from "./helpers.ts";

test("codex command only opens settings UI for the bare command", async () => {
    let opened = 0;
    const notifications: Array<{ readonly message: string; readonly type: string }> = [];
    const command = makeCodexCommandHarness();
    registerCodexCommand(command.api, {
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
        applyConfig() {},
    });
    const baseContext = makeExtensionContext("/workspace", true);
    const ctx = {
        ...baseContext,
        hasUI: true,
        ui: {
            custom: async () => {
                opened += 1;
            },
            notify(message: string, type: string) {
                notifications.push({ message, type });
            },
        },
    } as unknown as ExtensionContext;

    await command.run("", ctx);
    await command.run("traces", ctx);

    assert.deepEqual(command.registeredCommands, ["codex"]);
    assert.equal(command.hasArgumentCompletions, false);
    assert.equal(opened, 1);
    assert.deepEqual(notifications, [{ message: "Usage: /codex", type: "warning" }]);
});

test("settings screen refreshes draft from effective config after save", async () => {
    const initialConfig = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        tools: { ...DEFAULT_CODEX_CORE_CONFIG.tools, webSearch: false },
    };
    initTheme(undefined, false);
    let rendered = "";
    const ctx = {
        ui: {
            custom: async (
                factory: (
                    tui: unknown,
                    theme: Theme,
                    keybindings: unknown,
                    done: () => void,
                ) => {
                    readonly render: (width: number) => readonly string[];
                    readonly handleInput?: (data: string) => void;
                },
            ) => {
                const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                component.handleInput?.("\t");
                component.handleInput?.(" ");
                rendered = component.render(120).join("\n");
            },
        },
    };

    await openCodexSettingsScreen(ctx as unknown as ExtensionContext, {
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

test("settings screen shows personality only for supported bundled prompts", async () => {
    const renderForModel = async (modelId: string): Promise<string> => {
        let rendered = "";
        const ctx = {
            model: { ...DEFAULT_TEST_EXTENSION_MODEL, id: modelId },
            ui: {
                custom: async (
                    factory: (
                        tui: unknown,
                        theme: Theme,
                        keybindings: unknown,
                        done: () => void,
                    ) => { readonly render: (width: number) => readonly string[] },
                ) => {
                    const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                    rendered = component.render(120).join("\n");
                },
            },
        };
        await openCodexSettingsScreen(ctx as unknown as ExtensionContext, {
            initialConfig: DEFAULT_CODEX_CORE_CONFIG,
            onChange: () => ({ ok: false }),
        });
        return rendered;
    };

    assert.match(await renderForModel("gpt-5.5"), /Personality/);
    assert.doesNotMatch(await renderForModel("gpt-5.6-sol"), /Personality/);
});

test("settings screen renders a description for every setting", async () => {
    const descriptionsByTab: Readonly<Record<CodexSettingsTab, readonly string[]>> = {
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
    };

    for (const tab of ["general", "tools", "openai", "usage"] as const) {
        const renderedSelections: string[] = [];
        const ctx = {
            model: DEFAULT_TEST_EXTENSION_MODEL,
            ui: {
                custom: async (
                    factory: (
                        tui: unknown,
                        theme: Theme,
                        keybindings: unknown,
                        done: () => void,
                    ) => {
                        readonly render: (width: number) => readonly string[];
                        readonly handleInput?: (data: string) => void;
                    },
                ) => {
                    const component = factory({ requestRender() {} }, TEST_THEME, {}, () => {});
                    for (const _description of descriptionsByTab[tab]) {
                        renderedSelections.push(component.render(160).join("\n"));
                        component.handleInput?.("\x1b[B");
                    }
                },
            },
        };

        await openCodexSettingsScreen(ctx as unknown as ExtensionContext, {
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
        // SAFETY: This fixture implements the ExtensionAPI member exercised by registerCodexCommand.
        api: api as unknown as ExtensionAPI,
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
