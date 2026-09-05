import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugFileLogger } from "../src/diagnostics/debug-logger.ts";
import { jsonValueSchema, type JsonValue } from "../src/json-value.js";
import { Value } from "typebox/value";

describe("debug file logger", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("writes structured JSONL diagnostics to a relative file path", () => {
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });

        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        logger.record("test_event", {
            memory: { heapUsedBytes: 123 },
            omitted: undefined,
        });

        const entries = readJsonLines(join(extensionDirectory, "debug.log"));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            event: "test_event",
            fields: { memory: { heapUsedBytes: 123 } },
        });
        expect(entries[0]).not.toMatchObject({ fields: { omitted: expect.anything() } });
    });

    it("does not create a file when disabled", () => {
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });

        logger.configure({
            enabled: false,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        logger.record("test_event", { value: true });

        expect(existsSync(join(extensionDirectory, "debug.log"))).toBe(false);
    });

    it("does not evaluate lazy fields when disabled", () => {
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });
        let evaluations = 0;

        logger.configure({
            enabled: false,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        logger.record("test_event", () => {
            evaluations += 1;
            return { value: true };
        });

        expect(evaluations).toBe(0);
        expect(existsSync(join(extensionDirectory, "debug.log"))).toBe(false);
    });

    it("evaluates lazy fields once when enabled", () => {
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });
        let evaluations = 0;

        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        logger.record("test_event", () => {
            evaluations += 1;
            return { value: true };
        });

        expect(evaluations).toBe(1);
        expect(readJsonLines(join(extensionDirectory, "debug.log"))[0]).toMatchObject({
            event: "test_event",
            fields: { value: true },
        });
    });

    it("rotates the active file when it exceeds the configured byte limit", () => {
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });

        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: 240,
            memorySampleIntervalMs: 0,
        });
        logger.record("first_event", { payload: "x".repeat(80) });
        logger.record("second_event", { payload: "y".repeat(80) });

        expect(readJsonLines(join(extensionDirectory, "debug.log"))[0]).toMatchObject({
            event: "second_event",
        });
        expect(readJsonLines(join(extensionDirectory, "debug.log.1"))[0]).toMatchObject({
            event: "first_event",
        });
    });

    it("does not rotate when maxBytes is null", () => {
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });

        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });
        logger.record("first_event", { payload: "x".repeat(80) });
        logger.record("second_event", { payload: "y".repeat(80) });

        expect(readJsonLines(join(extensionDirectory, "debug.log"))).toHaveLength(2);
        expect(existsSync(join(extensionDirectory, "debug.log.1"))).toBe(false);
    });

    it("samples memory on an unrefed timer and stops cleanly", () => {
        vi.useFakeTimers();
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });

        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 1_000,
        });
        logger.startMemorySampling(() => ({ memory: { heapUsedBytes: 456 } }));

        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(1_000);
        logger.stopMemorySampling();

        expect(vi.getTimerCount()).toBe(0);
        expect(readJsonLines(join(extensionDirectory, "debug.log"))[0]).toMatchObject({
            event: "memory_sample",
            fields: { memory: { heapUsedBytes: 456 } },
        });
    });

    it("records a bounded failure marker when a memory snapshot throws", () => {
        vi.useFakeTimers();
        const extensionDirectory = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const logger = new DebugFileLogger({
            extensionDirectory,
            reportWarning() {},
        });
        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 1_000,
        });
        logger.startMemorySampling(() => {
            throw new Error("snapshot failed");
        });

        vi.advanceTimersByTime(1_000);
        logger.stopMemorySampling();

        expect(readJsonLines(join(extensionDirectory, "debug.log"))[0]).toMatchObject({
            event: "memory_sample",
            fields: { snapshotFailed: true },
        });
    });

    it("reports repeated write failures only once", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-glowup-debug-log-"));
        const blockedDirectory = join(root, "not-a-directory");
        writeFileSync(blockedDirectory, "file blocks directory creation");
        const warnings: string[] = [];
        const logger = new DebugFileLogger({
            extensionDirectory: blockedDirectory,
            reportWarning(message) {
                warnings.push(message);
            },
        });
        logger.configure({
            enabled: true,
            path: "debug.log",
            maxBytes: null,
            memorySampleIntervalMs: 0,
        });

        logger.record("first_event");
        logger.record("second_event");

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("Failed to write debug log");
        expect(warnings[0]).toContain("debug.log");
    });
});

function readJsonLines(filePath: string): JsonValue[] {
    return readFileSync(filePath, "utf8").trim().split("\n").map(parseJsonLine);
}

function parseJsonLine(line: string): JsonValue {
    return Value.Parse(jsonValueSchema, JSON.parse(line));
}
