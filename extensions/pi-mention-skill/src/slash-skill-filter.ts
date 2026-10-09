import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

const SKILL_COMMAND_PREFIX = "skill:";

function withoutSlashSkills(
    suggestions: AutocompleteSuggestions | null,
): AutocompleteSuggestions | null {
    if (suggestions === null || !suggestions.prefix.startsWith("/")) return suggestions;

    const items = suggestions.items.filter((item) => !item.value.startsWith(SKILL_COMMAND_PREFIX));
    if (items.length === suggestions.items.length) return suggestions;
    if (items.length === 0) return null;

    return { ...suggestions, items };
}

/** Preserve the active autocomplete provider while removing slash-skill rows. */
export function createSlashSkillFilter(current: AutocompleteProvider): AutocompleteProvider {
    return {
        triggerCharacters: current.triggerCharacters,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
            return withoutSlashSkills(
                await current.getSuggestions(lines, cursorLine, cursorCol, options),
            );
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
    };
}
