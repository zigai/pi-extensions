import assert from "node:assert/strict";
import test from "node:test";

import { extensionName, packageName } from "../src/index.ts";

test("exports extension metadata", () => {
    assert.equal(packageName, "pi-codex-core");
    assert.equal(extensionName, "Pi Codex Core");
});
