import { ALL_THINKING_LEVELS } from "./thinking-levels.ts";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionStartEvent, ThemeColor } from "@earendil-works/pi-coding-agent";

export const DEFAULT_MODE_ORDER = ["default"] as const;
export const CUSTOM_MODE_NAME = "custom" as const;

export type ModeName = string;

export type ModeSpec = {
    provider?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;

    /**
     * Optional theme color token to use for the editor border.
     * If unset, the default editor border is used unless thinking-derived
     * border colors are enabled in settings.
     */
    color?: ThemeColor;
};

export type DefaultModelSpec = {
    provider: string;
    modelId: string;
    thinkingLevel?: ThinkingLevel;
};

export type ModesFile = {
    version: 1;
    currentMode: ModeName;
    defaultModel?: DefaultModelSpec;
    modes: Record<ModeName, ModeSpec>;
};

export type ModeSpecPatch = {
    provider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    color?: ThemeColor | null;
};

export type ModesPatch = {
    currentMode?: ModeName;
    defaultModel?: DefaultModelSpec | null;
    modes?: Record<ModeName, ModeSpecPatch | null>;
};

const MODE_COLOR_TOKENS: ReadonlySet<string> = new Set([
    "accent",
    "border",
    "borderAccent",
    "borderMuted",
    "success",
    "error",
    "warning",
    "muted",
    "dim",
    "text",
    "thinkingText",
    "userMessageText",
    "customMessageText",
    "customMessageLabel",
    "toolTitle",
    "toolOutput",
    "mdHeading",
    "mdLink",
    "mdLinkUrl",
    "mdCode",
    "mdCodeBlock",
    "mdCodeBlockBorder",
    "mdQuote",
    "mdQuoteBorder",
    "mdHr",
    "mdListBullet",
    "toolDiffAdded",
    "toolDiffRemoved",
    "toolDiffContext",
    "syntaxComment",
    "syntaxKeyword",
    "syntaxFunction",
    "syntaxVariable",
    "syntaxString",
    "syntaxNumber",
    "syntaxType",
    "syntaxOperator",
    "syntaxPunctuation",
    "thinkingOff",
    "thinkingMinimal",
    "thinkingLow",
    "thinkingMedium",
    "thinkingHigh",
    "thinkingXhigh",
    "bashMode",
]);

export function cloneModeSpec(spec: ModeSpec): ModeSpec {
    const cloned: ModeSpec = {};
    if (spec.provider !== undefined) cloned.provider = spec.provider;
    if (spec.modelId !== undefined) cloned.modelId = spec.modelId;
    if (spec.thinkingLevel !== undefined) cloned.thinkingLevel = spec.thinkingLevel;
    if (spec.color !== undefined) cloned.color = spec.color;

    return cloned;
}

export function cloneDefaultModelSpec(spec: DefaultModelSpec): DefaultModelSpec {
    const cloned: DefaultModelSpec = {
        provider: spec.provider,
        modelId: spec.modelId,
    };
    if (spec.thinkingLevel !== undefined) cloned.thinkingLevel = spec.thinkingLevel;

    return cloned;
}

export function cloneModesFile(file: ModesFile): ModesFile {
    const modes: Record<string, ModeSpec> = {};
    for (const [name, spec] of Object.entries(file.modes)) {
        modes[name] = cloneModeSpec(spec);
    }

    const cloned: ModesFile = {
        version: file.version,
        currentMode: file.currentMode,
        modes,
    };
    if (file.defaultModel !== undefined) {
        cloned.defaultModel = cloneDefaultModelSpec(file.defaultModel);
    }

    return cloned;
}

export function modeSpec(modes: Record<string, ModeSpec>, name: string): ModeSpec | undefined {
    if (Object.hasOwn(modes, name)) return modes[name];
    return undefined;
}

export function computeModesPatch(
    base: ModesFile,
    next: ModesFile,
    includeCurrentMode: boolean,
): ModesPatch | null {
    const patch: ModesPatch = {};

    if (includeCurrentMode && base.currentMode !== next.currentMode) {
        patch.currentMode = next.currentMode;
    }

    if (base.defaultModel === undefined && next.defaultModel !== undefined) {
        patch.defaultModel = cloneDefaultModelSpec(next.defaultModel);
    } else if (base.defaultModel !== undefined && next.defaultModel === undefined) {
        patch.defaultModel = null;
    } else if (base.defaultModel !== undefined && next.defaultModel !== undefined) {
        if (
            base.defaultModel.provider !== next.defaultModel.provider ||
            base.defaultModel.modelId !== next.defaultModel.modelId ||
            base.defaultModel.thinkingLevel !== next.defaultModel.thinkingLevel
        ) {
            patch.defaultModel = cloneDefaultModelSpec(next.defaultModel);
        }
    }

    const keys = new Set([...Object.keys(base.modes), ...Object.keys(next.modes)]);

    const modesPatch: Record<string, ModeSpecPatch | null> = {};

    for (const key of keys) {
        const before = modeSpec(base.modes, key);
        const after = modeSpec(next.modes, key);
        if (after === undefined) {
            if (before !== undefined) modesPatch[key] = null;
            continue;
        }

        if (before === undefined) {
            modesPatch[key] = { ...after };
            continue;
        }

        const diff: ModeSpecPatch = {};
        if (before.provider !== after.provider) {
            diff.provider = after.provider ?? null;
        }

        if (before.modelId !== after.modelId) {
            diff.modelId = after.modelId ?? null;
        }

        if (before.thinkingLevel !== after.thinkingLevel) {
            diff.thinkingLevel = after.thinkingLevel ?? null;
        }

        if (before.color !== after.color) {
            diff.color = after.color ?? null;
        }

        if (Object.keys(diff).length > 0) {
            modesPatch[key] = diff;
        }
    }

    if (Object.keys(modesPatch).length > 0) {
        patch.modes = modesPatch;
    }

    if (
        patch.modes === undefined &&
        patch.currentMode === undefined &&
        patch.defaultModel === undefined
    ) {
        return null;
    }

    return patch;
}

