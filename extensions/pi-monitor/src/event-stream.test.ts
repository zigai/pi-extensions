import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BATCH_WINDOW_MS, EventStream } from "./event-stream.ts";

let events: string[];
let floods: string[];
let stream: EventStream;

beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    floods = [];
    stream = new EventStream({
        onEvent: (text) => {
            events.push(text);
        },
        onFlood: (notice) => {
            floods.push(notice);
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
});

it("joins a line split across chunks and groups lines from one window", () => {
    stream.push("hel");
    stream.push("lo\nwor");
    stream.push("ld\n");
    expect(events).toEqual([]);

    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events).toEqual(["hello\nworld"]);
});

it("closes the window a fixed time after its first line", () => {
    stream.push("first\n");
    vi.advanceTimersByTime(150);
    stream.push("second\n");
    vi.advanceTimersByTime(60);
    stream.push("third\n");
    vi.advanceTimersByTime(BATCH_WINDOW_MS);

    expect(events).toEqual(["first\nsecond", "third"]);
});

it("drops blank lines, carriage returns, and terminal styling", () => {
    stream.push("\u001B[31mred\u001B[0m\r\n   \n\n\t\n");
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events).toEqual(["red"]);

    stream.push("\n\n");
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events).toEqual(["red"]);
});

it("cuts long lines and long events", () => {
    stream.push(`${"a".repeat(600)}\n`);
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events[0]).toBe(`${"a".repeat(500)}...(truncated)`);

    stream.push(`${"b".repeat(100)}\n`.repeat(50));
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events[1]).toHaveLength(3000 + "\n...(truncated)".length);
    expect(events[1]?.endsWith("\n...(truncated)")).toBe(true);
});

it("keeps memory bounded for a line that never ends", () => {
    stream.push("x".repeat(3 * 1024 * 1024));
    stream.push("\n");
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events).toEqual([`${"x".repeat(500)}...(truncated)`]);
});

it("drains undelivered lines with the partial line and then ignores input", () => {
    stream.push("queued\npartial");
    expect(stream.drain()).toBe("queued\npartial");

    stream.push("late\n");
    vi.advanceTimersByTime(BATCH_WINDOW_MS);
    expect(events).toEqual([]);
    expect(stream.drain()).toBe("");
});

it("suppresses events beyond the burst and reports the count on the next event", () => {
    for (let index = 0; index < 15; index += 1) {
        stream.push(`event ${index}\n`);
        vi.advanceTimersByTime(BATCH_WINDOW_MS);
    }

    // 15 windows take 3 seconds: the burst of 10 plus one refilled token.
    expect(events).toHaveLength(11);
    expect(stream.eventCount).toBe(11);

    vi.advanceTimersByTime(2_000);
    stream.push("after the burst\n");
    vi.advanceTimersByTime(BATCH_WINDOW_MS);

    expect(events.at(-1)).toMatch(/^\[4 events suppressed: output rate too high\./u);
    expect(events.at(-1)?.endsWith("\nafter the burst")).toBe(true);
    expect(floods).toEqual([]);
});

it("reports a flood once after 30 seconds over the rate and then stays silent", () => {
    for (let elapsed = 0; elapsed < 40_000; elapsed += 250) {
        stream.push("spam\n");
        vi.advanceTimersByTime(250);
    }

    expect(floods).toHaveLength(1);
    expect(floods[0]).toMatch(
        /^\[Monitor stopped: too much output \(\d+ events suppressed over 3\ds\)/u,
    );

    const delivered = events.length;
    stream.push("more\n");
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(delivered);
});

it("does not count a steady stream within the rate as a flood", () => {
    for (let elapsed = 0; elapsed < 60_000; elapsed += 2_000) {
        stream.push("tick\n");
        vi.advanceTimersByTime(2_000);
    }

    expect(events).toHaveLength(30);
    expect(events.every((event) => event === "tick")).toBe(true);
    expect(floods).toEqual([]);
});
