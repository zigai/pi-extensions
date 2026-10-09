import { Editor, getKeybindings } from "@earendil-works/pi-tui";

import {
    installLinkedMethodPatch,
    installLinkedRenderPatch,
    type LinkedMethodPatchHandle,
} from "@zigai/pi-extension-internals";

const AUTOCOMPLETE_POSITION_PATCHED = Symbol.for("zigai.pi-ui-tweaks.autocomplete-position-patch");
const AUTOCOMPLETE_RENDERED_ABOVE = Symbol.for("zigai.pi-ui-tweaks.autocomplete-rendered-above");
const AUTOCOMPLETE_RESTORE_RENDER_PENDING = Symbol.for(
    "zigai.pi-ui-tweaks.autocomplete-restore-render-pending",
);
const AUTOCOMPLETE_SKIP_RESTORE_ON_CLOSE = Symbol.for(
    "zigai.pi-ui-tweaks.autocomplete-skip-restore-on-close",
);

function blankSpacerLine(width: number): string {
    const visibleSpacer = "\x1b[0m \x1b[0m";
    if (width <= 1) {
        return visibleSpacer;
    }

    return visibleSpacer + " ".repeat(width - 1);
}

type AutocompleteListLike = {
    getSelectedItem?(): AutocompleteSelectedItem | null;
    render(width: number): string[];
};

type AutocompleteSelectedItem = object;

type AutocompletePositionPatchTarget = {
    render(width: number): string[];
    autocompleteState?: unknown;
    autocompleteList?: AutocompleteListLike;
    autocompletePrefix?: string;
    autocompleteProvider?: unknown;
    handleInput?(data: string): void;
    paddingX?: number;
    tui?: { requestRender(force?: boolean): void };
    [AUTOCOMPLETE_POSITION_PATCHED]?: AutocompletePositionPatchRecord;
    [AUTOCOMPLETE_RENDERED_ABOVE]?: true;
    [AUTOCOMPLETE_RESTORE_RENDER_PENDING]?: true;
    [AUTOCOMPLETE_SKIP_RESTORE_ON_CLOSE]?: true;
};

type PrototypeRenderView = {
    render?: (this: AutocompletePositionPatchTarget, width: number) => string[];
    [AUTOCOMPLETE_POSITION_PATCHED]?: AutocompletePositionPatchRecord;
};

type PrototypeHandleInputView = {
    handleInput?: (this: AutocompletePositionPatchTarget, data: string) => void;
};

type AutocompleteHandleInputTarget = {
    handleInput(this: AutocompletePositionPatchTarget, data: string): void;
};

function hasRender(
    target: PrototypeRenderView & PrototypeHandleInputView,
): target is PrototypeRenderView &
    PrototypeHandleInputView & {
        render: (this: AutocompletePositionPatchTarget, width: number) => string[];
    } {
    return typeof target.render === "function";
}

function hasHandleInput(
    target: PrototypeHandleInputView,
): target is PrototypeHandleInputView & AutocompleteHandleInputTarget {
    return typeof target.handleInput === "function";
}

function warnAutocompletePositionPatchUnavailable(reason?: string): void {
    let suffix = "";
    if (reason !== undefined) {
        suffix = `: ${reason}`;
    }

    console.warn(
        `[pi-ui-tweaks] autocomplete position patch unavailable; Pi internals may have changed${suffix}`,
    );
}

function getAutocompleteLineCount(target: AutocompletePositionPatchTarget, width: number): number {
    const autocompleteList = target.autocompleteList;
    if (target.autocompleteState === null || autocompleteList === undefined) {
        return 0;
    }

    const rawPaddingX = target.paddingX ?? 0;
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const paddingX = Math.min(rawPaddingX, maxPadding);
    const contentWidth = Math.max(1, width - paddingX * 2);
    return autocompleteList.render(contentWidth).length;
}

function requestDeferredForceRender(target: AutocompletePositionPatchTarget): void {
    const tui = target.tui;
    if (tui === undefined) return;
    if (target[AUTOCOMPLETE_RESTORE_RENDER_PENDING] === true) return;

    target[AUTOCOMPLETE_RESTORE_RENDER_PENDING] = true;
    setImmediate(() => {
        target[AUTOCOMPLETE_RESTORE_RENDER_PENDING] = undefined;
        tui.requestRender(true);
    });
}

function getSelectedAutocompleteItem(
    target: AutocompletePositionPatchTarget,
): AutocompleteSelectedItem | undefined {
    const autocompleteList = target.autocompleteList;
    if (autocompleteList === undefined) return undefined;

    if (typeof autocompleteList.getSelectedItem !== "function") return undefined;

    const selectedItem = autocompleteList.getSelectedItem();
    if (selectedItem === null) return undefined;
    return selectedItem;
}

function isAutocompleteCompletion(
    target: AutocompletePositionPatchTarget,
    data: string,
    config: AutocompletePositionConfig,
): boolean {
    if (!config.autocompleteAboveInput) return false;
    if (target.autocompleteState === null || target.autocompleteState === undefined) return false;
    if (target.autocompleteProvider === undefined) return false;

    if (
        !getKeybindings().matches(data, "tui.input.tab") &&
        !getKeybindings().matches(data, "tui.select.confirm")
    ) {
        return false;
    }

    return getSelectedAutocompleteItem(target) !== undefined;
}

