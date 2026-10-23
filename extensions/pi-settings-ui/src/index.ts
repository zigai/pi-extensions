import {
    CustomEditor,
    SettingsManager,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerEditorEnhancer } from "@zigai/pi-extension-internals";
import type { PiSettingsTab } from "./pi-settings-tab.ts";
import { createSettingsCommandEditor } from "./settings-command-editor.ts";
import type { SettingsEditorComponent } from "./settings-ui.ts";

async function openSettingsEditor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const [piTab, piProject, editorModel, store, ui, ownSettingsLoader] = await Promise.all([
        import("./pi-settings-tab.ts"),
        import("./pi-project-settings.ts"),
        import("./settings-editor.ts"),
        import("./settings-store.ts"),
        import("./settings-ui.ts"),
        import("./settings.ts"),
    ]);
    const ownSettings = ownSettingsLoader.loadSettingsUiSettings(ctx);
    for (const diagnostic of ownSettings.diagnostics) {
        ctx.ui.notify(diagnostic.message, diagnostic.severity);
    }

    const catalog = await store.loadSettingsCatalog(store.createPiSettingsLocation(ctx.cwd), {
        projectTrusted: ctx.isProjectTrusted(),
    });
    for (const diagnostic of catalog.diagnostics) {
        ctx.ui.notify(`${diagnostic.message} (${diagnostic.path})`, "warning");
    }

    const model = new editorModel.SettingsEditorModel(
        catalog,
        ownSettings.settings.projectOverrides && ctx.isProjectTrusted(),
    );
    let piSettings: PiSettingsTab | undefined;

    await ctx.ui.custom<void>(async (tui, theme, keybindings, done) => {
        const terminalTheme = ctx.ui.getTheme("system")?.appearance ?? "dark";
        const globalSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: false,
        });
        const projectSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: ctx.isProjectTrusted(),
        });
        const projectSnapshot = await piProject.loadPiProjectSettings(
            ctx.cwd,
            ctx.isProjectTrusted(),
        );
        let editor: SettingsEditorComponent | undefined;

        piSettings = new piTab.PiSettingsTab({
            globalSettings,
            projectSettings,
            projectSnapshot,
            pi,
            ui: ctx.ui,
            runtime: tui,
            model: ctx.model,
            availableDefaultModels: ctx.modelRegistry.getAvailable(),
            terminalTheme,
            onCancel: () => editor?.requestClose(),
            requestRender: () => tui.requestRender(),
        });
        editor = new ui.SettingsEditorComponent({
            cwd: ctx.cwd,
            model,
            piSettings,
            tui,
            theme,
            keybindings,
            header: ownSettings.settings.header,
            tabPickerShortcut: ownSettings.settings.tabPickerShortcut,
            save: store.saveSettingsLayers,
            close: () => done(undefined),
        });

        return editor;
    });
    await piSettings?.flush();
}

/** Register the Pi Settings UI extension. */
export default function extension(pi: ExtensionAPI): void {
    let restoreEditor: (() => void) | undefined;

    pi.on("session_start", (_event, ctx) => {
        restoreEditor?.();
        restoreEditor = undefined;

        if (ctx.mode !== "tui") return;

        const handle = registerEditorEnhancer(
            ctx,
            Symbol.for("pi-settings-ui.editor"),
            (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
            (base, _tui, _theme, keybindings) =>
                createSettingsCommandEditor(
                    base,
                    keybindings,
                    async () => openSettingsEditor(pi, ctx),
                    () => ctx.ui.notify("Settings could not be opened", "error"),
                ),
        );

        restoreEditor = () => handle.dispose();
    });

    pi.on("session_shutdown", () => {
        restoreEditor?.();
        restoreEditor = undefined;
    });
}
