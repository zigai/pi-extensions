import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type, type StaticDecode } from "typebox";

const NAMING_TRIGGERS = ["messages", "turns", "tool_calls", "tokens", "minutes"] as const;
const INITIAL_NAMING_TIMINGS = ["prompt", "settled"] as const;
const CONVERSATION_SCOPES = ["minimized", "full"] as const;

const initialTriggerSchema = StringEnum(NAMING_TRIGGERS, {
    description: "The session activity that starts a naming attempt.",
    default: "messages",
});

const refreshTriggerSchema = StringEnum(NAMING_TRIGGERS, {
    description: "The activity that starts a naming refresh.",
    default: "turns",
});

const conversationScopeSchema = StringEnum(CONVERSATION_SCOPES, {
    description:
        "How much refresh context to send. Minimized sends only user and assistant text; full also includes tool arguments, results, and shell output. Initial naming always uses only the first user request.",
    default: "minimized",
});

export const settingsSchema = Type.Object(
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
                timing: StringEnum(INITIAL_NAMING_TIMINGS, {
                    default: "prompt",
                    description:
                        "When to first check the naming trigger: before the agent starts on a prompt, or after the agent has settled.",
                }),
                trigger: initialTriggerSchema,
                threshold: Type.Integer({
                    default: 1,
                    minimum: 1,
                    description: "The initial activity threshold.",
                }),
            },
            {
                additionalProperties: false,
                default: { enabled: true, timing: "prompt", trigger: "messages", threshold: 1 },
            },
        ),
        refreshNaming: Type.Object(
            {
                enabled: Type.Boolean({
                    default: false,
                    description: "Periodically refresh the name as the session develops.",
                }),
                trigger: refreshTriggerSchema,
                threshold: Type.Integer({
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
            pattern: "^(?:current|[^/\\s]+/\\S+)$",
            description: "Picker model: provider/model-id, or current for the active model.",
        }),
        reasoningEffort: StringEnum(
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
            {
                description: "Reasoning effort used by the session-name picker.",
                default: "low",
            },
        ),
        timeoutMs: Type.Integer({
            default: 30_000,
            minimum: 1_000,
            description:
                "Maximum time in milliseconds for picker authentication and the model response before the naming attempt is treated as failed.",
        }),
        conversationScope: conversationScopeSchema,
        prompt: Type.String({
            default: [
                "Generate a title that will help the user recognize this coding session weeks later.",
                "",
                "Before answering, silently identify:",
                "- Subject: the system, feature, or problem the request is really about.",
                "- Outcome: what the user ultimately wants to understand or change.",
                "- Incidental instructions: details about tools, process, output, or how the agent should work.",
                "",
                "Title the durable subject and desired outcome. Discard incidental instructions.",
                "Prioritize user requests over assistant discoveries. Preserve the original subject until the user clearly changes goals.",
                "",
                "Editorial rules:",
                "- Use 3 to 8 words and a compact noun phrase or clear action phrase.",
                "- Capture the umbrella goal when the request lists several symptoms or steps.",
                "- Name the product change, not a plan, report, branch, commit, PR, test run, or monitoring step used to produce it.",
                "- Exclude models, subagents, tools, and output formats unless they are themselves the topic.",
                "- For reviews, name what is being reviewed and the relevant concern.",
                "- For research, name the question domain rather than the research process.",
                "- Do not claim the work is complete or merely copy and truncate the request.",
                "- Avoid repository names already visible in the workspace metadata, quotes, labels, filler, and trailing punctuation.",
                "",
                "Workspace metadata:",
                "<workspace>",
                "{{repository_context}}",
                "</workspace>",
                "",
                "Conversation:",
                "<conversation>",
                "{{conversation}}",
                "</conversation>",
                "",
                "Current title: {{current_name}}",
                "Naming phase: {{reason}}",
            ].join("\n"),
            minLength: 1,
            "x-control": "textarea",
            description:
                "Prompt used by the picker. Available placeholders are {{repository_context}}, {{conversation}}, {{current_name}}, {{cwd}}, and {{reason}}.",
        }),
        nameConstraints: Type.Object(
            {
                minLength: Type.Integer({
                    default: 6,
                    minimum: 1,
                    description: "Minimum number of characters in a name returned by the picker.",
                }),
                maxLength: Type.Integer({
                    default: 40,
                    minimum: 1,
                    description: "Maximum number of characters in a name returned by the picker.",
                }),
            },
            {
                additionalProperties: false,
                default: { minLength: 6, maxLength: 40 },
            },
        ),
    },
    { additionalProperties: false },
);

export type ExtensionSettingsDocument = StaticDecode<typeof settingsSchema>;

export const settingsInput = {
    id: "pi-autoname-session",
    title: "Pi Autoname Session",
    description: "Settings for Pi Autoname Session.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-autoname-session/HEAD/config.schema.json",
    schema: settingsSchema,
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
