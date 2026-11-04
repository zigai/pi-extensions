import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type, type StaticDecode } from "typebox";

export const settingsSchema = Type.Object(
    {
        enabled: Type.Boolean({
            default: true,
            description: "Enable interactive input corrections.",
        }),
        policyFile: Type.String({
            default: "",
            description:
                "Personal policy JSON path. Empty disables corrections; ~/ expands to home, relative paths resolve beside this settings file.",
        }),
    },
    { additionalProperties: false },
);

export type InputCorrectionsHarnessSettings = StaticDecode<typeof settingsSchema>;

const settingsInput = {
    id: "pi-input-corrections",
    title: "Pi Input Corrections",
    description: "Conservative corrections for interactive prose input.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-input-corrections/config.schema.json",
    schema: settingsSchema,
    exampleSettings: { enabled: true, policyFile: "~/.config/input-corrections/policy.json" },
} satisfies ExtensionSettingsDefinitionInput<typeof settingsSchema>;

export default settingsInput;
