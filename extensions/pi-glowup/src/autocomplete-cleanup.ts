import { Editor, type TUI } from "@earendil-works/pi-tui";

const AUTOCOMPLETE_CLEANUP_PATCH_KEY = Symbol.for("zigai.pi-codex-look.autocomplete-cleanup");

type PatchableEditorPrototype = {
  [AUTOCOMPLETE_CLEANUP_PATCH_KEY]?: true;
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
  const editorPrototype = prototype as PatchableEditorPrototype;
  if (editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_KEY] === true) {
    return;
  }

  const originalClearAutocompleteUi = editorPrototype.clearAutocompleteUi;
  if (originalClearAutocompleteUi === undefined) {
    return;
  }

  editorPrototype.clearAutocompleteUi = function clearAutocompleteUiWithCleanup(
    this: RuntimeEditor,
  ): void {
    const forceCleanupRender = shouldForceCleanupRender(this);
    originalClearAutocompleteUi.call(this);
    if (forceCleanupRender) {
      this.tui?.requestRender(true);
    }
  };

  editorPrototype[AUTOCOMPLETE_CLEANUP_PATCH_KEY] = true;
}
