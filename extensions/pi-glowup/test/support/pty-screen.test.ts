import { Terminal } from "@xterm/headless";
import { expect, it } from "vitest";
import { screenRows } from "../pty/pi-process-harness.ts";

it.each([
    { alternate: false, expected: ["abcd", "efgh", "ijkl", "NEXT"] },
    { alternate: true, expected: ["abcd", "NEXT"] },
])(
    "captures only visible cells after shrinking (alternate=$alternate)",
    async ({ alternate, expected }) => {
        const terminal = new Terminal({ allowProposedApi: true, cols: 12, rows: 8 });
        try {
            let prefix = "";
            if (alternate) prefix = "\u001b[?1049h";
            await new Promise<void>((resolve) => {
                terminal.write(`${prefix}abcdefghijkl\r\nNEXT`, resolve);
            });
            terminal.resize(4, 8);
            const rows = screenRows(terminal);
            expect(rows.slice(0, expected.length).map((row) => row.text)).toEqual(expected);
            expect(rows).toHaveLength(8);
            if (alternate) {
                // xterm retains the alternate buffer's hidden cells for a later grow.
                expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(
                    "abcdefghijkl",
                );
                expect(rows[0]?.isWrapped).toBe(false);
                terminal.resize(12, 8);
                expect(screenRows(terminal)[0]?.text).toBe("abcdefghijkl");
            } else {
                // Do not hide genuine wrapping while restricting text to the viewport.
                expect(rows.slice(0, 4).map((row) => row.isWrapped)).toEqual([
                    false,
                    true,
                    true,
                    false,
                ]);
            }
        } finally {
            terminal.dispose();
        }
    },
);
