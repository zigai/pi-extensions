import { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import {
    installLinkedMethodPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

export const DEFAULT_SELECTED_OPTION_PREFIX = "→ ";
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;
const SELECT_LIST_PATCH_KEY = Symbol.for(
    "zigai.pi-ui-tweaks.selected-option-prefix-select-list-patch",
);
const THEME_FG_PATCH_KEY = Symbol.for("zigai.pi-ui-tweaks.selected-option-prefix-theme-fg-patch");

type SelectListRenderTarget = {
    [SELECT_LIST_PATCH_KEY]?: SelectedOptionSelectListRecord;

    theme: {
        selectedText(text: string): string;
        description(text: string): string;
    };

    renderItem(
        item: SelectItem,
        isSelected: boolean,
        width: number,
        descriptionSingleLine: string | undefined,
        primaryColumnWidth: number,
    ): string;

    truncatePrimary(
        item: SelectItem,
        isSelected: boolean,
        maxWidth: number,
        columnWidth: number,
    ): string;
};

type ThemePrototype = {
    [THEME_FG_PATCH_KEY]?: SelectedOptionThemeRecord;
    fg(this: ThemeInstance, color: string, text: string): string;
};

type ThemeInstance = {
    fg(color: string, text: string): string;
};

type SelectListRenderView = {
    readonly renderItem?: unknown;
    readonly truncatePrimary?: unknown;
};

type ThemeFgView = {
    readonly fg?: unknown;
};

function normalizeSelectedOptionPrefix(prefix: string): string {
    if (prefix.length === 0) {
        return DEFAULT_SELECTED_OPTION_PREFIX;
    }

    if (/\s$/u.test(prefix)) {
        return prefix;
    }

    return `${prefix} `;
}

function warnSelectedOptionPrefixPatchUnavailable(): void {
    console.warn(
        "[pi-ui-tweaks] selected option prefix patch unavailable; Pi internals may have changed",
    );
}

function isSelectListRenderTarget(value: unknown): value is SelectListRenderTarget {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    // SAFETY: SelectListRenderView exposes only the two methods validated below.
    const view = value as SelectListRenderView;
    return typeof view.renderItem === "function" && typeof view.truncatePrimary === "function";
}

function isThemePrototype(value: unknown): value is ThemePrototype {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    // SAFETY: ThemeFgView exposes only the fg method validated below.
    const view = value as ThemeFgView;
    return typeof view.fg === "function";
}

export type SelectedOptionPrefixConfig = { readonly selectedOptionPrefix: string };

export type SelectedOptionPrefixHandle = {
    update(config: SelectedOptionPrefixConfig): void;
    dispose(): void;
};

type RenderItem = SelectListRenderTarget["renderItem"];

type SelectedOptionSelectListRecord = {
    readonly original: RenderItem;
    readonly patch: LinkedMethodPatchHandle<SelectListRenderTarget, Parameters<RenderItem>, string>;
    readonly handle: SelectedOptionPrefixHandle;
};

type SelectedOptionThemeRecord = {
    readonly original: ThemePrototype["fg"];
    readonly patch: LinkedMethodPatchHandle<ThemeInstance, [string, string], string>;
    readonly handle: SelectedOptionPrefixHandle;
};

let currentSelectedOptionConfig: SelectedOptionPrefixConfig = {
    selectedOptionPrefix: DEFAULT_SELECTED_OPTION_PREFIX,
};

function getUnselectedOptionPrefix(): string {
    return " ".repeat(Math.max(1, visibleWidth(currentSelectedOptionConfig.selectedOptionPrefix)));
}

/**
 * Installs an idempotent patch for Pi TUI's generic select list marker.
 */
export function installSelectedOptionPrefixSelectListPatch(
    config: SelectedOptionPrefixConfig,
    target?: SelectListRenderView | null,
): SelectedOptionPrefixHandle {
    let candidate = target;
    if (candidate === undefined && isSelectListRenderTarget(SelectList.prototype)) {
        candidate = SelectList.prototype;
    }

    if (!isSelectListRenderTarget(candidate)) {
        warnSelectedOptionPrefixPatchUnavailable();

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = candidate;
    const installed = prototype[SELECT_LIST_PATCH_KEY];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    currentSelectedOptionConfig = {
        selectedOptionPrefix: normalizeSelectedOptionPrefix(config.selectedOptionPrefix),
    };

    const patch = installLinkedMethodPatch(
        prototype,
        "renderItem",
        (_predecessor) =>
            function selectedOptionPrefixRenderItem(
                this: SelectListRenderTarget,
                item: SelectItem,
                isSelected: boolean,
                width: number,
                descriptionSingleLine: string | undefined,
                primaryColumnWidth: number,
            ): string {
                let prefix: string;
                if (isSelected) {
                    prefix = currentSelectedOptionConfig.selectedOptionPrefix;
                } else {
                    prefix = getUnselectedOptionPrefix();
                }

                const prefixWidth = visibleWidth(prefix);
                if (descriptionSingleLine !== undefined && width > 40) {
                    const effectivePrimaryColumnWidth = Math.max(
                        1,
                        Math.min(primaryColumnWidth, width - prefixWidth - 4),
                    );
                    const maxPrimaryWidth = Math.max(
                        1,
                        effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP,
                    );
                    const truncatedValue = this.truncatePrimary(
                        item,
                        isSelected,
                        maxPrimaryWidth,
                        effectivePrimaryColumnWidth,
                    );
                    const truncatedValueWidth = visibleWidth(truncatedValue);
                    const spacing = " ".repeat(
                        Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth),
                    );
                    const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
                    const remainingWidth = width - descriptionStart - 2;
                    if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
                        const truncatedDesc = truncateToWidth(
                            descriptionSingleLine,
                            remainingWidth,
                            "",
                        );
                        if (isSelected) {
                            return this.theme.selectedText(
                                `${prefix}${truncatedValue}${spacing}${truncatedDesc}`,
                            );
                        }

                        const descText = this.theme.description(spacing + truncatedDesc);
                        return prefix + truncatedValue + descText;
                    }
                }

                const maxWidth = width - prefixWidth - 2;
                const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
                if (isSelected) {
                    return this.theme.selectedText(`${prefix}${truncatedValue}`);
                }

                return prefix + truncatedValue;
            },
    );
    let disposed = false;
    const handle: SelectedOptionPrefixHandle = {
        update(next): void {
            if (!disposed)
                currentSelectedOptionConfig = {
                    selectedOptionPrefix: normalizeSelectedOptionPrefix(next.selectedOptionPrefix),
                };
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[SELECT_LIST_PATCH_KEY]?.handle === handle)
                delete prototype[SELECT_LIST_PATCH_KEY];
        },
    };

    prototype[SELECT_LIST_PATCH_KEY] = { original: patch.predecessor, patch, handle };
    return handle;
}

