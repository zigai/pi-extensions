import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMention, type MentionExtensionApi } from "@zigai/pi-mention-anything/api";
import { createCachedSkillExpansionLoader } from "./skill-content.ts";
import { loadMentionSkillSettingsResult } from "./settings.ts";
import { createSkillProvider, resolveSkillCandidate } from "./skill-provider.ts";
import { getSkillCommands } from "./skill-commands.ts";
import { createSlashSkillFilter } from "./slash-skill-filter.ts";

export type MentionSkillExtensionApi = Pick<ExtensionAPI, "getCommands"> & MentionExtensionApi;

export default function (pi: MentionSkillExtensionApi): void {
    const loadSkillExpansion = createCachedSkillExpansionLoader();
    const settingsByContext = new WeakMap<
        object,
        ReturnType<typeof loadMentionSkillSettingsResult>
    >();
    const settingsFor = (ctx: Parameters<typeof loadMentionSkillSettingsResult>[0]) => {
        const cached = settingsByContext.get(ctx);
        if (cached !== undefined) return cached;

        const loaded = loadMentionSkillSettingsResult(ctx);
        settingsByContext.set(ctx, loaded);

        return loaded;
    };

    pi.on("session_start", (_event, ctx) => {
        const loaded = settingsFor(ctx);
        if (ctx.hasUI) {
            for (const diagnostic of loaded.diagnostics) {
                ctx.ui.notify(diagnostic.message, diagnostic.severity);
            }
        }

        if (ctx.hasUI && loaded.settings.hideSlashSkills) {
            ctx.ui.addAutocompleteProvider(createSlashSkillFilter);
        }
    });

    registerMention(pi, {
        id: "skill",
        configuration(ctx) {
            const { settings } = settingsFor(ctx);
            return {
                trigger: settings.trigger,
                completionSuffix: settings.completionSuffix,
                initialSuggestions: settings.initialSuggestions,
                expansionPolicy: "selected-or-resolved",
            };
        },
        provider(ctx) {
            const { settings } = settingsFor(ctx);

            return createSkillProvider(() => getSkillCommands(pi), loadSkillExpansion, {
                projectSkillsFirst: settings.initialSuggestions.projectSkillsFirst,
            });
        },
        async replacement(candidatePath, _ctx, options) {
            return resolveSkillCandidate(candidatePath, loadSkillExpansion, options.signal);
        },
    });
}
