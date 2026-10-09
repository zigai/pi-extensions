import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { matchesKey } from "@earendil-works/pi-tui";

function isString(value: unknown): value is string {
    return typeof value === "string";
}

export function cycleThinkingLevelBackward(
    model: Model<Api> | undefined,
    currentLevel: ThinkingLevel | undefined,
    setThinkingLevel: (level: ThinkingLevel) => void,
): ThinkingLevel | undefined {
    if (model === undefined || !model.reasoning) {
        return undefined;
    }

    const levels = getSupportedThinkingLevels(model);
    if (levels.length === 0) {
        return undefined;
    }

    let currentIndex = -1;
    if (currentLevel !== undefined) {
        currentIndex = levels.indexOf(currentLevel);
    }

    let nextIndex: number;
    if (currentIndex <= 0) {
        nextIndex = levels.length - 1;
    } else {
        nextIndex = currentIndex - 1;
    }

    const nextLevel = levels[nextIndex];
    setThinkingLevel(nextLevel);

    return nextLevel;
}

export function matchesKeyChord(data: string, chord: string): boolean {
    const normalized = chord.trim().toLowerCase();
    if (normalized.length === 0) {
        return false;
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Both arguments are strings and Pi's installed matchesKey implementation accepts arbitrary identifier strings and returns boolean; its KeyId declaration cannot express that runtime grammar.
    const match = matchesKey as (data: string, keyId: string) => boolean;
    if (match(data, normalized)) {
        return true;
    }

    if (
        normalized === "alt+shift+tab" &&
        (data === "\x1b\x1b[Z" || data === "\x1b[1;3Z" || data === "\x1b[9;4u")
    ) {
        return true;
    }

    return false;
}

export function isThinkingBackwardKeyMatch(
    data: string,
    configuredKey: string | null | undefined,
    userKeybinding: string | readonly string[] | undefined,
): boolean {
    if (configuredKey !== null && configuredKey !== undefined && configuredKey.length > 0) {
        if (matchesKeyChord(data, configuredKey)) {
            return true;
        }
    }

    if (userKeybinding !== undefined) {
        if (Array.isArray(userKeybinding)) {
            for (const chord of userKeybinding) {
                if (isString(chord) && matchesKeyChord(data, chord)) {
                    return true;
                }
            }
        } else if (isString(userKeybinding) && matchesKeyChord(data, userKeybinding)) {
            return true;
        }
    }

    return false;
}
