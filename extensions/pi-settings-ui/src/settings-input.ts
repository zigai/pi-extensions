import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type } from "typebox";

export const settingsSchema = Type.Object(
    {
        projectOverrides: Type.Boolean({
            default: true,
            description: "Let trusted projects have their own extension settings.",
        }),
    },
    { additionalProperties: false },
);

export const settingsInput = {
    id: "pi-settings-ui",
    title: "Pi Settings UI",
    description: "Settings for Pi Settings UI.",
    schemaId: "https://raw.githubusercontent.com/zigai/pi-settings-ui/HEAD/config.schema.json",
    schema: settingsSchema,
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
