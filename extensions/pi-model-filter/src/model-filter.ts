import { PHYSICAL_MODEL_ID } from "@zigai/pi-extension-internals";

export type ModelLike = {
    provider: string;
    id: string;
    [PHYSICAL_MODEL_ID]?: string;
};

export type FilterRuleConfig = {
    provider: string;
    models: string[];
};

export type NormalizedFilterRule = {
    providerPattern: string;
    providerRegex: RegExp;
    modelPatterns: string[];
    modelRegexes: RegExp[];
};

export type ModelFilterSettings = {
    includeRules: NormalizedFilterRule[];
    excludeRules: NormalizedFilterRule[];
};

function findMatchingRule(
    model: ModelLike,
    rules: readonly NormalizedFilterRule[],
): NormalizedFilterRule | undefined {
    for (const rule of rules) {
        if (!rule.providerRegex.test(model.provider)) continue;

        if (rule.modelRegexes.some((regex) => regex.test(model[PHYSICAL_MODEL_ID] ?? model.id))) {
            return rule;
        }
    }

    return undefined;
}

function hasIncludePolicy(model: ModelLike, rules: readonly NormalizedFilterRule[]): boolean {
    return rules.some((rule) => rule.providerRegex.test(model.provider));
}

export function globToRegex(pattern: string): RegExp {
    let regex = "";
    for (const character of pattern) {
        if (character === "*") {
            regex += ".*";
        } else if (character === "?") {
            regex += ".";
        } else {
            regex += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
        }
    }

    return new RegExp(`^${regex}$`);
}

export function normalizeRules(rules: readonly FilterRuleConfig[]): NormalizedFilterRule[] {
    return rules.map((rule) => ({
        providerPattern: rule.provider,
        providerRegex: globToRegex(rule.provider),
        modelPatterns: rule.models,
        modelRegexes: rule.models.map((model) => globToRegex(model)),
    }));
}

export function isVisibleModel(model: ModelLike, settings: ModelFilterSettings): boolean {
    if (hasIncludePolicy(model, settings.includeRules)) {
        const includeRule = findMatchingRule(model, settings.includeRules);
        if (includeRule === undefined) return false;
    }

    return findMatchingRule(model, settings.excludeRules) === undefined;
}

export function filterModels(
    models: readonly ModelLike[],
    settings: ModelFilterSettings,
): ModelLike[] {
    return models.filter((model) => isVisibleModel(model, settings));
}
