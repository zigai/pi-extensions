import { expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HistoryPicker, safeText } from "../src/picker.ts";
import { HistorySource } from "../src/source.ts";

function picker(texts: string[], height = 24) {
    const source = new HistorySource({
        root: "/not-read-in-session-scope",
        session: "s",
        cwd: "/fixture",
        live: () =>
            texts.map((text, i) => ({
                type: "message",
                id: String(i),
                timestamp: new Date(i).toISOString(),
                message: { role: "user", content: text },
            })),
    });
    const accepted: (string | undefined)[] = [];
    const view = new HistoryPicker(
        "session",
        source,
        () => {},
        (text) => {
            accepted.push(text);
        },
        () => height,
    );

    return { view, accepted };
}

test("Enter and Tab accept untouched full text exactly once; empty selection never closes", () => {
    for (const key of ["\r", "\t"]) {
        const { view, accepted } = picker(["  full\noriginal 🦊  "]);
        view.handleInput(key);
        view.handleInput(key);
        view.cancel();
        expect(accepted).toEqual(["  full\noriginal 🦊  "]);
    }

    const empty = picker([]);
    empty.view.handleInput("\r");
    expect(empty.accepted).toEqual([]);
    empty.view.cancel();
});

test("Escape/Ctrl+C cancel once, navigation/query never accepts, scope cycle preserves query", () => {
    for (const key of ["\x1b", "\x03"]) {
        const { view, accepted } = picker(["first", "second"]);
        view.handleInput("\x1b[B");
        view.handleInput("second");
        expect(accepted).toEqual([]);
        view.handleInput(key);
        view.handleInput(key);
        expect(accepted).toEqual([undefined]);
    }

    const { view } = picker(["literal query"]);
    view.handleInput("query");
    view.handleInput("\x13");
    expect(view.render(100).join("\n")).toContain("This project");
    expect(view.render(100).join("\n")).toContain("query");
    view.cancel();
});

test("paging reaches old results; Unicode/ANSI-like multiline preview is bounded and scrollable", () => {
    const { view, accepted } = picker(Array.from({ length: 1001 }, (_, i) => `entry ${i}`));
    view.render(70);

    for (let i = 0; i < 1001; i++) view.handleInput("\x1b[B");
    view.handleInput("\r");
    expect(accepted).toEqual(["entry 0"]);
    const long = picker(["\x1b[31m" + "🦊界\n".repeat(100)]);
    for (const width of [1, 8, 20, 80]) {
        const lines = long.view.render(width);
        expect(lines.length).toBeLessThanOrEqual(22);

        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(lines.join("\n")).not.toContain("\x1b[31m");
    }

    expect(safeText("\x1b]52;c;bad\x07")).not.toContain("\x1b");
    expect(long.view.render(100).join("\n")).toContain("Preview · lines 1");
    long.view.handleInput("\x1b[1;5B");
    expect(long.view.render(100).join("\n")).toContain("Preview · lines 2");
    long.view.cancel();
    const narrow = picker(["prompt"], 4);
    expect(narrow.view.render(12)).toHaveLength(2);
    narrow.view.cancel();
});
