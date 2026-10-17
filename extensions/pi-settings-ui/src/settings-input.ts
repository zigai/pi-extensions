import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type, type StaticDecode } from "typebox";

export const defaultHeaderSettings = {
    layout: "stacked",
    showHints: true,
    showFieldCounter: true,
} as const;

const headerSchema = Type.Object(
    {
        layout: Type.Enum(["stacked", "compact"], {
            default: defaultHeaderSettings.layout,
            description: "Separate navigation and scope, or combine them when space allows.",
        }),
        showHints: Type.Boolean({
            default: defaultHeaderSettings.showHints,
            description: "Show the tab-picker shortcut in the settings header.",
        }),
        showFieldCounter: Type.Boolean({
            default: defaultHeaderSettings.showFieldCounter,
            description: "Show the current field position in the settings header.",
        }),
    },
    { default: defaultHeaderSettings, additionalProperties: false },
);

export type SettingsHeaderSettings = StaticDecode<typeof headerSchema>;

export const settingsSchema = Type.Object(
    {
        header: headerSchema,
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
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-settings-ui/config.schema.json",
    schema: settingsSchema,
} as const satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
