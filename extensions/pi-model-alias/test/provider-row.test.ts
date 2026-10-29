import assert from "node:assert/strict";
import { Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { formatProviderRows } from "../src/provider-row.ts";

test("responsive provider rows reserve space for an inner pin column", () => {
    const initial = "    A very long renamed fixture model [Fixture]";
    const text = new Text(initial, 0, 0);
    const child = {
        text: initial,
        setText(value: string): void {
            this.text = value;
            text.setText(value);
        },
        render(width: number): string[] {
            return text.render(width - 2).map((line) => `* ${line}`);
        },
    };
    Object.defineProperty(child.render, Symbol.for("zigai.model-selector-pin-column"), {
        value: true,
    });
    formatProviderRows({ children: [child] }, [
        { modelText: "A very long renamed fixture model", providerText: "Fixture" },
    ]);
    const lines = child.render(32).map(stripTerminalSequences);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^\* .*…  Fixture\s*$/);
});
