import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyModeEditor } from "./editor.ts";
import { ModeController } from "./mode-controller.ts";
import { ModePicker, registerModeSelectorShortcuts } from "./mode-picker.ts";
import { ModesStore } from "./modes-store.ts";
import {
    formatModelModesSettingsDiagnostic,
    getConfiguredModeShortcuts,
    loadModelModesSettings,
    SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY,
    type LoadedModelModesSettings,
    type SettingsReadContext,
    USE_THINKING_BORDER_COLORS_SETTINGS_KEY,
} from "./settings.ts";
import { isShortcutId } from "./shortcut-id.ts";
import { ThinkingStatusPatchSession } from "./status-patch-session.ts";

export default function (pi: ExtensionAPI) {
    let sessionGeneration = 0;
    let sessionSettings: LoadedModelModesSettings | undefined;
    let sessionSettingsContext: SettingsReadContext | undefined;
    const resolveSessionSettings = (context: SettingsReadContext): LoadedModelModesSettings => {
        if (
            sessionSettings === undefined ||
            sessionSettingsContext?.cwd !== context.cwd ||
            sessionSettingsContext.projectTrusted !== context.projectTrusted
        ) {
            sessionSettings = loadModelModesSettings(context);
            sessionSettingsContext = context;
        }

        return sessionSettings;
    };

    const controller = new ModeController(pi, new ModesStore(resolveSessionSettings));
    const picker = new ModePicker(controller);
    const statusPatchSession = new ThinkingStatusPatchSession();
    let editorHandle: { dispose(): void } | undefined;
    const registrationContext = { cwd: process.cwd(), projectTrusted: false };
    const shortcuts = getConfiguredModeShortcuts(registrationContext);
    if (shortcuts.forward !== undefined && isShortcutId(shortcuts.forward)) {
        pi.registerShortcut(shortcuts.forward, {
            description: "Cycle to the next configured mode",
            handler: async (ctx) => controller.cycle(ctx, 1),
        });
    }

    if (shortcuts.backward !== undefined && isShortcutId(shortcuts.backward)) {
        pi.registerShortcut(shortcuts.backward, {
            description: "Cycle to the previous configured mode",
            handler: async (ctx) => controller.cycle(ctx, -1),
        });
    }

    registerModeSelectorShortcuts(pi, async (ctx) => picker.select(ctx));

    pi.on("session_start", async (event, ctx) => {
        sessionGeneration += 1;

        const generation = sessionGeneration;
        statusPatchSession.reset();
        sessionSettings = undefined;
        sessionSettingsContext = undefined;

        const settingsContext = controller.getSettingsContext(ctx);
        const loaded = resolveSessionSettings(settingsContext);
        if (ctx.hasUI) {
            for (const diagnostic of loaded.diagnostics) {
                ctx.ui.notify(formatModelModesSettingsDiagnostic(diagnostic), diagnostic.severity);
            }
        }

        controller.setUseThinkingBorderColors(
            loaded.settings[USE_THINKING_BORDER_COLORS_SETTINGS_KEY],
        );
        controller.setShowThinkingLevelStatus(
            loaded.settings[SHOW_THINKING_LEVEL_STATUS_SETTINGS_KEY],
        );

        // Install the editor wrapper before loading mode files so startup renders use
        // the configured border color immediately.
        editorHandle?.dispose();
        editorHandle = applyModeEditor(controller, ctx);

        if (ctx.mode === "tui") {
            await statusPatchSession.activate(() => controller.thinkingLevelStatusEnabled);

            if (generation !== sessionGeneration) return;
        }

        await controller.handleSessionActivated(ctx, event);
    });
    pi.on("model_select", async (event, ctx) => controller.handleModelSelect(ctx, event));
    pi.on("session_shutdown", () => {
        sessionGeneration += 1;
        sessionSettings = undefined;
        sessionSettingsContext = undefined;
        statusPatchSession.reset();
        editorHandle?.dispose();
        editorHandle = undefined;
    });
}
