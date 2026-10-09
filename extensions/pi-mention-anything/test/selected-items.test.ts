import assert from "node:assert/strict";
import { test } from "vitest";

import { includeSelectedItems, selectedOrCurrentItem } from "../src/selected-items.ts";

type Candidate = { readonly name: string; readonly replacement: string };

const nameOf = (candidate: Candidate): string => candidate.name;

test("retains the selected snapshot until prompt expansion", () => {
    const selectedProduction = {
        name: "production",
        replacement: "selected-production",
    };
    const selectedRemoved = { name: "removed", replacement: "selected-removed" };

    const selected = new Map([
        [selectedProduction.name, selectedProduction],
        [selectedRemoved.name, selectedRemoved],
    ]);

    const current = [
        { name: "production", replacement: "refreshed-production" },
        { name: "staging", replacement: "refreshed-staging" },
    ];

    const items = includeSelectedItems(current, selected, nameOf);
    assert.deepEqual(items, [...current, selectedRemoved]);
    const production = current.at(0);
    const staging = current.at(1);
    if (production === undefined || staging === undefined) assert.fail("expected current items");
    assert.equal(selectedOrCurrentItem(production, selected, nameOf), selectedProduction);
    assert.equal(selectedOrCurrentItem(staging, selected, nameOf), staging);
});
