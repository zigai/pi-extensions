import { Editor, type TUI } from "@earendil-works/pi-tui";
import Type from "typebox";
import { Value } from "typebox/value";

const AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.autocomplete-cleanup.state",
);

type AutocompleteCleanupPatchState = {
    enabled: boolean;
    readonly originalClearAutocompleteUi: (this: RuntimeEditor) => void;
    readonly wrapperClearAutocompleteUi: (this: RuntimeEditor) => void;
};

type EditorPatchMetadata = object & {
    [AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY]?: AutocompleteCleanupPatchState;
};

// Editor's private hook takes no arguments and returns no value. Its signature is
// erased in the SDK declaration; validate the callable before replacing it.
const cleanupPrototypeSchema = Type.Object({
    clearAutocompleteUi: Type.Optional(Type.Function([], Type.Void())),
});

type EditorPrototypeOwner =
    | typeof Editor.prototype
    | {
          clearAutocompleteUi?: () => void;
          [AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY]?: AutocompleteCleanupPatchState;
      };

type RuntimeEditor = {
    readonly tui?: Pick<TUI, "getClearOnShrink" | "requestRender">;
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
    const metadata: EditorPatchMetadata = prototype;
    const state = metadata[AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY];
    if (!enabled) {
        if (state !== undefined) {
            state.enabled = false;

            if (Value.Check(cleanupPrototypeSchema, prototype)) {
                const editorPrototype = Value.Parse(cleanupPrototypeSchema, prototype);
                if (editorPrototype.clearAutocompleteUi === state.wrapperClearAutocompleteUi) {
                    editorPrototype.clearAutocompleteUi = state.originalClearAutocompleteUi;
                    delete metadata[AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY];
                }
            }
        }

        return;
    }

    if (state !== undefined) {
        state.enabled = true;
        return;
    }

    const editorPrototype = Value.Parse(cleanupPrototypeSchema, prototype);
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
    metadata[AUTOCOMPLETE_CLEANUP_PATCH_STATE_KEY] = nextState;
}
