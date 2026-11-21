import { Type, type StaticDecode } from "typebox";

export const DEFAULT_MENTION_TRIGGER = "#";
export const DEFAULT_COMPLETION_SUFFIX = " ";
export const INCLUDE_NON_GIT_FLAG = "mention-project-include-non-git";
export const INCLUDE_DOT_FOLDERS_FLAG = "mention-project-include-dot-folders";

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
        description: "Ordering used before any project query text is entered.",
    },
);

export const initialSuggestionsSchema = Type.Object(
    {
        strategy: initialSuggestionStrategySchema,
        pinned: Type.Array(Type.String({ minLength: 1 }), {
            default: [],
            uniqueItems: true,
            description:
                "Project names placed first, in this order, before the configured strategy.",
        }),
    },
    {
        default: {},
        additionalProperties: false,
        description: "Controls the entries shown immediately after the trigger.",
    },
);

export const mentionProjectSettingsSchema = Type.Object(
    {
        trigger: Type.String({
            minLength: 1,
            pattern: "^[^/\\s]+$",
            default: DEFAULT_MENTION_TRIGGER,
            description:
                "One or more non-whitespace, non-slash characters that start a project mention.",
        }),
        roots: Type.Union(
            [
                Type.String({
                    title: "One directory",
                    minLength: 1,
                    "x-control": "path",
                    description: "One project root directory.",
                }),
                Type.Array(
                    Type.String({
                        minLength: 1,
                        "x-control": "path",
                        description: "Project root directory.",
                    }),
                    { title: "Directory list" },
                ),
            ],
            {
                default: [],
                description: "Project root directory or directories searched for projects.",
            },
        ),
        gitReposOnly: Type.Boolean({
            default: true,
            description: "Include only directories containing Git repositories.",
        }),
        includeDotFolders: Type.Boolean({
            default: false,
            description: "Include project directories whose names start with a dot.",
        }),
        completionSuffix: Type.String({
            default: DEFAULT_COMPLETION_SUFFIX,
            description: "Text inserted after a completed project mention.",
        }),
        initialSuggestions: initialSuggestionsSchema,
    },
    { additionalProperties: false },
);

type DecodedMentionProjectSettings = StaticDecode<typeof mentionProjectSettingsSchema>;

export type MentionProjectSettings = Omit<DecodedMentionProjectSettings, "roots"> & {
    roots: string[];
};

export type InitialSuggestionsSettings = MentionProjectSettings["initialSuggestions"];

export const extensionSettingsInput = {
    id: "pi-mention-project",
    title: "Pi Mention Project",
    description: "Settings for project mentions and project discovery.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-mention-project/config.schema.json",
    schema: mentionProjectSettingsSchema,
};

export default extensionSettingsInput;
