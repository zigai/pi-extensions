import { Type, type StaticDecode } from "typebox";

export const DEFAULT_COMPLETION_SUFFIX = " ";

export const mentionItemSchema = Type.Object(
    {
        name: Type.String({
            minLength: 1,
            description: "Name selected and written after the trigger.",
        }),
        id: Type.Optional(
            Type.String({
                minLength: 1,
                description:
                    "Stable identity within the parent path. Defaults to name for simple lists.",
            }),
        ),
        segment: Type.Optional(
            Type.String({
                minLength: 1,
                description: "Text inserted as this path segment. Defaults to name.",
            }),
        ),
        searchText: Type.Optional(
            Type.String({
                description: "Text used for searching instead of the name and description.",
            }),
        ),
        insertionText: Type.Optional(
            Type.String({
                minLength: 1,
                description: "Complete editor text for a selected terminal target.",
            }),
        ),
        parentPath: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
                description: "Ancestor IDs, from root to parent. Omit for root items.",
            }),
        ),
        selectable: Type.Optional(
            Type.Boolean({
                description:
                    "Allow selecting this item as a completed target. Defaults to false for navigable items and true otherwise.",
            }),
        ),
        navigable: Type.Optional(
            Type.Boolean({
                description: "Open a child picker when this item is selected. Defaults to false.",
            }),
        ),
        description: Type.Optional(
            Type.String({ description: "Secondary text shown in autocomplete." }),
        ),
        replacement: Type.Optional(
            Type.String({
                description:
                    "Text sent to the model in place of the mention. Defaults to the name.",
            }),
        ),
    },
    { additionalProperties: false, title: "MentionItem" },
);

const staticMentionSourceSchema = Type.Object(
    {
        type: Type.Literal("static"),
        items: Type.Array(mentionItemSchema, {
            maxItems: 10000,
            description: "Candidates offered by this mention source.",
        }),
    },
    { additionalProperties: false, title: "StaticMentionSource" },
);

const commandMentionSourceSchema = Type.Object(
    {
        type: Type.Literal("command"),
        mode: Type.Optional(
            Type.Union([Type.Literal("array"), Type.Literal("protocol")], {
                default: "array",
                description:
                    "array prints a flat item array; protocol uses version 1 JSON requests on stdin for discovery and exact resolution.",
            }),
        ),
        filtering: Type.Optional(
            Type.Union([Type.Literal("local"), Type.Literal("provider")], {
                default: "provider",
                description:
                    "Protocol result ranking owner. Array commands always use local filtering.",
            }),
        ),
        maxOutputBytes: Type.Optional(
            Type.Integer({
                minimum: 1024,
                maximum: 16777216,
                default: 1048576,
                description: "Maximum combined standard output and standard error size in bytes.",
            }),
        ),
        refreshIntervalMs: Type.Optional(
            Type.Integer({
                minimum: 1000,
                description:
                    "Periodic refresh interval for active cache entries. Requires caching.",
            }),
        ),
        watchFiles: Type.Optional(
            Type.Array(Type.String({ minLength: 1 }), {
                maxItems: 32,
                description: "Files whose changes invalidate cached results. Requires caching.",
            }),
        ),
        persistentCache: Type.Optional(
            Type.Boolean({
                description:
                    "Local disk caching, scoped by configuration, working directory, and trust.",
            }),
        ),
        command: Type.String({
            minLength: 1,
            description: "Executable that returns candidates in the selected command mode.",
        }),
        args: Type.Array(Type.String(), {
            default: [],
            description:
                "Arguments passed directly to the executable without shell interpretation.",
        }),
        debounceMs: Type.Optional(
            Type.Integer({
                minimum: 0,
                default: 100,
                description:
                    "Delay before starting the command so superseded autocomplete requests can cancel.",
            }),
        ),
        timeoutMs: Type.Optional(
            Type.Integer({
                minimum: 1,
                default: 5_000,
                description: "Maximum command runtime in milliseconds.",
            }),
        ),
        refreshOnStartup: Type.Optional(
            Type.Boolean({
                description: "Background root discovery at session startup. Requires caching.",
            }),
        ),
        cacheTtlMs: Type.Optional(
            Type.Integer({
                minimum: 1,
                description:
                    "Cache lifetime in milliseconds. Expired results remain available during refresh. Without a lifetime, results last for the session.",
            }),
        ),
        cache: Type.Optional(
            Type.Boolean({
                default: false,
                description: "Caching of successful command results.",
            }),
        ),
    },
    { additionalProperties: false, title: "CommandMentionSource" },
);

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
        description: "Ordering used before any query text is entered.",
    },
);

