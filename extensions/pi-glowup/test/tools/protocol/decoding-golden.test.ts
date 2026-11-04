import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { protocolDecodingGolden } from "../../support/protocol-decoding-corpus.ts";

// Pi 1.5 drops styled whitespace at a wrap boundary instead of reopening it.
// The narrow mutation continuation moves left one cell, with syntax and diff
// colors preserved; node-16 and its containing stack record that upstream fix.
it("preserves decoded snapshots and exact ANSI frames across states, widths, and malformed inputs", () => {
    expect(protocolDecodingGolden()).toBe(
        readFileSync(new URL("./golden/protocol-decoding.json", import.meta.url), "utf8"),
    );
});
