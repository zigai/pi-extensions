import { describe, expect, it, vi } from "vitest";
import { ParseError } from "typebox/value";
import { configureAutocompleteCleanupPatch } from "../../src/pi/patches/autocomplete-cleanup.ts";

function installAutocompleteCleanupPatch(prototype: FakePrototype): void {
    configureAutocompleteCleanupPatch(true, prototype);
}

type FakeTui = {
    readonly getClearOnShrink: () => boolean;
    readonly requestRender: ReturnType<typeof vi.fn<(force?: boolean) => void>>;
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
            requestRender: vi.fn<(force?: boolean) => void>(),
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
    it("leaves a missing optional cleanup hook untouched", () => {
        const prototype = {};
        configureAutocompleteCleanupPatch(true, prototype);
        expect(Reflect.ownKeys(prototype)).toEqual([]);
    });

    it("rejects a non-callable hook before installing any patch state", () => {
        const prototype = createPrototype();
        Object.defineProperty(prototype, "clearAutocompleteUi", { value: 17 });
        expect(() => configureAutocompleteCleanupPatch(true, prototype)).toThrow(ParseError);
        expect(Object.getOwnPropertySymbols(prototype)).toEqual([]);
        expect(Object.getOwnPropertyDescriptor(prototype, "clearAutocompleteUi")?.value).toBe(17);
    });

    it("disables retained wrappers after a foreign non-callable replacement", () => {
        const prototype = createPrototype();
        configureAutocompleteCleanupPatch(true, prototype);
        const retainedWrapper = prototype.clearAutocompleteUi;
        Object.defineProperty(prototype, "clearAutocompleteUi", { value: 17 });
        configureAutocompleteCleanupPatch(false, prototype);
        const editor = createEditor({ prefix: "/set", active: true, clearOnShrink: true });
        retainedWrapper.call(editor);
        expect(editor.active).toBe(false);
        expect(editor.tui.requestRender).not.toHaveBeenCalled();
        expect(Object.getOwnPropertyDescriptor(prototype, "clearAutocompleteUi")?.value).toBe(17);
    });

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

    it("restores the original autocomplete cleanup method when disabled", () => {
        const prototype = createPrototype();
        const originalClearAutocompleteUi = prototype.clearAutocompleteUi;

        configureAutocompleteCleanupPatch(true, prototype);
        configureAutocompleteCleanupPatch(false, prototype);

        expect(prototype.clearAutocompleteUi).toBe(originalClearAutocompleteUi);
    });

    it("does not clobber autocomplete cleanup wrappers installed later", () => {
        const prototype = createPrototype();
        configureAutocompleteCleanupPatch(true, prototype);
        const originalClearAutocompleteUi = prototype.clearAutocompleteUi;
        prototype.clearAutocompleteUi = function clearAutocompleteUiWithLaterWrapper(
            this: FakeEditor,
        ): void {
            originalClearAutocompleteUi.call(this);
        };
        const laterClearAutocompleteUi = prototype.clearAutocompleteUi;
        const editor = createEditor({ prefix: "/set", active: true, clearOnShrink: true });

        configureAutocompleteCleanupPatch(false, prototype);
        prototype.clearAutocompleteUi.call(editor);

        expect(prototype.clearAutocompleteUi).toBe(laterClearAutocompleteUi);
        expect(editor.active).toBe(false);
        expect(editor.tui.requestRender).not.toHaveBeenCalled();
    });
});
