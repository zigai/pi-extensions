import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Show timestamps on messages.",
        }),
        format: Type.Union(
            [
                Type.Literal("auto"),
                Type.Literal("time-only"),
                Type.Literal("date-time"),
                Type.Literal("relative"),
            ],
            {
                default: "auto",
                description:
                    "Timestamp format: auto shows time today and date and time on other days; time-only, date-time, or relative always use that format.",
            },
        ),
        assistantPlacement: Type.Union(
            [Type.Literal("first-line"), Type.Literal("last-line"), Type.Literal("below")],
            {
                default: "first-line",
                description:
                    "Where response timestamps appear: first-line puts the time right of the first line; last-line puts it right of the last line; below adds a blank line and then a line with the time, model, duration, and tokens.",
            },
        ),
    },
    { additionalProperties: false },
);

const settingsInput = {
    id: "pi-message-timestamps",
    title: "Pi Message Timestamps",
    description: "Settings for message timestamps.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-message-timestamps/config.schema.json",
    schema: settingsSchema,
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
