import type { RenderingAppearance, ToolCallIndicator } from "../rendering/theme.ts";
import type { ScriptPreviewHeaderLayout } from "../tools/built-in/bash/script-renderer.ts";
import type { ShellLayout, ShellOperatorPosition } from "../tools/built-in/bash/command.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptFormatterCommands,
} from "../tools/built-in/bash/formatter.ts";
import type { ToolLabelMode } from "../rendering/status-labels.ts";
import type { MutationSettings } from "../rendering/preview-settings.ts";
import type { ExtensionSettings } from "../settings.ts";

export type GlowupConfig = {
    readonly preserveTools: readonly string[];
    readonly mutations: MutationSettings;
    readonly appearance: RenderingAppearance;
    readonly debugLog: {
        readonly enabled: boolean;
        readonly path: string;
        readonly maxBytes: number | null;
        readonly memorySampleIntervalMs: number;
    };
    readonly renderCache: {
        readonly maxBytes: number;
        readonly maxEntries: number;
    };
    readonly scriptFormatters: ScriptFormatterCommands;
    readonly scriptHeaderLayout: ScriptPreviewHeaderLayout;
    readonly scriptMaxCodePreviewLines: number;
    readonly scriptShowPrologueOmission: boolean;
    readonly shellLayout: ShellLayout;
    readonly shellOperatorPosition: ShellOperatorPosition;
    readonly toolCallIndicator: ToolCallIndicator;
    readonly toolLabels: {
        readonly mode: ToolLabelMode;
    };
    readonly writePreview: {
        readonly movingViewport: boolean;
    };
    readonly syntax: {
        readonly preloadLanguages: readonly string[];
        readonly bracketPairColoring: boolean;
        readonly projectLanguageDetection: {
            readonly enabled: boolean;
        };
    };
    readonly patches: {
        readonly assistantSeparator: boolean;
        readonly workingWidgetSpacing: boolean;
        readonly autocompleteCleanup: boolean;
        readonly markdownSyntax: boolean;
        readonly thirdPartyToolRenderers: boolean;
    };
};

export function normalizeGlowupConfig(
    settings: ExtensionSettings,
    reportWarning: ((message: string) => void) | undefined,
): GlowupConfig {
    return {
        preserveTools: settings.preserveTools.filter((value) => value.trim().length > 0),
        mutations: settings.mutations,
        appearance: settings.appearance,
        debugLog: settings.debugLog,
        renderCache: settings.renderCache,
        scriptFormatters: parseScriptFormatterCommandsValue(
            settings.scriptPreview.formatters,
            reportWarning === undefined
                ? { source: "settings.scriptPreview.formatters" }
                : { source: "settings.scriptPreview.formatters", reportWarning },
        ),
        scriptHeaderLayout: settings.scriptPreview.headerLayout,
        scriptMaxCodePreviewLines: settings.scriptPreview.maxCodePreviewLines,
        scriptShowPrologueOmission: settings.scriptPreview.showPrologueOmission,
        shellLayout: settings.scriptPreview.shellLayout,
        shellOperatorPosition: settings.scriptPreview.shellOperatorPosition,
        toolCallIndicator: settings.toolCallIndicator,
        toolLabels: settings.toolLabels,
        writePreview: settings.writePreview,
        syntax: settings.syntax,
        patches: settings.patches,
    };
}
