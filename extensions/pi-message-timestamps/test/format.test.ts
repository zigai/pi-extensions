import { describe, expect, it } from "vitest";
import { formatTimestamp } from "../src/format.ts";

describe("formatTimestamp", () => {
    const now = new Date(2025, 0, 2, 16, 45, 50);

    it("shows local time today, but local date and time on other days by default", () => {
        expect(formatTimestamp(new Date(2025, 0, 2, 4, 5, 59), "auto", now)).toBe("04:05");
        expect(formatTimestamp(new Date(2025, 0, 1, 23, 59), "auto", now)).toBe("01.01.2025 23:59");
        expect(formatTimestamp(new Date(2024, 0, 2, 4, 5), "auto", now)).toBe("02.01.2024 04:05");
        expect(formatTimestamp(new Date(2025, 1, 2, 4, 5), "auto", now)).toBe("02.02.2025 04:05");
    });

    it("formats a timestamp's local calendar fields rather than UTC fields", () => {
        const timestamp = new Date(2025, 6, 7, 8, 9, 59);
        expect(formatTimestamp(timestamp.toISOString(), "date-time", now)).toBe("07.07.2025 08:09");
        expect(formatTimestamp(timestamp.getTime(), "time-only", now)).toBe("08:09");
        expect(formatTimestamp(timestamp, "date-time", timestamp)).toBe("07.07.2025 08:09");
    });

    it("formats elapsed and future durations without seconds", () => {
        expect(formatTimestamp(now.getTime() - (4 * 60 + 32) * 60_000, "relative", now)).toBe(
            "4h 32m ago",
        );

        expect(formatTimestamp(now.getTime() - 59_999, "relative", now)).toBe("just now");
        expect(formatTimestamp(now.getTime() - 60_000, "relative", now)).toBe("1m ago");
        expect(
            formatTimestamp(now.getTime() - (24 * 60 + 2 * 60 + 3) * 60_000, "relative", now),
        ).toBe("1d 2h ago");

        expect(formatTimestamp(now.getTime() + 65 * 60_000, "relative", now)).toBe("in 1h 5m");
        expect(formatTimestamp(now.getTime() - (24 * 60 + 30) * 60_000, "relative", now)).toBe(
            "1d 30m ago",
        );
    });

    it("does not emit a malformed label for invalid dates", () => {
        expect(formatTimestamp("invalid", "date-time", now)).toBe("");
        expect(formatTimestamp(now, "auto", NaN)).toBe("");
        expect(formatTimestamp(now, "relative", NaN)).toBe("");
    });
});
