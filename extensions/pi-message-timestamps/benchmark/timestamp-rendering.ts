import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { renderTimestamp } from "../src/render.ts";

const repeats = Number(process.argv[2] ?? 5);
const iterations = Number(process.argv[3] ?? 10000);

if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100)
    throw new RangeError("Benchmark repeats must be an integer from 1 through 100");

if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 1000000)
    throw new RangeError("Benchmark iterations must be an integer from 1 through 1000000");

const fixtures = [
    {
        name: "ascii-padded",
        line: " Invented historical row: stable benchmark content.".padEnd(140),
        width: 140,
    },
    { name: "ansi-padded", line: `\u001b[44m${"Invented row".padEnd(138)}\u001b[0m`, width: 140 },
    { name: "unicode", line: "你好 e\u0301 👩‍💻".padEnd(130), width: 140 },
    { name: "control-rejection", line: "unsupported\tcontent", width: 140 },
];

console.log(JSON.stringify({ node: process.version, repeats, iterations }));
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

for (const fixture of fixtures) {
    const lines = [fixture.line];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
        global.gc?.();

        const started = performance.now();
        let rendered = renderTimestamp(lines, fixture.width, "02.01.2024 12:00", dim);
        for (let index = 1; index < iterations; index += 1)
            rendered = renderTimestamp(lines, fixture.width, "02.01.2024 12:00", dim);

        const ms = performance.now() - started;
        assert.equal(rendered.lines.length, lines.length);
        assert.deepEqual(lines, [fixture.line]);
        console.log(
            JSON.stringify({
                name: fixture.name,
                repeat,
                ms,
                digest: createHash("sha256").update(JSON.stringify(rendered)).digest("hex"),
            }),
        );
    }
}
