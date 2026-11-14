import { describe, expect, it, vi } from "vitest";
import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    Container,
    Text,
    type TuiMouseEvent,
    type Component,
    stripTerminalSequences,
    visibleWidth,
} from "@earendil-works/pi-tui";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Timestamps } from "../src/timestamps.ts";
import { renderTimestamp, renderTimestampAtEnd, renderTimestampBelow } from "../src/render.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

describe("message timestamp rendering", () => {
    it("places a muted timestamp at the right of the first nonblank line without adding lines", () => {
        const result = renderTimestamp(["", "hello", "next"], 16, "12:34", dim).lines;
        expect(result).toEqual(["", "hello     \x1b[2m12:34\x1b[22m ", "next"]);
        expect(visibleWidth(result[1])).toBe(16);
    });

    it("does not cover content or split wide and combining characters", () => {
        expect(renderTimestamp(["你好 e\u0301  "], 10, "12:34", dim).lines).toEqual([
            "你好 e\u0301  ",
        ]);

        expect(
            stripTerminalSequences(renderTimestamp(["你好 e\u0301"], 15, "12:34", dim).lines[0]),
        ).toBe("你好 e\u0301   12:34 ");
    });

    it("omits the timestamp when the right margin would overlap message text", () => {
        expect(stripTerminalSequences(renderTimestamp(["hello"], 12, "12:34", dim).lines[0])).toBe(
            "hello 12:34 ",
        );

        expect(renderTimestamp(["hello"], 11, "12:34", dim).lines).toEqual(["hello"]);
    });

    it("keeps a divider intact and places the timestamp beside the message", () => {
        const lines = ["\x1b[2m────────────\x1b[0m", "", "hello"];
        const result = renderTimestamp(lines, 12, "12:34", dim);
        expect(result.lines.map(stripTerminalSequences)).toEqual([
            "────────────",
            "",
            "hello 12:34 ",
        ]);

        expect(result.hit).toEqual({ x: 6, y: 2, width: 5, renderWidth: 12 });
    });

    it("timestamps a short message made of divider characters", () => {
        expect(stripTerminalSequences(renderTimestamp(["────"], 16, "12:34", dim).lines[0])).toBe(
            "────      12:34 ",
        );
    });

    it("retains backgrounds and OSC sequences in their original order", () => {
        const line = "\x1b]133;A\x07\x1b[44mhi         \x1b[0m\x1b]133;B\x07";
        const result = renderTimestamp([line], 11, "12:34", dim).lines[0];
        expect(result).toBe(
            "\x1b]133;A\x07\x1b[44mhi   \x1b[2m12:34\x1b[22m \x1b[0m\x1b]133;B\x07",
        );

        expect(visibleWidth(result)).toBe(11);
    });

    it("coalesces printable padding without moving controls across the inserted label", () => {
        expect(
            renderTimestamp(["\x1b[44mhi  \x1b[43m       \x1b[0m"], 11, "12:34", dim).lines,
        ).toEqual(["\x1b[44mhi  \x1b[43m \x1b[2m12:34\x1b[22m \x1b[0m"]);

        expect(renderTimestamp(["hi    \x1b[43m     \x1b[0m"], 11, "12:34", dim).lines).toEqual([
            "hi   \x1b[2m12:34\x1b[22m\x1b[43m \x1b[0m",
        ]);
    });

    it("never treats a space with a combining mark as replaceable ASCII padding", () => {
        const lines = ["a   \u0301"];
        expect(renderTimestamp(lines, 10, "12:34", dim).lines).toBe(lines);
    });

    it("leaves unsupported control sequences and lines without text untouched", () => {
        expect(renderTimestamp(["\x1b?hello"], 20, "12:34", dim).lines).toEqual(["\x1b?hello"]);
        expect(renderTimestamp(["     "], 20, "12:34", dim).lines).toEqual(["     "]);
    });
});

describe("timestamp hit geometry", () => {
    it("reports the label cells on the first nonblank row after ANSI and wide content", () => {
        const rendered = renderTimestamp(["", "\x1b[44m你好\x1b[0m"], 15, "12:34", dim);
        expect(rendered.hit).toEqual({ x: 9, y: 1, width: 5, renderWidth: 15 });
        expect(stripTerminalSequences(rendered.lines[1])).toBe("你好     12:34 ");
    });

    it("does not report a target when a label is omitted or no longer fits after resize", () => {
        expect(renderTimestamp(["hello"], 12, "12:34", dim).hit).toEqual({
            x: 6,
            y: 0,
            width: 5,
            renderWidth: 12,
        });

        expect(renderTimestamp(["hello"], 11, "12:34", dim).hit).toBeUndefined();
        expect(renderTimestamp(["\x1b?hello"], 20, "12:34", dim).hit).toBeUndefined();
        expect(renderTimestamp(["hello"], 20, "", dim).hit).toBeUndefined();
    });
});

