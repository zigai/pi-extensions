import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type, type StaticDecode } from "typebox";

export const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Enable modal prompt search (arrow recall stays available).",
        }),
        defaultScope: Type.Union(
            [Type.Literal("session"), Type.Literal("project"), Type.Literal("global")],
            {
                default: "project",
                description:
                    "Scope used on each new picker opening; temporary scope cycling is not persisted.",
            },
        ),
    },
    { additionalProperties: false },
);

export type PromptHistorySettings = StaticDecode<typeof settingsSchema>;

export default {
    id: "pi-prompt-history",
    title: "Pi Prompt History",
    description: "Scoped user prompt search.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-prompt-history/config.schema.json",
    schema: settingsSchema,
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;
