import {
    getAliasModelIdCollision,
    type ModelLike,
    type ModelAliasSettings,
} from "./model-aliasing.ts";
import type { LoadedModelAliasSettings } from "./settings.ts";

/** Settings identity caches registry validation; explicit refresh rechecks native models.
 * Selector snapshots validate independently and never replace the registry cache. */
export class AliasPolicy {
    private validatedConfig?: {
        source: LoadedModelAliasSettings;
        loaded: LoadedModelAliasSettings;
    };

    constructor(private readonly source: { loadSettings(): LoadedModelAliasSettings }) {}

    load(
        nativeModels: () => readonly ModelLike[],
        refreshModels = false,
    ): LoadedModelAliasSettings {
        const loaded = this.source.loadSettings();
        if (!refreshModels && this.validatedConfig?.source === loaded) {
            return this.validatedConfig.loaded;
        }

        let validated = loaded;

        if (loaded.diagnostic === undefined && loaded.settings.aliases.length > 0) {
            const models = nativeModels();
            const collision = getAliasModelIdCollision(loaded.settings, models);
            if (collision !== undefined) {
                validated = {
                    ...loaded,
                    settings: {
                        ...loaded.settings,
                        aliases: [],
                        providerAliases: [],
                    },
                    diagnostic: `Failed to load ${loaded.path}: ${collision}`,
                };
            }
        }

        this.validatedConfig = { source: loaded, loaded: validated };
        return validated;
    }

    forModels(models: readonly ModelLike[]): ModelAliasSettings {
        const loaded = this.source.loadSettings();
        if (
            loaded.diagnostic !== undefined ||
            getAliasModelIdCollision(loaded.settings, models) === undefined
        )
            return loaded.settings;

        return { ...loaded.settings, aliases: [], providerAliases: [] };
    }
}
