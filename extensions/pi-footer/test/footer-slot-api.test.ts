import assert from "node:assert/strict";
import { test } from "vitest";

import { getFooterSlotSnapshots, registerFooterSlot } from "../src/footer-slot-api.ts";

test("custom slot ids preserve every valid namespace segment exactly", () => {
    for (const id of ["extension.status", "my-extension.status-2.extra", "0.1"]) {
        const handle = registerFooterSlot({ id, text: "visible" });
        try {
            assert.ok(getFooterSlotSnapshots().some((slot) => slot.id === id));
        } finally {
            handle.dispose();
        }
    }
});

test("custom slot ids reject malformed namespaces without registering a slot", () => {
    const before = getFooterSlotSnapshots();

    for (const id of [
        "",
        "status",
        ".status",
        "extension.",
        "extension..status",
        "Extension.status",
        "extension.status\n",
        "extension. status",
    ]) {
        assert.throws(() => registerFooterSlot({ id, text: "visible" }), /must be namespaced/);
    }

    assert.deepEqual(getFooterSlotSnapshots(), before);
});
