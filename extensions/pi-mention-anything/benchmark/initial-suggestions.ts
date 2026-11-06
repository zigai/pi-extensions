import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { rankInitialSuggestions } from "../src/initial-suggestions.ts";

function suggestionNames(size: number): string[] {
    const prefixes = [
        "project",
        "Project",
        "ångström",
        "resume",
        "résumé",
        "工具",
        "Äpfel",
        "Alpha",
    ];

    const names = Array.from(
        { length: size },
        (_, index) =>
            `${prefixes.at(index % prefixes.length) ?? "project"}-${String(index).padStart(5, "0")}`,
    );
    let seed = 123456789;
    for (let index = names.length - 1; index > 0; index -= 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;

        const next = seed % (index + 1);
        const left = names.at(index);
        const right = names.at(next);
        if (left === undefined || right === undefined)
            throw new Error("Missing suggestion fixture");

        names[index] = right;
        names[next] = left;
    }

    return names;
}

const repeats = Number(process.argv[2] ?? 5);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100)
    throw new RangeError("Benchmark repeats must be an integer from 1 through 100");

console.log(
    JSON.stringify({
        node: process.version,
        locale: new Intl.Collator().resolvedOptions().locale,
        repeats,
    }),
);

for (const size of [1000, 5000, 10000]) {
    const names = suggestionNames(size);

    // Check the prior public collation contract outside the timed operation.
    const expected = [...names].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
    for (let repeat = 0; repeat < repeats; repeat += 1) {
        const started = performance.now();
        const result = rankInitialSuggestions(
            names,
            (name) => name,
            { strategy: "alphabetical", pinned: [] },
            new Map(),
            0,
        );
        const ms = performance.now() - started;
        assert.deepEqual(result, expected);
        console.log(
            JSON.stringify({
                size,
                repeat,
                ms,
                digest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
            }),
        );
    }
}
