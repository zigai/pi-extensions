import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { protocolDecodingGolden } from "../../support/protocol-decoding-corpus.ts";

it("preserves decoded snapshots and exact ANSI frames across states, widths, and malformed inputs", () => {
    expect(protocolDecodingGolden()).toBe(
        readFileSync(new URL("./golden/protocol-decoding.json", import.meta.url), "utf8"),
    );
});
