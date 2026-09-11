import {
    CustomEditor,
    SettingsManager,
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { PiSettingsTab } from "./pi-settings-tab.ts";
import { loadPiProjectSettings } from "./pi-project-settings.ts";
import { SettingsCommandEditor } from "./settings-command-editor.ts";
import { SettingsEditorModel } from "./settings-editor.ts";
import {
    createPiSettingsLocation,
    loadSettingsCatalog,
    saveSettingsLayers,
} from "./settings-store.ts";
import { SettingsEditorComponent } from "./settings-ui.ts";
import { loadSettingsUiSettings } from "./settings.ts";

async function openSettingsEditor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
    const ownSettings = loadSettingsUiSettings(ctx);
    for (const diagnostic of ownSettings.diagnostics) {
        ctx.ui.notify(diagnostic.message, diagnostic.severity);
    }

    const catalog = await loadSettingsCatalog(createPiSettingsLocation(ctx.cwd), {
        projectTrusted: ctx.isProjectTrusted(),
    });
    for (const diagnostic of catalog.diagnostics) {
        ctx.ui.notify(`${diagnostic.message} (${diagnostic.path})`, "warning");
    }

    const model = new SettingsEditorModel(
        catalog,
        ownSettings.settings.projectOverrides && ctx.isProjectTrusted(),
    );
    let piSettings: PiSettingsTab | undefined;

    await ctx.ui.custom<void>(async (tui, theme, keybindings, done) => {
        const terminalTheme = (await tui.queryTerminalColorScheme({ timeoutMs: 100 })) ?? "dark";
        const globalSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: false,
        });
        const projectSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
            projectTrusted: ctx.isProjectTrusted(),
        });
        const projectSnapshot = await loadPiProjectSettings(ctx.cwd, ctx.isProjectTrusted());
        let editor: SettingsEditorComponent | undefined;

        piSettings = new PiSettingsTab({
            globalSettings,
            projectSettings,
            projectSnapshot,
            pi,
            ui: ctx.ui,
            runtime: tui,
            model: ctx.model,
            terminalTheme,
            onCancel: () => editor?.requestClose(),
            requestRender: () => tui.requestRender(),
        });
        editor = new SettingsEditorComponent({
            cwd: ctx.cwd,
            model,
            piSettings,
            tui,
            theme,
            keybindings,
            save: saveSettingsLayers,
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
        const loaded = loadSettingsUiSettings(ctx);
        if (ctx.hasUI) {
            for (const diagnostic of loaded.diagnostics) {
                ctx.ui.notify(diagnostic.message, diagnostic.severity);
            }
        }

        if (ctx.mode !== "tui") return;

        const previousFactory = ctx.ui.getEditorComponent();
        const settingsFactory: NonNullable<Parameters<typeof ctx.ui.setEditorComponent>[0]> = (
            tui,
            theme,
            keybindings,
        ) => {
            const base =
                previousFactory?.(tui, theme, keybindings) ??
                new CustomEditor(tui, theme, keybindings);

            return new SettingsCommandEditor(
                base,
                keybindings,
                async () => openSettingsEditor(pi, ctx),
                () => ctx.ui.notify("Settings could not be opened", "error"),
            );
        };

        ctx.ui.setEditorComponent(settingsFactory);
        restoreEditor = () => {
            if (ctx.ui.getEditorComponent() === settingsFactory) {
                ctx.ui.setEditorComponent(previousFactory);
            }
        };
    });

    pi.on("session_shutdown", () => {
        restoreEditor?.();
        restoreEditor = undefined;
    });
}
