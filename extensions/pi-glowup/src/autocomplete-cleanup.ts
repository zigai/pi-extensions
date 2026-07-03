import { Editor, type TUI } from "@earendil-works/pi-tui";

const AUTOCOMPLETE_CLEANUP_PATCH_KEY = Symbol.for("zigai.pi-codex-look.autocomplete-cleanup");
const AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-codex-look.autocomplete-cleanup.state",
);

type AutocompleteCleanupPatchState = {
    enabled: boolean;
    readonly originalClearAutocompleteUi: (this: RuntimeEditor) => void;
    readonly wrapperClearAutocompleteUi: (this: RuntimeEditor) => void;
};

type PatchableEditorPrototype = {
    [AUTOCOMPLETE_CLEANUP_PATCH_KEY]?: true;
    [AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY]?: AutocompleteCleanupPatchState;
    clearAutocompleteUi?: (this: RuntimeEditor) => void;
};

type RuntimeEditor = {
    readonly tui?: TUI;
    readonly autocompletePrefix?: unknown;
    isShowingAutocomplete?: () => boolean;
};

function isSlashAutocompleteClosing(editor: RuntimeEditor): boolean {
    return (
        editor.isShowingAutocomplete?.() === true &&
        typeof editor.autocompletePrefix === "string" &&
        editor.autocompletePrefix.startsWith("/")
    );
}

function shouldForceCleanupRender(editor: RuntimeEditor): boolean {
    return isSlashAutocompleteClosing(editor) && editor.tui?.getClearOnShrink() === true;
}

/**
 * Forces a full TUI redraw when Pi's slash autocomplete menu closes while
 * clear-on-shrink is enabled.
 *
 * Pi's slash menu is rendered as extra editor lines. With clear-on-shrink, the
 * post-close render must clear the old menu rows before restoring the footer;
 * a normal differential repaint can leave stale rows in the blank area above it.
 */
export function installAutocompleteCleanupPatch(
    prototype: object = Editor.prototype as unknown as object,
): void {
    configureAutocompleteCleanupPatch(true, prototype);
}

/** Enables or disables the autocomplete cleanup prototype patch. */
export function configureAutocompleteCleanupPatch(
    enabled: boolean,
    prototype: object = Editor.prototype as unknown as object,
): void {
    const editorPrototype = prototype as PatchableEditorPrototype;
    const state = editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY];

    if (!enabled) {
        if (state !== undefined) {
            state.enabled = false;
            if (editorPrototype.clearAutocompleteUi === state.wrapperClearAutocompleteUi) {
                editorPrototype.clearAutocompleteUi = state.originalClearAutocompleteUi;
                delete editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY];
                delete editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_KEY];
            }
        }
        return;
    }

    if (state !== undefined) {
        state.enabled = true;
        return;
    }

    const originalClearAutocompleteUi = editorPrototype.clearAutocompleteUi;
    if (originalClearAutocompleteUi === undefined) {
        return;
    }

    let nextState: AutocompleteCleanupPatchState;
    const wrapperClearAutocompleteUi = function clearAutocompleteUiWithCleanup(
        this: RuntimeEditor,
    ): void {
        const forceCleanupRender = nextState.enabled && shouldForceCleanupRender(this);
        originalClearAutocompleteUi.call(this);
        if (forceCleanupRender) {
            this.tui?.requestRender(true);
        }
    };

    nextState = {
        enabled: true,
        originalClearAutocompleteUi,
        wrapperClearAutocompleteUi,
    };
    editorPrototype.clearAutocompleteUi = wrapperClearAutocompleteUi;
    editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY] = nextState;
    editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_KEY] = true;
}
