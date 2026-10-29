import { describe, expect, it } from "vitest";
import { peakCountdown } from "../src/model-peak-schedule.ts";

const at = (value: string): Date => new Date(value);

describe("model peak countdown", () => {
    it("uses half-open weekday peak windows and counts down to the next transition", () => {
        expect(peakCountdown("deepseek-reseller", at("2026-01-05T00:30:00Z"))).toBe(
            "off-peak · ends in 30m",
        );

        expect(peakCountdown("deepseek-reseller", at("2026-01-05T01:00:00Z"))).toBe(
            "peak · off-peak starts in 3h",
        );

        expect(peakCountdown("deepseek-reseller", at("2026-01-05T04:00:00Z"))).toBe(
            "off-peak · ends in 2h",
        );

        expect(peakCountdown("deepseek-reseller", at("2026-01-09T10:00:00Z"))).toBe(
            "off-peak · ends in 63h",
        );
    });

    it("uses UTC regardless of local daylight saving and crosses midnight", () => {
        expect(peakCountdown("mimo", at("2026-03-08T15:34:00Z"))).toBe(
            "peak · off-peak starts in 26m",
        );

        expect(peakCountdown("mimo", at("2026-03-08T16:00:00Z"))).toBe("off-peak · ends in 8h");
        expect(peakCountdown("qwen", at("2026-11-01T14:00:00Z"))).toBe("off-peak · ends in 10h");
        expect(peakCountdown("ali-qwen", at("2026-11-01T13:59:00Z"))).toBe(
            "peak · off-peak starts in 1m",
        );

        expect(peakCountdown("ali-deepseek", at("2026-11-01T14:00:00Z"))).toBe(
            "off-peak · ends in 10h",
        );

        expect(peakCountdown("command", at("2026-01-05T01:00:00Z"))).toBe(
            "peak · off-peak starts in 3h",
        );

        expect(peakCountdown("glm", at("2026-01-05T06:00:00Z"))).toBe(
            "peak · off-peak starts in 4h",
        );
    });

    it("does not predict direct DeepSeek across unknown holiday dates", () => {
        expect(peakCountdown("deepseek-direct", at("2026-01-05T01:00:00Z"))).toBeUndefined();
        expect(peakCountdown("deepseek-direct", at("2026-01-05T01:00:00Z"), () => false)).toBe(
            "peak · off-peak starts in 3h",
        );

        expect(
            peakCountdown("deepseek-direct", at("2026-01-05T01:00:00Z"), (date) => {
                if (date === "2026-01-05") return true;
                return undefined;
            }),
        ).toBeUndefined();

        expect(
            peakCountdown("deepseek-direct", at("2026-01-05T01:00:00Z"), (date) => {
                if (date === "2026-01-05") return true;
                if (date === "2026-01-06") return false;
                return undefined;
            }),
        ).toBe("off-peak · ends in 24h");
    });

    it("rounds up partial minutes and never displays a clock time", () => {
        expect(peakCountdown("glm", at("2026-01-05T09:59:01Z"))).toBe(
            "peak · off-peak starts in 1m",
        );

        expect(peakCountdown("glm", at("2026-01-05T07:33:01Z"))).toBe(
            "peak · off-peak starts in 2h 27m",
        );
    });
});
