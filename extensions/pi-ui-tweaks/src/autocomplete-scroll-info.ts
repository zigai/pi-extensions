import {
    installLinkedRenderPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";
import { SelectList } from "@earendil-works/pi-tui";

const AUTOCOMPLETE_SCROLL_INFO_PATCH = Symbol.for(
    "zigai.pi-ui-tweaks.autocomplete-scroll-info-patch",
);

export type AutocompleteScrollInfoConfig = {
    readonly hideAutocompleteScrollInfo: boolean;
};

export type AutocompleteScrollInfoHandle = {
    update(config: AutocompleteScrollInfoConfig): void;
    dispose(): void;
};

type SelectListScrollInfoTarget = {
    filteredItems: readonly unknown[];
    maxVisible: number;
    render(this: SelectListScrollInfoTarget, width: number): string[];
    selectedIndex: number;
    [AUTOCOMPLETE_SCROLL_INFO_PATCH]?: AutocompleteScrollInfoPatchRecord;
};

type AutocompleteScrollInfoPatchRecord = {
    readonly original: SelectListScrollInfoTarget["render"];
    readonly patch: LinkedMethodPatchHandle<SelectListScrollInfoTarget, [number], string[]>;
    readonly handle: AutocompleteScrollInfoHandle;
};

type RenderView = {
    render?: SelectListScrollInfoTarget["render"];
    [AUTOCOMPLETE_SCROLL_INFO_PATCH]?: AutocompleteScrollInfoPatchRecord;
};

function hasRender(
    target: RenderView,
): target is RenderView & { render: SelectListScrollInfoTarget["render"] } {
    return typeof target.render === "function";
}

function warnAutocompleteScrollInfoPatchUnavailable(reason?: string): void {
    let suffix = "";
    if (reason !== undefined) suffix = `: ${reason}`;

    console.warn(
        `[pi-ui-tweaks] autocomplete scroll info patch unavailable; Pi internals may have changed${suffix}`,
    );
}

function shouldRenderScrollInfo(target: SelectListScrollInfoTarget): boolean {
    if (target.filteredItems.length === 0) return false;

    const startIndex = Math.max(
        0,
        Math.min(
            target.selectedIndex - Math.floor(target.maxVisible / 2),
            target.filteredItems.length - target.maxVisible,
        ),
    );
    const endIndex = Math.min(startIndex + target.maxVisible, target.filteredItems.length);
    return startIndex > 0 || endIndex < target.filteredItems.length;
}

function inactiveAutocompleteScrollInfoHandle(): AutocompleteScrollInfoHandle {
    return { update(): void {}, dispose(): void {} };
}

/** Installs or updates the autocomplete scroll/count-footer patch. */
export function installAutocompleteScrollInfoPatch(
    config: AutocompleteScrollInfoConfig,
    target: RenderView | null = SelectList.prototype,
): AutocompleteScrollInfoHandle {
    if (target === null) {
        warnAutocompleteScrollInfoPatchUnavailable();
        return inactiveAutocompleteScrollInfoHandle();
    }

    if (!hasRender(target)) {
        warnAutocompleteScrollInfoPatchUnavailable("missing render");
        return inactiveAutocompleteScrollInfoHandle();
    }

    const prototype = target;
    const installed = prototype[AUTOCOMPLETE_SCROLL_INFO_PATCH];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    const patch = installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function autocompleteScrollInfoRender(
                this: SelectListScrollInfoTarget,
                width: number,
            ): string[] {
                const lines = predecessor.call(this, width);
                if (!current.hideAutocompleteScrollInfo || !shouldRenderScrollInfo(this))
                    return lines;

                return lines.slice(0, -1);
            },
    );
    let disposed = false;
    const handle: AutocompleteScrollInfoHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            patch.dispose();

            if (prototype[AUTOCOMPLETE_SCROLL_INFO_PATCH]?.handle === handle) {
                delete prototype[AUTOCOMPLETE_SCROLL_INFO_PATCH];
            }
        },
    };

    prototype[AUTOCOMPLETE_SCROLL_INFO_PATCH] = { original: patch.predecessor, patch, handle };
    return handle;
}
