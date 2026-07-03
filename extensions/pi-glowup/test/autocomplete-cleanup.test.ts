import { describe, expect, it, vi } from "vitest";
import { installAutocompleteCleanupPatch } from "../src/autocomplete-cleanup.ts";

type FakeTui = {
    readonly getClearOnShrink: () => boolean;
    readonly requestRender: ReturnType<typeof vi.fn>;
};

type FakeEditor = {
    readonly tui: FakeTui;
    autocompletePrefix: string;
    active: boolean;
    readonly isShowingAutocomplete: () => boolean;
    clearAutocompleteUi: () => void;
};

type FakePrototype = {
    clearAutocompleteUi: (this: FakeEditor) => void;
};

function createPrototype(): FakePrototype {
    return {
        clearAutocompleteUi(this: FakeEditor): void {
            this.active = false;
            this.autocompletePrefix = "";
        },
    };
}

function createEditor(options: {
    readonly prefix: string;
    readonly active: boolean;
    readonly clearOnShrink: boolean;
}): FakeEditor {
    return {
        tui: {
            getClearOnShrink: () => options.clearOnShrink,
            requestRender: vi.fn(),
        },
        autocompletePrefix: options.prefix,
        active: options.active,
        isShowingAutocomplete() {
            return this.active;
        },
        clearAutocompleteUi() {},
    };
}

describe("autocomplete cleanup patch", () => {
    it("forces a full redraw when slash autocomplete closes with clear-on-shrink enabled", () => {
        const prototype = createPrototype();
        installAutocompleteCleanupPatch(prototype);
        const editor = createEditor({ prefix: "/set", active: true, clearOnShrink: true });

        prototype.clearAutocompleteUi.call(editor);

        expect(editor.active).toBe(false);
        expect(editor.tui.requestRender).toHaveBeenCalledExactlyOnceWith(true);
    });

    it("does not force a full redraw when clear-on-shrink is disabled", () => {
        const prototype = createPrototype();
        installAutocompleteCleanupPatch(prototype);
        const editor = createEditor({ prefix: "/set", active: true, clearOnShrink: false });

        prototype.clearAutocompleteUi.call(editor);

        expect(editor.tui.requestRender).not.toHaveBeenCalled();
    });

    it("does not force a full redraw for non-slash autocomplete", () => {
        const prototype = createPrototype();
        installAutocompleteCleanupPatch(prototype);
        const editor = createEditor({ prefix: "@file", active: true, clearOnShrink: true });

        prototype.clearAutocompleteUi.call(editor);

        expect(editor.tui.requestRender).not.toHaveBeenCalled();
    });

    it("is idempotent for a patched prototype", () => {
        const prototype = createPrototype();
        installAutocompleteCleanupPatch(prototype);
        const patchedClearAutocompleteUi = prototype.clearAutocompleteUi;

        installAutocompleteCleanupPatch(prototype);

        expect(prototype.clearAutocompleteUi).toBe(patchedClearAutocompleteUi);
    });
});