export function applyModesPatch(target: ModesFile, patch: ModesPatch): void {
    if (patch.currentMode !== undefined) {
        target.currentMode = patch.currentMode;
    }

    if (patch.defaultModel !== undefined) {
        if (patch.defaultModel === null) {
            delete target.defaultModel;
        } else {
            target.defaultModel = cloneDefaultModelSpec(patch.defaultModel);
        }
    }

    if (patch.modes === undefined) return;

    for (const [mode, specPatch] of Object.entries(patch.modes)) {
        if (specPatch === null) {
            delete target.modes[mode];
            continue;
        }

        const targetSpec = modeSpec(target.modes, mode) ?? {};
        target.modes[mode] = targetSpec;

        if ("provider" in specPatch) {
            if (specPatch.provider === null || specPatch.provider === undefined) {
                delete targetSpec.provider;
            } else {
                targetSpec.provider = specPatch.provider;
            }
        }

        if ("modelId" in specPatch) {
            if (specPatch.modelId === null || specPatch.modelId === undefined) {
                delete targetSpec.modelId;
            } else {
                targetSpec.modelId = specPatch.modelId;
            }
        }

        if ("thinkingLevel" in specPatch) {
            if (specPatch.thinkingLevel === null || specPatch.thinkingLevel === undefined) {
                delete targetSpec.thinkingLevel;
            } else {
                targetSpec.thinkingLevel = specPatch.thinkingLevel;
            }
        }

        if ("color" in specPatch) {
            if (specPatch.color === null || specPatch.color === undefined) {
                delete targetSpec.color;
            } else {
                targetSpec.color = specPatch.color;
            }
        }
    }
}

function isModeColor(value: string): value is NonNullable<ModeSpec["color"]> {
    return MODE_COLOR_TOKENS.has(value);
}

export function parseModeColor(value: string): ModeSpec["color"] | undefined {
    if (isModeColor(value)) return value;
    return undefined;
}

export function createDefaultModes(base: ModeSpec): ModesFile {
    return {
        version: 1,
        currentMode: "default",
        modes: {
            default: { ...base },
            fast: { ...base, thinkingLevel: "off" },
        },
    };
}

export function ensureDefaultModeEntries(file: ModesFile, fallbackMode: ModeSpec): void {
    if (Object.keys(file.modes).length === 0) {
        file.modes = createDefaultModes(fallbackMode).modes;
    }

    if (file.currentMode === CUSTOM_MODE_NAME) {
        file.currentMode = "";
    }

    if (
        file.currentMode.length === 0 ||
        !(file.currentMode in file.modes) ||
        file.currentMode === CUSTOM_MODE_NAME
    ) {
        const first = Object.keys(file.modes).find((name) => name !== CUSTOM_MODE_NAME);
        if (modeSpec(file.modes, "default") !== undefined) {
            file.currentMode = "default";
        } else if (first !== undefined && first.length > 0) {
            file.currentMode = first;
        } else {
            file.currentMode = "default";
        }
    }
}

export function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
    return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

function modeUsesModel(spec: ModeSpec | undefined, provider: string, modelId: string): boolean {
    return spec?.provider === provider && spec.modelId === modelId;
}

export function findModeForModel(
    modes: Record<string, ModeSpec>,
    provider: string | undefined,
    modelId: string | undefined,
): string | null {
    if (provider === undefined || modelId === undefined) return null;

    for (const name of orderedModeNames(modes)) {
        if (modeUsesModel(modes[name], provider, modelId)) return name;
    }

    return null;
}

type SessionEntryKind = {
    type: string;
};

export function shouldApplyDefaultModel(
    event: Pick<SessionStartEvent, "reason">,
    entries: readonly SessionEntryKind[],
): boolean {
    if (event.reason === "new") return true;
    if (event.reason !== "startup") return false;

    // Pi restores a startup session only when it has conversation messages.
    // Fresh sessions may already contain model, thinking, tool, or extension metadata.
    return !entries.some((entry) => entry.type === "message");
}

export function isDefaultModeName(name: string): boolean {
    return DEFAULT_MODE_ORDER.some((defaultName) => defaultName === name);
}

export function normalizeModeNameInput(name: string | undefined): string {
    return (name ?? "").trim();
}

export function getModeThinkingLevels(model: Model<Api> | undefined): readonly ThinkingLevel[] {
    if (model === undefined) return ALL_THINKING_LEVELS;
    return getSupportedThinkingLevels(model);
}
