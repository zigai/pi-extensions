import { Type, type StaticDecode } from "typebox";

export const DEFAULT_CYCLE_THINKING_BACKWARD_KEY: string | null = null;

export const KeymapTweaksConfigSchema = Type.Object(
    {
        cycleThinkingBackwardKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
            default: DEFAULT_CYCLE_THINKING_BACKWARD_KEY,
            description:
                "Additional keybinding to cycle thinking backward (e.g. 'alt+shift+tab'). Ctrl+Alt+Left is always available.",
        }),
    },
    { additionalProperties: false },
);

export type KeymapTweaksConfig = StaticDecode<typeof KeymapTweaksConfigSchema>;

export const extensionSettingsInput = {
    id: "pi-keymap-tweaks",
    title: "Pi Keymap Tweaks",
    description: "Settings for Pi editor keybindings and thinking navigation.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-keymap-tweaks/config.schema.json",
    schema: KeymapTweaksConfigSchema,
};

export default extensionSettingsInput;
