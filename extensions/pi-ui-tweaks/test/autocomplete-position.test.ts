import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "vitest";

type SelectedItemForTest = object;

type AutocompletePositionPatchTarget = {
    render(width: number): string[];
    autocompleteState?: unknown;
    autocompleteList?: { getSelectedItem?(): SelectedItemForTest; render(width: number): string[] };
    autocompletePrefix?: string;
    autocompleteProvider?: unknown;
    handleInput?(data: string): void;
    paddingX?: number;
    tui?: { requestRender(force?: boolean): void };
};
type ImportedAutocompletePositionModule = {
    installAutocompletePositionPatch(
        config: {
            readonly autocompleteAboveInput: boolean;
            readonly restoreContentAfterAutocompleteClose: boolean;
        },
        target?: AutocompletePositionPatchTarget,
    ): object;
};

type ImportedAutocompletePositionModuleView = {
    readonly installAutocompletePositionPatch?: unknown;
};

function isImportedAutocompletePositionModule(
    value: unknown,
): value is ImportedAutocompletePositionModule {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;

    // SAFETY: The module view exposes only the installer export validated by this predicate.
    const view = value as ImportedAutocompletePositionModuleView;
    return typeof view.installAutocompletePositionPatch === "function";
}

type AutocompletePositionModule = {
    installAutocompletePositionPatch(prototype?: AutocompletePositionPatchTarget): void;
    updateAutocompleteAboveInput(enabled: boolean): void;
    updateRestoreContentAfterAutocompleteClose(enabled: boolean): void;
};

async function importAutocompletePositionModule(
    instance: string,
): Promise<AutocompletePositionModule> {
    const moduleUrl = new URL(`../src/autocomplete-position.ts?${instance}`, import.meta.url);
    const module: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (!isImportedAutocompletePositionModule(module)) {
        throw new Error("Expected installAutocompletePositionPatch export");
    }

    let autocompleteAboveInput = true;
    let restoreContentAfterAutocompleteClose = true;
    let prototype: AutocompletePositionPatchTarget | undefined;
    const apply = (): void => {
        module.installAutocompletePositionPatch(
            { autocompleteAboveInput, restoreContentAfterAutocompleteClose },
            prototype,
        );
    };

    return {
        installAutocompletePositionPatch(nextPrototype): void {
            prototype = nextPrototype;
            apply();
        },
        updateAutocompleteAboveInput(enabled): void {
            autocompleteAboveInput = enabled;

            if (prototype !== undefined) apply();
        },
        updateRestoreContentAfterAutocompleteClose(enabled): void {
            restoreContentAfterAutocompleteClose = enabled;

            if (prototype !== undefined) apply();
        },
    };
}

function autocompleteTarget(
    prototype: AutocompletePositionPatchTarget,
): AutocompletePositionPatchTarget {
    return {
        ...prototype,
        autocompleteState: {},
        autocompleteList: {
            render() {
                return ["suggestion"];
            },
        },
        paddingX: 0,
    };
}

test("autocomplete position patch reads config state updated by a reloaded module", async () => {
    const firstModule = await importAutocompletePositionModule("first-runtime");
    const secondModule = await importAutocompletePositionModule("second-runtime");
    const prototype: AutocompletePositionPatchTarget = {
        render() {
            return ["input", "suggestion"];
        },
    };

    try {
        firstModule.updateAutocompleteAboveInput(true);
        firstModule.installAutocompletePositionPatch(prototype);
        assert.deepEqual(prototype.render.call(autocompleteTarget(prototype), 20), [
            "\u001b[0m \u001b[0m                   ",
            "suggestion",
            "input",
        ]);

        secondModule.updateAutocompleteAboveInput(false);
        secondModule.installAutocompletePositionPatch(prototype);

        assert.deepEqual(prototype.render.call(autocompleteTarget(prototype), 20), [
            "input",
            "suggestion",
        ]);
    } finally {
        secondModule.updateAutocompleteAboveInput(true);
        secondModule.updateRestoreContentAfterAutocompleteClose(true);
    }
});

