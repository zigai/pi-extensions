import assert from "node:assert/strict";
import {
    backgroundAnsi,
    foregroundAnsi,
    rgbColor,
    stripTerminalSequences,
    visibleWidth,
    type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { test } from "vitest";
import { enlargeStartupLogo } from "../src/startup-logo.ts";

const RESET = "\u001b[0m";

function nativeLogo(mode: TerminalColorMode): string[] {
    const coral = foregroundAnsi(rgbColor(228, 138, 122), mode);
    const blue = foregroundAnsi(rgbColor(79, 142, 179), mode);
    const blueBackground = backgroundAnsi(rgbColor(79, 142, 179), mode);
    const yellow = foregroundAnsi(rgbColor(234, 182, 93), mode);
    return [
        ` ${coral}${blueBackground}▀${RESET}${coral}▀█${RESET} `,
        ` ${blue}█▀${RESET} ${yellow}█${RESET}`,
    ];
}

test.each(["truecolor", "256color"] as const)(
    "2x logo preserves native color codes and background pixels in %s",
    (mode) => {
        const source = nativeLogo(mode);
        const enlarged = enlargeStartupLogo(source);
        assert.ok(enlarged);
        assert.equal(enlarged.length, 4);
        assert.ok(enlarged.every((row) => visibleWidth(row) === 8));
        assert.deepEqual(enlarged.map(stripTerminalSequences), [
            "██████  ",
            "    ██  ",
            "████  ██",
            "██    ██",
        ]);
        assert.ok(enlarged[0].includes(foregroundAnsi(rgbColor(228, 138, 122), mode)));
        assert.ok(enlarged[1].includes(backgroundAnsi(rgbColor(79, 142, 179), mode)));
        assert.ok(enlarged[2].includes(foregroundAnsi(rgbColor(79, 142, 179), mode)));
        assert.ok(enlarged[3].includes(foregroundAnsi(rgbColor(234, 182, 93), mode)));
    },
);

test("early-startup and reload handoffs never enlarge an already-enlarged logo again", () => {
    const enlarged = enlargeStartupLogo(nativeLogo("truecolor"));
    assert.ok(enlarged);
    let header = enlarged.map((row) => ` ${row}`);
    for (let pass = 0; pass < 4; pass += 1) {
        const next = enlargeStartupLogo(header);
        assert.ok(next);
        assert.deepEqual(next.map(stripTerminalSequences), enlarged.map(stripTerminalSequences));
        assert.ok(next.every((row) => visibleWidth(row) === 8));
        header = next.map((row) => ` ${row}`);
    }
});

test("text wordmarks, unknown artwork and missing rows retain their native fallback", () => {
    assert.equal(enlargeStartupLogo([" Pi v1", " old help"]), undefined);
    assert.equal(enlargeStartupLogo([" ▄▀▄▀", " ▀▄▀▄"]), undefined);
    assert.equal(enlargeStartupLogo([]), undefined);
});
