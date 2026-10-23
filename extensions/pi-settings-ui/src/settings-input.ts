import type { KeyId } from "@earendil-works/pi-tui";
import type { ExtensionSettingsDefinitionInput } from "@zigai/pi-extension-settings";
import { Type, type StaticDecode } from "typebox";

export const defaultTabPickerShortcut = "ctrl+p";

// Keep key validation generation-safe: Pi's runtime Key object must not be imported here.
const pickerModifiers = ["ctrl", "shift", "alt", "super"];
const pickerSpecialKeys = [
    "escape",
    "esc",
    "enter",
    "return",
    "tab",
    "space",
    "backspace",
    "delete",
    "insert",
    "clear",
    "home",
    "end",
    "pageUp",
    "pageDown",
    "up",
    "down",
    "left",
    "right",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
] satisfies readonly KeyId[];
const pickerSymbolKeys = "`-=[]\\;',./!@#$%^&*()_+|~{}:<>?";

function keyNamePattern(name: string): string {
    return name
        .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
        .replace(/[a-z]/giu, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
}

const pickerModifierPattern = pickerModifiers.map(keyNamePattern).join("|");
const pickerBasePattern = [
    "[a-zA-Z0-9]",
    ...pickerSpecialKeys.map(keyNamePattern),
    ...Array.from(pickerSymbolKeys, keyNamePattern),
].join("|");
const uniquePickerModifiersPattern = pickerModifiers
    .map((modifier) => {
        const pattern = keyNamePattern(modifier);
        return `(?!.*${pattern}\\+.*${pattern}\\+)`;
    })
    .join("");
const pickerShortcutPattern = `^\\s*${uniquePickerModifiersPattern}(?:(?:${pickerModifierPattern})\\+)*(?:${pickerBasePattern})\\s*$`;
const pickerShortcutRegex = new RegExp(pickerShortcutPattern, "u");

export function normalizePickerShortcut(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/pageup$/u, "pageUp")
        .replace(/pagedown$/u, "pageDown");
}

export function isPickerShortcut(value: string): value is KeyId {
    return value === normalizePickerShortcut(value) && pickerShortcutRegex.test(value);
}

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
        tabPickerShortcut: Type.String({
            default: defaultTabPickerShortcut,
            minLength: 1,
            pattern: pickerShortcutPattern,
            "x-control": "combobox",
            examples: ["ctrl+p", "ctrl+shift+p"],
            description:
                "Key for the settings-tab picker, using Pi key names such as ctrl+shift+p.",
        }),
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
