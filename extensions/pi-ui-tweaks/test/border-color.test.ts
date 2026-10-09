import assert from "node:assert/strict";
import { Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { installNeutralBorderColorPatch } from "../src/border-color.ts";

test("neutral border patch is removable and reuses its handle", async () => {
    const prototype = Theme.prototype;
    const original = prototype.fg;
    const handle = await installNeutralBorderColorPatch({ neutralBorderColor: true });
    const patched = prototype.fg;
    assert.notEqual(patched, original);
    const same = await installNeutralBorderColorPatch({ neutralBorderColor: false });
    assert.equal(same, handle);
    assert.equal(prototype.fg, patched);
    handle.dispose();
    assert.equal(prototype.fg, original);
});
