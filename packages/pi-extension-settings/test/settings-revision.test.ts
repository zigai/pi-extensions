import { describe, expect, it } from "vitest";

import { createSettingsRevision } from "../src/settings-revision.ts";

describe("settings revisions", () => {
    it("distinguishes missing, empty, and length-delimited sources", () => {
        const missing = createSettingsRevision(undefined);
        const empty = createSettingsRevision("");
        const splitLeft = createSettingsRevision("ab", "c");
        const splitRight = createSettingsRevision("a", "bc");

        expect(missing).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(new Set([missing, empty, splitLeft, splitRight])).toHaveLength(4);
    });

    it("does not expose source content", () => {
        expect(createSettingsRevision("private-setting-value")).not.toContain(
            "private-setting-value",
        );
    });
});
