import { Type, type StaticDecode } from "typebox";

export const DEFAULT_MENTION_TRIGGER = "$";
export const DEFAULT_COMPLETION_SUFFIX = " ";

export const initialSuggestionStrategySchema = Type.Union(
    [
        Type.Literal("frecency"),
        Type.Literal("recent"),
        Type.Literal("frequent"),
        Type.Literal("alphabetical"),
        Type.Literal("sourceOrder"),
    ],
    {
        default: "frecency",
        description: "Ordering used before any skill query text is entered.",
    },
);

export const mentionSkillSettingsSchema = Type.Object(
    {
        trigger: Type.String({
            minLength: 1,
            pattern: "^[^/\\s]+$",
            default: DEFAULT_MENTION_TRIGGER,
            description:
                "One or more non-whitespace, non-slash characters that start a skill mention.",
        }),
        hideSlashSkills: Type.Boolean({
            default: true,
            description: "Hide skill commands from slash-command completion.",
        }),
        completionSuffix: Type.String({
            default: DEFAULT_COMPLETION_SUFFIX,
            description: "Text inserted after a completed skill mention.",
        }),
        initialSuggestions: Type.Object(
            {
                strategy: initialSuggestionStrategySchema,
                pinned: Type.Array(Type.String({ minLength: 1 }), {
                    default: [],
                    uniqueItems: true,
                    description:
                        "Skill names placed first, in this order, before the configured strategy.",
                }),
                projectSkillsFirst: Type.Boolean({
                    default: false,
                    description:
                        "Place project-local skills before user and temporary skills in initial suggestions.",
                }),
            },
            {
                default: {},
                additionalProperties: false,
                description: "Controls the entries shown immediately after the trigger.",
            },
        ),
    },
    { additionalProperties: false },
);

export type MentionSkillSettings = StaticDecode<typeof mentionSkillSettingsSchema>;
export type InitialSuggestionsSettings = MentionSkillSettings["initialSuggestions"];

export const extensionSettingsInput = {
    id: "pi-mention-skill",
    title: "Pi Mention Skill",
    description: "Settings for skill mentions and slash-skill visibility.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-mention-skill/config.schema.json",
    schema: mentionSkillSettingsSchema,
};

export default extensionSettingsInput;