describe("last-line timestamp placement", () => {
    it("places the label on the last text line, past trailing blank lines", () => {
        const result = renderTimestampAtEnd(["first", "last", ""], 16, "12:34", dim);
        expect(result.lines.map(stripTerminalSequences)).toEqual(["first", "last      12:34 ", ""]);
        expect(result.hit).toEqual({ x: 10, y: 1, width: 5, renderWidth: 16 });
    });

    it("adds a right-aligned line when the last line has no room", () => {
        const result = renderTimestampAtEnd(["first", "a full last line", ""], 16, "12:34", dim);
        expect(result.lines.map(stripTerminalSequences)).toEqual([
            "first",
            "a full last line",
            "          12:34 ",
            "",
        ]);

        expect(result.hit).toEqual({ x: 10, y: 2, width: 5, renderWidth: 16 });
    });

    it("leaves messages without text, and widths too narrow for the label, unchanged", () => {
        expect(renderTimestampAtEnd(["", "  "], 16, "12:34", dim)).toEqual({ lines: ["", "  "] });
        expect(renderTimestampAtEnd(["hi"], 5, "12:34", dim)).toEqual({ lines: ["hi"] });
    });
});

describe("timestamp line below the message", () => {
    it("adds a blank line and an aligned details line after the last text line", () => {
        const result = renderTimestampBelow(
            ["", " first", " last", ""],
            40,
            "12:34",
            ["model", "1.2k in"],
            dim,
        );
        expect(result.lines.map(stripTerminalSequences)).toEqual([
            "",
            " first",
            " last",
            "",
            " 12:34 · model · 1.2k in",
            "",
        ]);

        expect(result.hit).toEqual({ x: 1, y: 4, width: 5, renderWidth: 40 });
    });

    it("truncates the details line to the render width", () => {
        const result = renderTimestampBelow(["text"], 16, "12:34", ["a long model name"], dim);
        const footer = result.lines.at(-1) ?? "";
        expect(visibleWidth(footer)).toBeLessThanOrEqual(16);
        expect(stripTerminalSequences(footer).startsWith("12:34 · ")).toBe(true);
    });

    it("leaves messages without text unchanged", () => {
        expect(renderTimestampBelow(["", " "], 16, "12:34", ["model"], dim)).toEqual({
            lines: ["", " "],
        });
    });
});

