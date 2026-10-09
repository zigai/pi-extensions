import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import {
    installLinkedMethodPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const MODEL_SELECTOR_PROVIDER_BADGE_PATCH_KEY = Symbol.for(
    "zigai.pi-ui-tweaks.model-selector-provider-badge-patch",
);

type ModelItemLike = {
    readonly id: string;
    readonly provider: string;
};

type TextLike = {
    text: string;
    setText(text: string): void;
};

type ContainerLike = {
    children?: unknown;
};

type ModelSelectorProviderBadgeTarget = {
    [MODEL_SELECTOR_PROVIDER_BADGE_PATCH_KEY]?: ModelSelectorProviderBadgeRecord;
    filteredModels?: unknown;
    listContainer?: ContainerLike;
    selectedIndex?: unknown;
    updateList?: (this: ModelSelectorProviderBadgeTarget) => void;
};

type ThemeInstance = {
    fg(color: string, text: string): string;
};

type ModelItemView = {
    readonly id?: unknown;
    readonly provider?: unknown;
};

type TextLikeView = {
    readonly text?: unknown;
    readonly setText?: unknown;
};

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function warnModelSelectorProviderBadgePatchUnavailable(cause?: unknown): void {
    let suffix = "";
    if (cause instanceof Error && cause.message.length > 0) {
        suffix = `: ${cause.message}`;
    }

    console.warn(
        `[pi-ui-tweaks] selected model provider badge patch unavailable; Pi internals may have changed${suffix}`,
    );
}

function isModelItemLike(value: unknown): value is ModelItemLike {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The object guard permits reading only the optional item fields; both are
    // validated below before the value is exposed as ModelItemLike.
    const view = value as ModelItemView;
    return typeof view.id === "string" && typeof view.provider === "string";
}

function isTextLike(value: unknown): value is TextLike {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The object guard permits reading only the optional text fields; both are
    // validated below before the value is exposed as TextLike.
    const view = value as TextLikeView;
    return typeof view.text === "string" && typeof view.setText === "function";
}

function hasSelectedIndex(
    target: ModelSelectorProviderBadgeTarget,
): target is ModelSelectorProviderBadgeTarget & { readonly selectedIndex: number } {
    return typeof target.selectedIndex === "number";
}

function hasUpdateList(value: unknown): value is ModelSelectorProviderBadgeTarget & {
    updateList: UpdateList;
} {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return false;
    }

    return "updateList" in value && typeof value.updateList === "function";
}

function getDefaultModelSelectorTarget(): ModelSelectorProviderBadgeTarget | undefined {
    const prototype = ModelSelectorComponent.prototype;
    if (!hasUpdateList(prototype)) return undefined;
    return prototype;
}

function getSelectedModelItem(target: ModelSelectorProviderBadgeTarget): ModelItemLike | undefined {
    if (!hasSelectedIndex(target)) return undefined;

    const selectedIndex = target.selectedIndex;
    const filteredModels = target.filteredModels;
    if (!isUnknownArray(filteredModels)) return undefined;

    const selectedModel = filteredModels[selectedIndex];
    if (!isModelItemLike(selectedModel)) return undefined;
    return selectedModel;
}

function getListChildren(target: ModelSelectorProviderBadgeTarget): readonly unknown[] {
    const children = target.listContainer?.children;
    if (!isUnknownArray(children)) return [];
    return children;
}

export type ModelSelectorProviderBadgeConfig = {
    readonly highlightSelectedModelProvider: boolean;
};

export type ModelSelectorProviderBadgeHandle = {
    update(config: ModelSelectorProviderBadgeConfig): void;
    dispose(): void;
};

type UpdateList = (this: ModelSelectorProviderBadgeTarget) => void;

type ModelSelectorProviderBadgeRecord = {
    readonly original: UpdateList;
    readonly patch: LinkedMethodPatchHandle<ModelSelectorProviderBadgeTarget, [], void>;
    readonly handle: ModelSelectorProviderBadgeHandle;
};

let currentProviderBadgeConfig: ModelSelectorProviderBadgeConfig = {
    highlightSelectedModelProvider: true,
};

function highlightSelectedProviderBadge(
    target: ModelSelectorProviderBadgeTarget,
    theme: ThemeInstance,
): void {
    if (!currentProviderBadgeConfig.highlightSelectedModelProvider) return;

    const selectedModel = getSelectedModelItem(target);
    if (selectedModel === undefined) return;

    const selectedModelText = theme.fg("accent", selectedModel.id);
    const mutedProviderBadge = theme.fg("muted", `[${selectedModel.provider}]`);
    const accentProviderBadge = theme.fg("accent", `[${selectedModel.provider}]`);

    for (const child of getListChildren(target)) {
        if (!isTextLike(child)) continue;

        const text = child.text;
        if (!text.includes(selectedModelText) || !text.includes(mutedProviderBadge)) continue;
        child.setText(text.replace(mutedProviderBadge, accentProviderBadge));

        return;
    }
}

/** Installs or updates the selected-provider badge patch. */
export async function installModelSelectorProviderBadgePatch(
    config: ModelSelectorProviderBadgeConfig,
    target?: ModelSelectorProviderBadgeTarget | null,
    providedTheme?: ThemeInstance | (() => ThemeInstance | undefined),
): Promise<ModelSelectorProviderBadgeHandle> {
    let prototype = target;
    if (prototype === undefined) prototype = getDefaultModelSelectorTarget();

    if (prototype === undefined || !hasUpdateList(prototype)) {
        warnModelSelectorProviderBadgePatchUnavailable(new Error("missing updateList"));

        return { update(): void {}, dispose(): void {} };
    }

    const installed = prototype[MODEL_SELECTOR_PROVIDER_BADGE_PATCH_KEY];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    if (providedTheme === undefined) {
        warnModelSelectorProviderBadgePatchUnavailable(new Error("missing active theme"));

        return { update(): void {}, dispose(): void {} };
    }

    const getTheme = (): ThemeInstance | undefined => {
        if (typeof providedTheme === "function") return providedTheme();
        return providedTheme;
    };

    currentProviderBadgeConfig = config;

    const patch = installLinkedMethodPatch(
        prototype,
        "updateList",
        (predecessor) =>
            function selectedProviderBadgeUpdateList(this: ModelSelectorProviderBadgeTarget): void {
                predecessor.call(this);

                const theme = getTheme();
                if (theme !== undefined && typeof theme.fg === "function") {
                    highlightSelectedProviderBadge(this, theme);
                }
            },
    );
    let disposed = false;
    const handle: ModelSelectorProviderBadgeHandle = {
        update(next): void {
            if (!disposed) currentProviderBadgeConfig = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[MODEL_SELECTOR_PROVIDER_BADGE_PATCH_KEY]?.handle === handle) {
                delete prototype[MODEL_SELECTOR_PROVIDER_BADGE_PATCH_KEY];
            }
        },
    };

    prototype[MODEL_SELECTOR_PROVIDER_BADGE_PATCH_KEY] = {
        original: patch.predecessor,
        patch,
        handle,
    };

    return handle;
}
