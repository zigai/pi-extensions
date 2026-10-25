import { describe, expect, it } from "vitest";

import { formatCallDuration } from "../../../../src/tools/built-in/bash/duration.ts";

describe("call duration formatting", () => {
    it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        "shows nothing for an unknown duration: %s",
        (durationMs) => {
            expect(formatCallDuration(durationMs)).toBeUndefined();
        },
    );

    it.each([
        [0, "0.00s"],
        [1234, "1.23s"],
        [59_994, "59.99s"],
    ])("keeps two decimals below one minute: %d", (durationMs, expected) => {
        expect(formatCallDuration(durationMs)).toBe(expected);
    });

    it.each([
        [59_996, "1m 0s"],
        [60_000, "1m 0s"],
        [90_999, "1m 30s"],
        [3_599_999, "59m 59s"],
    ])("drops fractional seconds from one minute: %d", (durationMs, expected) => {
        expect(formatCallDuration(durationMs)).toBe(expected);
    });

    it.each([
        [3_600_000, "1h 0m 0s"],
        [3_725_000, "1h 2m 5s"],
    ])("adds hours from one hour: %d", (durationMs, expected) => {
        expect(formatCallDuration(durationMs)).toBe(expected);
    });
});
