import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { createConfiguredProvider } from "./configured-source.ts";
import { registerMentionSources, type MentionConfiguration } from "./register-mention.ts";
import { loadMentionAnythingSettings } from "./settings.ts";

export default function (pi: Pick<ExtensionAPI, "on">): void {
    registerMentionSources(pi, (ctx) =>
        loadMentionAnythingSettings(ctx).mentions.map((mention) => ({
            id: mention.id,
            configuration: (): MentionConfiguration => {
                const base = {
                    trigger: mention.trigger,
                    separator: mention.separator,
                    completionSuffix: mention.completionSuffix,
                    initialSuggestions: mention.initialSuggestions,
                    expansionPolicy: mention.expansionPolicy,
                    replacementTemplate: mention.replacementTemplate,
                };
                if (mention.source.type === "static") return { ...base, cache: true };

                const source = mention.source;
                const configurationKey = createHash("sha256")
                    .update(JSON.stringify(mention))
                    .digest("hex");
                const configuration = {
                    ...base,
                    cache: source.cache,
                    debounceMs: source.debounceMs,
                    cacheTtlMs: source.cacheTtlMs,
                    refreshOnStartup: source.refreshOnStartup,
                    refreshIntervalMs: source.refreshIntervalMs,
                    watchFiles: source.watchFiles,
                    configurationKey,
                };
                if (source.persistentCache === true)
                    return {
                        ...configuration,
                        persistentCachePath: join(
                            getAgentDir(),
                            "cache",
                            "pi-mention-anything",
                            `${mention.id}.json`,
                        ),
                    };

                return configuration;
            },
            provider: () => createConfiguredProvider(mention, ctx.cwd),
        })),
    );
}
