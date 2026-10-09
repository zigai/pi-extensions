import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ShortcutId = Parameters<ExtensionAPI["registerShortcut"]>[0];

const SHORTCUT_SPECIAL_KEYS = new Set([
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
]);

const SHORTCUT_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SHORTCUT_CHARACTER = /^[a-z0-9`\-=[\]\\;'.,/!@#$%^&*()_+|~{}:<>?]$/i;

export function isShortcutId(value: string): value is ShortcutId {
    let base = value;
    let modifiers: string[] = [];

    if (value !== "+") {
        if (value.endsWith("++")) {
            const modifierPrefix = value.slice(0, -2);
            if (modifierPrefix.length === 0) return false;

            base = "+";
            modifiers = modifierPrefix.split("+");
        } else {
            const parts = value.split("+");
            const parsedBase = parts.pop();
            if (parsedBase === undefined) return false;

            base = parsedBase;
            modifiers = parts;
        }
    }

    if (!SHORTCUT_SPECIAL_KEYS.has(base) && !SHORTCUT_CHARACTER.test(base)) return false;
    if (modifiers.some((modifier) => !SHORTCUT_MODIFIERS.has(modifier))) return false;
    return new Set(modifiers).size === modifiers.length;
}