test("autocomplete position patch defers forced redraw after above-input autocomplete closes", async () => {
    const autocompletePosition = await importAutocompletePositionModule("close-redraw");
    const requestedForces: Array<boolean | undefined> = [];
    const prototype: AutocompletePositionPatchTarget = {
        render(this: AutocompletePositionPatchTarget) {
            if (this.autocompleteState === null) {
                return ["input"];
            }

            return ["input", "suggestion"];
        },
    };
    const target: AutocompletePositionPatchTarget = {
        ...prototype,
        autocompleteState: {},
        autocompleteList: {
            render() {
                return ["suggestion"];
            },
        },
        paddingX: 0,
        tui: {
            requestRender(force?: boolean): void {
                requestedForces.push(force);
            },
        },
    };

    try {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
        autocompletePosition.installAutocompletePositionPatch(prototype);

        prototype.render.call(target, 20);
        target.autocompleteState = null;
        target.autocompleteList = undefined;
        prototype.render.call(target, 20);
        assert.deepEqual(requestedForces, []);
        await waitForImmediate();
        assert.deepEqual(requestedForces, [true]);
    } finally {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
    }
});

test("autocomplete position patch does not force redraw after Tab completion", async () => {
    const autocompletePosition = await importAutocompletePositionModule("tab-completion-redraw");
    const requestedForces: Array<boolean | undefined> = [];
    const prototype: AutocompletePositionPatchTarget = {
        render(this: AutocompletePositionPatchTarget) {
            if (this.autocompleteState === null) return ["input"];

            return ["input", "suggestion"];
        },
        handleInput(this: AutocompletePositionPatchTarget): void {
            this.autocompleteState = null;
            this.autocompleteList = undefined;
        },
    };
    const target: AutocompletePositionPatchTarget = {
        ...prototype,
        autocompleteState: {},
        autocompleteList: {
            getSelectedItem() {
                return { value: "model" };
            },
            render() {
                return ["suggestion"];
            },
        },
        autocompletePrefix: "/mod",
        autocompleteProvider: {},
        paddingX: 0,
        tui: {
            requestRender(force?: boolean): void {
                requestedForces.push(force);
            },
        },
    };

    try {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
        autocompletePosition.installAutocompletePositionPatch(prototype);

        prototype.render.call(target, 20);
        prototype.handleInput?.call(target, "\t");
        prototype.render.call(target, 20);
        await waitForImmediate();
        assert.deepEqual(requestedForces, []);
    } finally {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
    }
});

test("autocomplete position patch redraws when above-input rendering is disabled", async () => {
    const autocompletePosition = await importAutocompletePositionModule("disable-redraw");
    const requestedForces: Array<boolean | undefined> = [];
    const prototype: AutocompletePositionPatchTarget = {
        render() {
            return ["input", "suggestion"];
        },
    };
    const target = autocompleteTarget(prototype);
    target.tui = {
        requestRender(force?: boolean): void {
            requestedForces.push(force);
        },
    };

    try {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
        autocompletePosition.installAutocompletePositionPatch(prototype);

        prototype.render.call(target, 20);
        autocompletePosition.updateAutocompleteAboveInput(false);
        prototype.render.call(target, 20);
        await waitForImmediate();
        assert.deepEqual(requestedForces, [true]);
    } finally {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
    }
});

test("autocomplete position patch redraws after a failed slash confirmation", async () => {
    const autocompletePosition = await importAutocompletePositionModule("failed-confirm-redraw");
    const requestedForces: Array<boolean | undefined> = [];
    const prototype: AutocompletePositionPatchTarget = {
        render(this: AutocompletePositionPatchTarget) {
            if (this.autocompleteState === null) return ["input"];

            return ["input", "suggestion"];
        },
        handleInput(this: AutocompletePositionPatchTarget): void {
            this.autocompleteState = null;
            this.autocompleteList = undefined;
            throw new Error("command failed");
        },
    };
    const target: AutocompletePositionPatchTarget = {
        ...prototype,
        autocompleteState: {},
        autocompleteList: {
            getSelectedItem() {
                return { value: "model" };
            },
            render() {
                return ["suggestion"];
            },
        },
        autocompletePrefix: "/mod",
        autocompleteProvider: {},
        paddingX: 0,
        tui: {
            requestRender(force?: boolean): void {
                requestedForces.push(force);
            },
        },
    };

    try {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
        autocompletePosition.installAutocompletePositionPatch(prototype);

        prototype.render.call(target, 20);
        assert.throws(() => prototype.handleInput?.call(target, "\r"), /command failed/);
        prototype.render.call(target, 20);
        await waitForImmediate();
        assert.deepEqual(requestedForces, [true]);
    } finally {
        autocompletePosition.updateAutocompleteAboveInput(true);
        autocompletePosition.updateRestoreContentAfterAutocompleteClose(true);
    }
});
