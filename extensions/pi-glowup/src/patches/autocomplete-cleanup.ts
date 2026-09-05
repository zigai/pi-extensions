import { Editor, type TUI } from "@earendil-works/pi-tui";

const AUTOCOMPLETE_CLEANUP_PATCH_KEY = Symbol.for("zigai.pi-glowup.autocomplete-cleanup");
const AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.autocomplete-cleanup.state",
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

type EditorPrototypeOwner =
    | typeof Editor.prototype
    | {
          clearAutocompleteUi?: (...args: never[]) => void;
          [AUTOCOMPLETE_CLEANUP_PATCH_KEY]?: true;
          [AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY]?: AutocompleteCleanupPatchState;
      };

type RuntimeEditor = {
    readonly tui?: TUI;
    readonly autocompletePrefix?: string;
    isShowingAutocomplete?: () => boolean;
};

function isSlashAutocompleteClosing(editor: RuntimeEditor): boolean {
    return (
        editor.isShowingAutocomplete?.() === true &&
        editor.autocompletePrefix?.startsWith("/") === true
    );
}

function shouldForceCleanupRender(editor: RuntimeEditor): boolean {
    return isSlashAutocompleteClosing(editor) && editor.tui?.getClearOnShrink() === true;
}

/** Enables or disables the autocomplete cleanup prototype patch. */
export function configureAutocompleteCleanupPatch(
    enabled: boolean,
    prototype: EditorPrototypeOwner = Editor.prototype,
): void {
    // SAFETY: The owner union admits Pi's concrete prototype or a callable cleanup-method
    // prototype. This adapter preserves the exact prototype and method identities.
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
