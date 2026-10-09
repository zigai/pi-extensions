import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createListProvider,
    registerMention,
    type MentionExtensionApi,
} from "@zigai/pi-mention-anything/api";
import { listProjectDirectories } from "./projects.ts";
import {
    applyMentionProjectCliFlags,
    loadMentionProjectSettingsResult,
    INCLUDE_DOT_FOLDERS_FLAG,
    INCLUDE_NON_GIT_FLAG,
    type MentionProjectSettingsContext,
} from "./settings.ts";

function mentionProjectSettings(
    pi: Pick<ExtensionAPI, "getFlag">,
    ctx: MentionProjectSettingsContext,
) {
    const loaded = loadMentionProjectSettingsResult(ctx);
    return {
        settings: applyMentionProjectCliFlags(loaded.settings, {
            includeNonGit: pi.getFlag(INCLUDE_NON_GIT_FLAG),
            includeDotFolders: pi.getFlag(INCLUDE_DOT_FOLDERS_FLAG),
        }),
        diagnostics: loaded.diagnostics,
    };
}

export type ProjectMentionExtensionApi = Pick<ExtensionAPI, "registerFlag" | "getFlag"> &
    MentionExtensionApi;

export function registerProjectMentionExtension(pi: ProjectMentionExtensionApi): void {
    pi.registerFlag(INCLUDE_NON_GIT_FLAG, {
        description: "Include non-Git child folders in pi-mention-project suggestions.",
        type: "boolean",
        default: false,
    });
    pi.registerFlag(INCLUDE_DOT_FOLDERS_FLAG, {
        description: "Include dot-prefixed child folders in pi-mention-project suggestions.",
        type: "boolean",
        default: false,
    });

    const settingsByContext = new WeakMap<object, ReturnType<typeof mentionProjectSettings>>();
    const settingsFor = (ctx: MentionProjectSettingsContext) => {
        const cached = settingsByContext.get(ctx);
        if (cached !== undefined) return cached;

        const settings = mentionProjectSettings(pi, ctx);
        settingsByContext.set(ctx, settings);

        return settings;
    };

    pi.on("session_start", (_event, ctx) => {
        const loaded = settingsFor(ctx);

        if (!ctx.hasUI) return;

        for (const diagnostic of loaded.diagnostics) {
            ctx.ui.notify(diagnostic.message, diagnostic.severity);
        }
    });

    registerMention(pi, {
        id: "project",
        configuration(ctx) {
            const { settings } = settingsFor(ctx);
            return {
                trigger: settings.trigger,
                completionSuffix: settings.completionSuffix,
                initialSuggestions: settings.initialSuggestions,
                expansionPolicy: "selected-or-resolved",
                cache: true,
                cacheTtlMs: 5_000,
                refreshOnStartup: true,
            };
        },
        provider(ctx) {
            const { settings } = settingsFor(ctx);

            return createListProvider(async (request) => {
                const projects = await listProjectDirectories(settings, ctx.cwd, {
                    signal: request.signal,
                });

                return projects.map((project) => ({
                    id: project.path,
                    label: project.name,
                    segment: project.name,
                    description: project.path,
                    searchText: `${project.name} ${project.path}`,
                    selectable: true,
                    navigable: false,
                    replacement: project.path,
                }));
            });
        },
    });
}

export default function (pi: ExtensionAPI): void {
    registerProjectMentionExtension(pi);
}