/** Installs or updates the Theme.fg selected-arrow patch. */
export async function installSelectedOptionPrefixThemePatch(
    config: SelectedOptionPrefixConfig,
): Promise<SelectedOptionPrefixHandle> {
    const prototype: unknown = Theme.prototype;
    if (!isThemePrototype(prototype)) {
        warnSelectedOptionPrefixPatchUnavailable();

        return { update(): void {}, dispose(): void {} };
    }

    const installed = prototype[THEME_FG_PATCH_KEY];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    currentSelectedOptionConfig = {
        selectedOptionPrefix: normalizeSelectedOptionPrefix(config.selectedOptionPrefix),
    };

    const patch = installLinkedMethodPatch(
        prototype,
        "fg",
        (predecessor) =>
            function selectedOptionPrefixFg(
                this: ThemeInstance,
                color: string,
                text: string,
            ): string {
                if (color === "accent" && text === DEFAULT_SELECTED_OPTION_PREFIX) {
                    return predecessor.call(
                        this,
                        color,
                        currentSelectedOptionConfig.selectedOptionPrefix,
                    );
                }

                return predecessor.call(this, color, text);
            },
    );
    let disposed = false;
    const handle: SelectedOptionPrefixHandle = {
        update(next): void {
            if (!disposed)
                currentSelectedOptionConfig = {
                    selectedOptionPrefix: normalizeSelectedOptionPrefix(next.selectedOptionPrefix),
                };
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[THEME_FG_PATCH_KEY]?.handle === handle)
                delete prototype[THEME_FG_PATCH_KEY];
        },
    };

    prototype[THEME_FG_PATCH_KEY] = { original: patch.predecessor, patch, handle };
    return handle;
}
