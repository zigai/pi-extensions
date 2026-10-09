import assert from "node:assert/strict";
import { SelectList } from "@earendil-works/pi-tui";
import { test } from "vitest";

import { installAutocompleteScrollInfoPatch } from "../src/autocomplete-scroll-info.ts";

function createList(): SelectList {
    return new SelectList(
        [
            { value: "settings", label: "settings" },
            { value: "model", label: "model" },
            { value: "export", label: "export" },
        ],
        2,
        {
            selectedPrefix: (text) => text,
            selectedText: (text) => text,
            description: (text) => text,
            scrollInfo: (text) => `count:${text}`,
            noMatch: (text) => text,
        },
    );
}

test("autocomplete scroll info hides and restores the count footer", () => {
    const handle = installAutocompleteScrollInfoPatch({ hideAutocompleteScrollInfo: true });
    assert.deepEqual(createList().render(80), ["→ settings", "  model"]);
    handle.update({ hideAutocompleteScrollInfo: false });
    assert.deepEqual(createList().render(80), ["→ settings", "  model", "count:  (1/3)"]);
    handle.dispose();
    assert.deepEqual(createList().render(80), ["→ settings", "  model", "count:  (1/3)"]);
});