export type AutocompletePositionConfig = {
    readonly autocompleteAboveInput: boolean;
    readonly restoreContentAfterAutocompleteClose: boolean;
};

export type AutocompletePositionHandle = {
    update(config: AutocompletePositionConfig): void;
    dispose(): void;
};

type AutocompletePositionPatchRecord = {
    readonly original: AutocompletePositionPatchTarget["render"];

    readonly renderPatch: LinkedMethodPatchHandle<
        AutocompletePositionPatchTarget,
        [number],
        string[]
    >;

    readonly inputPatch?: LinkedMethodPatchHandle<AutocompletePositionPatchTarget, [string], void>;
    readonly handle: AutocompletePositionHandle;
};

/**
 * Installs an idempotent patch that moves editor autocomplete rows above the input box.
 */
export function installAutocompletePositionPatch(
    config: AutocompletePositionConfig,
    target: (PrototypeRenderView & PrototypeHandleInputView) | null = Editor.prototype,
): AutocompletePositionHandle {
    if (target === null) {
        warnAutocompletePositionPatchUnavailable();

        return { update(): void {}, dispose(): void {} };
    }

    if (!hasRender(target)) {
        warnAutocompletePositionPatchUnavailable("missing render");

        return { update(): void {}, dispose(): void {} };
    }

    const prototype = target;
    const installed = prototype[AUTOCOMPLETE_POSITION_PATCHED];
    if (installed !== undefined) {
        installed.handle.update(config);
        return installed.handle;
    }

    let current = config;
    let inputPatch:
        | LinkedMethodPatchHandle<AutocompletePositionPatchTarget, [string], void>
        | undefined;
    if (hasHandleInput(prototype)) {
        const inputTarget = prototype;

        inputPatch = installLinkedMethodPatch(
            inputTarget,
            "handleInput",
            (predecessor) =>
                function autocompletePositionHandleInput(
                    this: AutocompletePositionPatchTarget,
                    data: string,
                ): void {
                    if (isAutocompleteCompletion(this, data, current)) {
                        this[AUTOCOMPLETE_SKIP_RESTORE_ON_CLOSE] = true;
                    }

                    let completed = false;

                    try {
                        predecessor.call(this, data);
                        completed = true;
                    } finally {
                        if (
                            !completed ||
                            (this.autocompleteState !== null &&
                                this.autocompleteState !== undefined)
                        ) {
                            this[AUTOCOMPLETE_SKIP_RESTORE_ON_CLOSE] = undefined;
                        }
                    }
                },
        );
    }

    const renderPatch = installLinkedRenderPatch(
        prototype,
        (predecessor) =>
            function autocompletePositionRender(
                this: AutocompletePositionPatchTarget,
                width: number,
            ): string[] {
                const result = predecessor.call(this, width);
                const patchState = current;
                if (!patchState.autocompleteAboveInput) {
                    if (this[AUTOCOMPLETE_RENDERED_ABOVE] === true) {
                        this[AUTOCOMPLETE_RENDERED_ABOVE] = undefined;

                        if (patchState.restoreContentAfterAutocompleteClose) {
                            requestDeferredForceRender(this);
                        }
                    }

                    return result;
                }

                const autocompleteLineCount = getAutocompleteLineCount(this, width);
                if (autocompleteLineCount === 0 || autocompleteLineCount >= result.length) {
                    if (this[AUTOCOMPLETE_RENDERED_ABOVE] === true) {
                        this[AUTOCOMPLETE_RENDERED_ABOVE] = undefined;

                        const skipRestore = this[AUTOCOMPLETE_SKIP_RESTORE_ON_CLOSE] === true;

                        this[AUTOCOMPLETE_SKIP_RESTORE_ON_CLOSE] = undefined;

                        if (patchState.restoreContentAfterAutocompleteClose && !skipRestore) {
                            requestDeferredForceRender(this);
                        }
                    }

                    return result;
                }

                const editorLines = result.slice(0, result.length - autocompleteLineCount);
                const autocompleteLines = result.slice(result.length - autocompleteLineCount);

                this[AUTOCOMPLETE_RENDERED_ABOVE] = true;
                return [blankSpacerLine(width), ...autocompleteLines, ...editorLines];
            },
    );
    let disposed = false;
    const handle: AutocompletePositionHandle = {
        update(next): void {
            if (!disposed) current = next;
        },
        dispose(): void {
            if (disposed) return;

            disposed = true;
            renderPatch.dispose();
            inputPatch?.dispose();

            if (prototype[AUTOCOMPLETE_POSITION_PATCHED]?.handle === handle) {
                delete prototype[AUTOCOMPLETE_POSITION_PATCHED];
            }
        },
    };

    prototype[AUTOCOMPLETE_POSITION_PATCHED] = {
        original: renderPatch.predecessor,
        renderPatch,
        inputPatch,
        handle,
    };

    return handle;
}