export const initialSuggestionsSchema = Type.Object(
    {
        strategy: initialSuggestionStrategySchema,
        pinned: Type.Array(Type.String({ minLength: 1 }), {
            default: [],
            uniqueItems: true,
            description:
                "Candidate names placed first, in this order, before the configured strategy.",
        }),
    },
    {
        default: {},
        additionalProperties: false,
        description: "Controls the entries shown immediately after the trigger.",
    },
);

export const mentionDefinitionSchema = Type.Object(
    {
        id: Type.String({
            minLength: 1,
            pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            description: "Stable identifier used for diagnostics and selection history.",
        }),
        trigger: Type.String({
            minLength: 1,
            pattern: "^[^/\\s]+$",
            description: "One or more non-whitespace, non-slash characters that start the mention.",
        }),
        separator: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 1,
                pattern: '^[^\\s"\\\\]$',
                description: "Separator between chained mention segments.",
            }),
        ),
        expansionPolicy: Type.Optional(
            Type.Union([Type.Literal("selected-only"), Type.Literal("selected-or-resolved")], {
                default: "selected-or-resolved",
                description:
                    "Expand only picker selections, or also resolve manually typed mentions.",
            }),
        ),
        replacementTemplate: Type.Optional(
            Type.String({
                description:
                    "Replacement template. Allowed fields: {{id}}, {{label}}, {{segment}}, {{path}}, {{ids}}. Provider data is never implicitly included.",
            }),
        ),
        completionSuffix: Type.Optional(
            Type.String({
                default: DEFAULT_COMPLETION_SUFFIX,
                description: "Text inserted after a completed mention.",
            }),
        ),
        source: Type.Union([staticMentionSourceSchema, commandMentionSourceSchema], {
            description: "Where this mention gets its candidates.",
        }),
        initialSuggestions: Type.Optional(initialSuggestionsSchema),
    },
    { additionalProperties: false, title: "MentionDefinition" },
);

export const mentionAnythingSettingsSchema = Type.Object(
    {
        mentions: Type.Array(mentionDefinitionSchema, {
            default: [],
            description: "Mention sources enabled in Pi.",
        }),
    },
    { additionalProperties: false },
);

export type ConfiguredMentionInput = StaticDecode<
    typeof mentionAnythingSettingsSchema
>["mentions"][number];

export type ConfiguredMention = Omit<
    ConfiguredMentionInput,
    "completionSuffix" | "initialSuggestions"
> & {
    completionSuffix: string;
    initialSuggestions: StaticDecode<typeof initialSuggestionsSchema>;
};

export type MentionAnythingSettings = { mentions: ConfiguredMention[] };
export type ConfiguredMentionItem = StaticDecode<typeof mentionItemSchema>;

const exampleSettings: MentionAnythingSettings = {
    mentions: [
        {
            id: "environments",
            trigger: "%",
            completionSuffix: " ",
            source: {
                type: "static",
                items: [
                    { name: "staging", description: "Staging environment" },
                    { name: "production", description: "Production environment" },
                ],
            },
            initialSuggestions: {
                strategy: "frecency",
                pinned: [],
            },
        },
        {
            id: "tickets",
            trigger: "ticket:",
            completionSuffix: " ",
            source: {
                type: "command",
                mode: "array",
                command: "list-my-tickets",
                args: ["--json"],
                cache: true,
                refreshOnStartup: true,
                cacheTtlMs: 300_000,
            },
            initialSuggestions: {
                strategy: "frecency",
                pinned: [],
            },
        },
    ],
};

export const extensionSettingsInput = {
    id: "pi-mention-anything",
    title: "Pi Mention Anything",
    description: "Define custom mention sources and triggers.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-mention-anything/config.schema.json",
    schema: mentionAnythingSettingsSchema,
    exampleSettings,
};

export default extensionSettingsInput;
