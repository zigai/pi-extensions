import { StringEnum } from "@earendil-works/pi-ai";
import { defineExtensionSettings } from "@zigai/pi-extension-settings";
import { loadPiExtensionSettings, type PiSettingsContext } from "@zigai/pi-extension-settings/pi";
import { Type, type Static } from "typebox";

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

const settingsObjectSchema = Type.Object(
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

const settingsSchema = settingsObjectSchema;

export type ExtensionSettingsDocument = Static<typeof settingsObjectSchema>;

/** A resolved picker-model selection, parsed from the model setting. */
export type PickerModelReference =
    | { readonly type: "current" }
    | { readonly type: "specific"; readonly provider: string; readonly id: string };

export type ExtensionSettings = {
    readonly enabled: boolean;
    readonly initialNaming: {
        readonly enabled: boolean;
        readonly timing: ExtensionSettingsDocument["initialNaming"]["timing"];
        readonly trigger: ExtensionSettingsDocument["initialNaming"]["trigger"];
        readonly threshold: number;
    };
    readonly refreshNaming: {
        readonly enabled: boolean;
        readonly trigger: ExtensionSettingsDocument["refreshNaming"]["trigger"];
        readonly threshold: number;
    };
    readonly model: PickerModelReference;
    readonly reasoningEffort: ExtensionSettingsDocument["reasoningEffort"];
    readonly timeoutMs: number;
    readonly conversationScope: ExtensionSettingsDocument["conversationScope"];
    readonly prompt: string;
    readonly nameConstraints: {
        readonly minLength: number;
        readonly maxLength: number;
    };
};

type AutonameSessionSettingsLoadResult = {
    readonly settings: ExtensionSettings | undefined;
    readonly diagnostics: readonly {
        readonly severity: "error" | "warning";
        readonly message: string;
    }[];
};

/**
 * Parse the picker model setting into a tagged reference.
 *
 * "current" selects the session's active model; any other value must be
 * provider/model-id form. Returns undefined for malformed references so the
 * caller can report the configured value as unavailable.
 */
export function parsePickerModelReference(model: string): PickerModelReference | undefined {
    if (model.trim() !== model) {
        return undefined;
    }
    if (model === "current") {
        return { type: "current" };
    }

    const separatorIndex = model.indexOf("/");
    if (separatorIndex <= 0 || separatorIndex === model.length - 1 || /\s/.test(model)) {
        return undefined;
    }

    return {
        type: "specific",
        provider: model.slice(0, separatorIndex),
        id: model.slice(separatorIndex + 1),
    };
}

/** Render a parsed picker-model reference in its persisted setting form. */
export function formatPickerModelReference(reference: PickerModelReference): string {
    return reference.type === "current" ? "current" : `${reference.provider}/${reference.id}`;
}

export const extensionSettingsDefinition = defineExtensionSettings({
    id: "pi-autoname-session",
    title: "Pi Autoname Session",
    description: "Settings for Pi Autoname Session.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-autoname-session/HEAD/config.schema.json",
    schema: settingsSchema,
});

/**
 * Load resolved extension settings from Pi's global and trusted-project
 * settings layers, refreshing missing or stale generated schemas.
 */
export function loadAutonameSessionSettings(
    ctx: PiSettingsContext,
): AutonameSessionSettingsLoadResult {
    const loaded = loadPiExtensionSettings(extensionSettingsDefinition, ctx, {
        bundledSchema: {
            kind: "url",
            url: new URL("../config.schema.json", import.meta.url),
        },
    });
    if (loaded.settings.nameConstraints.minLength > loaded.settings.nameConstraints.maxLength) {
        return {
            settings: undefined,
            diagnostics: [
                ...loaded.diagnostics,
                {
                    severity: "error" as const,
                    message:
                        "Session naming is disabled because nameConstraints.minLength is greater than maxLength.",
                },
            ],
        };
    }

    const model = parsePickerModelReference(loaded.settings.model);
    if (model === undefined) {
        return {
            settings: undefined,
            diagnostics: [
                ...loaded.diagnostics,
                {
                    severity: "error" as const,
                    message:
                        'Session naming is disabled because model must be "current" or provider/model-id.',
                },
            ],
        };
    }

    return {
        settings: {
            enabled: loaded.settings.enabled,
            initialNaming: {
                enabled: loaded.settings.initialNaming.enabled,
                timing: loaded.settings.initialNaming.timing,
                trigger: loaded.settings.initialNaming.trigger,
                threshold: loaded.settings.initialNaming.threshold,
            },
            refreshNaming: {
                enabled: loaded.settings.refreshNaming.enabled,
                trigger: loaded.settings.refreshNaming.trigger,
                threshold: loaded.settings.refreshNaming.threshold,
            },
            model,
            reasoningEffort: loaded.settings.reasoningEffort,
            timeoutMs: loaded.settings.timeoutMs,
            conversationScope: loaded.settings.conversationScope,
            prompt: loaded.settings.prompt,
            nameConstraints: {
                minLength: loaded.settings.nameConstraints.minLength,
                maxLength: loaded.settings.nameConstraints.maxLength,
            },
        },
        diagnostics: loaded.diagnostics,
    };
}

export default extensionSettingsDefinition;
