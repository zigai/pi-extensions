import { Type, type StaticDecode } from "typebox";

export const DEFAULT_CYCLE_THINKING_BACKWARD_KEY: string | null = null;
export const DEFAULT_CONTINUE_LISTS = true;
export const DEFAULT_UNDO_EARLY_CANCEL = true;

export const KeymapTweaksConfigSchema = Type.Object(
    {
        continueLists: Type.Boolean({
            default: DEFAULT_CONTINUE_LISTS,
            description:
                "Start the next list item when inserting a newline on a numbered or bullet list line. A newline on an empty item ends the list.",
        }),
        undoEarlyCancel: Type.Boolean({
            default: DEFAULT_UNDO_EARLY_CANCEL,
            description:
                "Cancelling with the interrupt key before the response shows any output removes the prompt from the session and puts its text back in the editor.",
        }),
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