describe("session timestamp interaction", () => {
    it("cycles every row, forwards other gestures, owns the relative timer, and restores patches", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2020, 0, 2, 10, 30));
        const prototype = sdk.InteractiveMode.prototype;
        const addDescriptor = Object.getOwnPropertyDescriptor(prototype, "addMessageToChat");
        const eventDescriptor = Object.getOwnPropertyDescriptor(prototype, "handleEvent");
        let forwarded = 0;
        let renders = 0;
        const row = new Container();
        row.addChild({
            render: () => ["hello"],
            invalidate: () => {},
            handleMouse: () => {
                forwarded++;
                return { handled: true };
            },
        });
        const other = new Container();
        other.addChild({ render: () => ["world"], invalidate: () => {} });
        const sessionManager = { getSessionId: () => "session", getBranch: () => [] };
        const bare: Component = { render: () => ["bare"], invalidate: () => {} };
        const children: Component[] = [];
        const host = {
            sessionManager,
            chatContainer: { children },
            ui: {
                requestRender: () => {
                    renders++;
                },
            },
        };
        const long = new Text("alpha beta gamma delta", 0, 0);
        const divider = new Container();
        divider.addChild({ render: (width) => ["─".repeat(width)], invalidate: () => {} });
        divider.addChild(new Text("alpha beta gamma delta", 0, 0));
        const pending: Component[] = [row, other, bare, long, divider];
        Object.setPrototypeOf(host, prototype);
        Object.defineProperty(prototype, "addMessageToChat", {
            configurable: true,
            writable: true,
            value(this: typeof host) {
                const next = pending.shift();
                if (next) this.chatContainer.children.push(next);
            },
        });
        Object.defineProperty(prototype, "handleEvent", {
            configurable: true,
            writable: true,
            value() {},
        });
        // SAFETY: This fixture supplies the only context members used by this controller.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion, antislop/no-chained-type-assertions -- The fixture intentionally implements only the exercised host boundary.
        const ctx = { sessionManager, ui: { notify() {} } } as unknown as ExtensionContext;
        Object.defineProperty(ctx.ui, "theme", {
            value: {
                bg: (_name: string, text: string) => text,
                fg: (_name: string, text: string) => dim(text),
            },
        });
        const controller = new Timestamps(ctx, {
            enabled: true,
            format: "auto",
            assistantPlacement: "first-line",
        });
        let successor: { dispose(): void } | undefined;
        try {
            const methods = Type.Object({
                addMessageToChat: Type.Function([Type.Unknown()], Type.Void()),
            });
            if (!Value.Check(methods, host)) throw new Error("host method unavailable");

            const timestamp = new Date(2020, 0, 1, 10, 30).getTime();
            host.addMessageToChat({ role: "user", timestamp });
            host.addMessageToChat({ role: "user", timestamp });
            host.addMessageToChat({ role: "user", timestamp });
            host.addMessageToChat({ role: "user", timestamp });
            const longLines = long.render(30).map(stripTerminalSequences);
            expect(longLines[0]).toBe("alpha beta   01.01.2020 10:30 ");
            expect(
                longLines
                    .slice(1)
                    .map((line) => line.trim())
                    .join(" "),
            ).toBe("gamma delta");

            host.addMessageToChat({ role: "user", timestamp });
            const dividerLines = divider.render(30).map(stripTerminalSequences);
            expect(dividerLines).toEqual([
                "──────────────────────────────",
                "alpha beta   01.01.2020 10:30 ",
                "gamma delta                   ",
            ]);
            const mouseMethod = Type.Object({
                handleMouse: Type.Function([Type.Unknown()], Type.Unknown()),
            });
            if (!Value.Check(mouseMethod, bare)) throw new Error("mouse handler unavailable");

            successor = installLinkedMethodPatch(
                bare,
                "handleMouse",
                (previous) =>
                    function (event) {
                        return previous.call(this, event);
                    },
            );
            const event: TuiMouseEvent = {
                type: "press",
                button: "left",
                x: 14,
                y: 0,
                screenX: 14,
                screenY: 0,
                width: 25,
                height: 1,
                shift: false,
                alt: false,
                ctrl: false,
            };
            expect(stripTerminalSequences(row.render(25)[0])).toContain("01.01.2020 10:30");
            expect(stripTerminalSequences(other.render(25)[0])).toContain("01.01.2020 10:30");
            bare.render(25);
            expect(bare.handleMouse(event)).toEqual({ handled: true });
            const layout = new Container();
            layout.addChild(row);
            layout.render(25);
            const press = layout.handleMouse(event);
            expect(press?.target.component).toBe(row);
            expect(forwarded).toBe(0);
            row.handleMouse({ ...event, type: "click" });
            expect(stripTerminalSequences(row.render(25)[0])).toContain("10:30");
            expect(stripTerminalSequences(other.render(25)[0])).not.toContain("01.01.2020");
            row.handleMouse({ ...event, x: 19, type: "click" });
            expect(stripTerminalSequences(row.render(25)[0])).toContain("01.01.2020 10:30");
            row.handleMouse({ ...event, type: "click" });
            expect(stripTerminalSequences(other.render(25)[0])).toContain("1d ago");
            expect(vi.getTimerCount()).toBe(1);
            const before = renders;
            vi.advanceTimersByTime(60_000);
            expect(renders).toBe(before + 1);
            other.handleMouse({ ...event, x: 18, type: "click" });
            expect(vi.getTimerCount()).toBe(0);
            expect(stripTerminalSequences(row.render(25)[0])).toContain("01.01.2020 10:30");
            row.handleMouse({ ...event, x: 0, type: "click" });
            row.handleMouse({ ...event, x: 14, width: 24 });
            row.handleMouse({ ...event, button: "right" });
            expect(stripTerminalSequences(row.render(7)[0])).toBe("hello");
            row.handleMouse({ ...event, x: 1, width: 7, type: "click" });
            expect(forwarded).toBe(4);
            row.render(25);
            row.handleMouse({ ...event, x: 14, type: "click" });
            row.render(25);
            row.handleMouse({ ...event, x: 19, type: "click" });
            row.render(25);
            row.handleMouse({ ...event, x: 14, type: "click" });
            expect(vi.getTimerCount()).toBe(1);
        } finally {
            controller.dispose();
            expect(vi.getTimerCount()).toBe(0);
            successor?.dispose();
            expect(Object.hasOwn(bare, "handleMouse")).toBe(false);
            const reset = new Timestamps(ctx, {
                enabled: true,
                format: "relative",
                assistantPlacement: "first-line",
            });
            expect(vi.getTimerCount()).toBe(1);
            reset.dispose();
            expect(vi.getTimerCount()).toBe(0);

            if (addDescriptor) Object.defineProperty(prototype, "addMessageToChat", addDescriptor);
            if (eventDescriptor) Object.defineProperty(prototype, "handleEvent", eventDescriptor);
            vi.useRealTimers();
        }

        expect(stripTerminalSequences(row.render(25)[0])).toBe("hello");
    });
});
