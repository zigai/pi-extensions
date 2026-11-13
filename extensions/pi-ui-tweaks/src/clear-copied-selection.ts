import { TuiAltScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
    installKeyedLinkedMethodPatch,
    warnPiInternalPatchUnavailable,
} from "@zigai/pi-extension-internals";

const CLEAR_COPIED_SELECTION_PATCH = Symbol.for(
    "zigai.pi-ui-tweaks.clear-copied-selection-patched",
);

type SelectionScreen = {
    clearTextSelection(): void;
};

type SelectionScreenPrototype = {
    copySelectionToClipboard(this: SelectionScreen): Promise<boolean>;
};

export type ClearCopiedSelectionConfig = {
    readonly clearSelectionAfterCopy: boolean;
};

export type ClearCopiedSelectionHandle = {
    update(config: ClearCopiedSelectionConfig): void;
    dispose(): void;
};

const selectionScreenSchema = Type.Object({
    copySelectionToClipboard: Type.Unsafe<SelectionScreenPrototype["copySelectionToClipboard"]>(
        Type.Function([], Type.Unknown()),
    ),
    clearTextSelection: Type.Function([], Type.Void()),
});

const selectionScreenRuntime = {
    parse(value: unknown): SelectionScreenPrototype | null {
        if (!Value.Check(selectionScreenSchema, value)) return null;

        return value;
    },
};

/** Clears the fullscreen selection highlight once copy-on-select has copied it. */
export function installClearCopiedSelectionPatch(
    config: ClearCopiedSelectionConfig,
    target: SelectionScreenPrototype | null = selectionScreenRuntime.parse(TuiAltScreen.prototype),
): ClearCopiedSelectionHandle {
    if (target === null) {
        warnPiInternalPatchUnavailable("pi-ui-tweaks", "clear copied selection");

        return { update(): void {}, dispose(): void {} };
    }

    return installKeyedLinkedMethodPatch(
        target,
        "copySelectionToClipboard",
        CLEAR_COPIED_SELECTION_PATCH,
        config,
        (predecessor, current) =>
            async function copySelectionAndClear(this: SelectionScreen): Promise<boolean> {
                // The predecessor reads the selected text before its first await, so the
                // selection can be cleared while the clipboard write is still pending.
                const copied = predecessor.call(this);

                if (current().clearSelectionAfterCopy) this.clearTextSelection();

                return copied;
            },
    );
}
