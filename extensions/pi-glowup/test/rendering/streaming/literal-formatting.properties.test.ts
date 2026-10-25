import { fc } from "@fast-check/vitest";
import { runInNewContext } from "node:vm";
import { format } from "oxfmt";
import { expect, it } from "vitest";
import { createCodeStreamStore } from "../../../src/rendering/streaming/code-stream.ts";

const payloads = fc.array(
    fc.constantFrom(
        "text",
        "\t",
        "\n",
        "\r\n",
        "😀",
        "e\u0301",
        "`",
        "${x}",
        "\\",
        "$&",
        "__glowup_unit_0__",
    ),
    { minLength: 1, maxLength: 14 },
);

it("keeps literal values cache-equivalent across seeded streaming chunks, rewrites and resizes", async () => {
    await fc.assert(
        fc.asyncProperty(payloads, fc.integer({ min: 1, max: 19 }), async (parts, chunkSize) => {
            const payload = "first\n" + parts.join("") + "\nlast";
            const escaped = payload
                .replace(/\\/gu, "\\\\")
                .replace(/`/gu, "\\`")
                .replace(/\$\{/gu, "\\${");
            const source = `function f(){\n return \`${escaped}\`;\n}\nf();`;
            const subject = createCodeStreamStore();
            const cold = createCodeStreamStore();
            const input = {
                key: "literal-property",
                source: "",
                language: "javascript",
                mode: "statement" as const,
                complete: false,
                formatter: async ({ code }: { code: string }) => {
                    const result = await format("unit.js", code, { tabWidth: 2 });
                    expect(result.errors).toEqual([]);
                    return result.code;
                },
            };
            try {
                for (let end = chunkSize; end < source.length; end += chunkSize) {
                    subject.get({ ...input, source: source.slice(0, end) });
                    await subject.settled();
                }

                const complete = { ...input, source, complete: true };
                subject.get(complete);
                cold.get(complete);
                await Promise.all([subject.settled(), cold.settled()]);
                expect(subject.get(complete)).toBe(cold.get(complete));
                expect(runInNewContext(subject.get(complete), {})).toEqual(
                    runInNewContext(source, {}),
                );

                const rewritten = {
                    ...complete,
                    source: source.replace("first", "replacement"),
                    targetWidth: 40,
                };
                subject.get(rewritten);
                cold.clear();
                cold.get(rewritten);
                await Promise.all([subject.settled(), cold.settled()]);
                expect(subject.get(rewritten)).toBe(cold.get(rewritten));
                expect(runInNewContext(subject.get(rewritten), {})).toEqual(
                    runInNewContext(rewritten.source, {}),
                );
            } finally {
                await Promise.all([subject.dispose(), cold.dispose()]);
            }
        }),
        { seed: 0x6c17_2026, numRuns: 30 },
    );
}, 30_000);
