import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const initialTriggerSchema = StringEnum(
    ["messages", "turns", "tool_calls", "tokens", "minutes"] as const,
    {
        description: "The session activity that starts a naming attempt.",
        default: "messages",
    },
);

const refreshTriggerSchema = StringEnum(
    ["messages", "turns", "tool_calls", "tokens", "minutes"] as const,
    {
        description: "The activity that starts a naming refresh.",
        default: "turns",
    },
);

const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Enable the extension.",
        }),
        initialNaming: Type.Object(
            {
                enabled: Type.Boolean({
                    default: true,
                    description: "Automatically name an otherwise unnamed session once.",
                }),
                trigger: initialTriggerSchema,
                threshold: Type.Number({
                    default: 1,
                    minimum: 1,
                    description:
                        "The initial activity threshold. The default names the session after its first user message has been processed.",
                }),
            },
            {
                additionalProperties: false,
                default: { enabled: true, trigger: "messages", threshold: 1 },
            },
        ),
        refreshNaming: Type.Object(
            {
                enabled: Type.Boolean({
                    default: false,
                    description: "Periodically refresh the name as the session develops.",
                }),
                trigger: refreshTriggerSchema,
                threshold: Type.Number({
                    default: 10,
                    minimum: 1,
                    description: "The amount of activity between refreshes.",
                }),
            },
            {
                additionalProperties: false,
                default: { enabled: false, trigger: "turns", threshold: 10 },
            },
        ),
        model: Type.String({
            default: "current",
            minLength: 1,
            description:
                "Picker model in provider/model-id form, or current to use the session's active model.",
        }),
        reasoningEffort: StringEnum(
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
            {
                description: "Reasoning effort used by the session-name picker.",
                default: "low",
            },
        ),
        prompt: Type.String({
            default: [
                "You name coding sessions for quick recognition in a session list.",
                "Use the repository context and conversation to identify the main goal or workstream.",
                "Prefer a specific, useful phrase over a generic one.",
                "Return only the name; do not include quotes, Markdown, or an explanation.",
                "",
                "Repository context:",
                "<repository_context>",
                "{{repository_context}}",
                "</repository_context>",
                "",
                "Conversation:",
                "<conversation>",
                "{{conversation}}",
                "</conversation>",
                "",
                "Current name: {{current_name}}",
            ].join("\n"),
            minLength: 1,
            description:
                "Prompt used by the picker. Available placeholders are {{repository_context}}, {{conversation}}, {{current_name}}, {{cwd}}, and {{reason}}.",
        }),
        nameConstraints: Type.Object(
            {
                minLength: Type.Number({
                    default: 3,
                    minimum: 1,
                    description: "Minimum length of a name returned by the picker.",
                }),
                maxLength: Type.Number({
                    default: 60,
                    minimum: 1,
                    description: "Maximum length of a name returned by the picker.",
                }),
            },
            {
                additionalProperties: false,
                default: { minLength: 3, maxLength: 60 },
            },
        ),
    },
    { additionalProperties: false },
);

export type ExtensionSettings = Static<typeof settingsSchema>;

export const extensionSettingsDefinition = defineExtensionSettings({
    id: "pi-autoname-session",
    title: "Pi Autoname Session",
    description: "Settings for Pi Autoname Session.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-autoname-session/HEAD/config.schema.json",
    schema: settingsSchema,
});

export function loadAutonameSessionSettings(ctx: PiSettingsContext) {
    return loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
}

export default extensionSettingsDefinition;
