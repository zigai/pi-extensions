import { afterEach, describe, expect, it } from "vitest";
import { createStreamingPresentation } from "../../../src/rendering/streaming/content-presentation.ts";
import { createCodeStreamStore } from "../../../src/rendering/streaming/code-stream.ts";
import {
    presentGlowupContent,
    presentGlowupSnapshot,
    registerGlowupStreamingPolicy,
} from "../../../src/tools/protocol/contract.ts";

const dispose: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const release of dispose.splice(0).reverse()) await release();
});

function install(
    prose: "token" | "sentence" | "paragraph" = "sentence",
    code: "token" | "statement" | "block" = "statement",
) {
    const streams = createCodeStreamStore();
    dispose.push(() => streams.dispose());
    const policy = createStreamingPresentation(() => ({ prose, code, streams }));
    const handle = registerGlowupStreamingPolicy(policy);
    dispose.push(() => handle.dispose());
    return { streams, policy };
}

describe("shared generated-content presentation", () => {
    it.each([
        ["javascript", "// settled comment\r\nconst ready=1;"],
        ["python", "# settled comment\r\nready=1\r\n"],
        ["bash", "first & second;"],
    ])("does not hold valid %s separators after enforcing safe gaps", async (language, source) => {
        const { streams } = install();
        const input = { key: language, kind: "code" as const, source, language, complete: false };
        presentGlowupContent(input);
        await streams.settled();
        expect(presentGlowupContent(input)).toBe(
            source.trimEnd().replace(/;$/u, (suffix) => {
                if (language === "bash") return "";
                return suffix;
            }),
        );
    });

    it.each(["statement", "block"] as const)(
        "holds indented code under %s policy without inventing a language",
        async (code) => {
            const { streams } = install("sentence", code);
            const input = {
                key: "indented",
                kind: "markdown" as const,
                source: "    const unfinished =\n\n",
                complete: false,
            };
            presentGlowupContent(input);
            await streams.settled();
            expect(presentGlowupContent(input)).toBe("");
            expect(await presentGlowupSnapshot({ ...input, complete: true })).toBe(input.source);
        },
    );

    it.each([
        ["token", "token"],
        ["token", "statement"],
        ["token", "block"],
        ["sentence", "token"],
        ["sentence", "statement"],
        ["sentence", "block"],
        ["paragraph", "token"],
        ["paragraph", "statement"],
        ["paragraph", "block"],
    ] as const)(
        "keeps prose=%s independent of code=%s across partial and final content",
        async (prose, code) => {
            const { streams } = install(prose, code);
            const source = "```javascript\nconst ready=1;\nconst pending =";
            const input = { key: "matrix", kind: "markdown" as const, source, complete: false };
            presentGlowupContent(input);
            await streams.settled();
            const partial = presentGlowupContent(input);
            if (code === "token") expect(partial).toBe(source);
            else if (code === "statement") {
                expect(partial).toContain("const ready=1;");
                expect(partial).not.toContain("pending");
            } else expect(partial).toBe("");
            expect(await presentGlowupSnapshot({ ...input, complete: true })).toBe(source);
            expect(input.source).toBe(source);
        },
    );

    it("applies identical code policy to thinking, text and external Markdown snapshots", async () => {
        const { streams } = install();
        const source = "```javascript\nconst ready=1;\nconst pending =\n\n";
        for (const key of ["thinking", "assistant", "child-preview"]) {
            const input = { key, source, kind: "markdown" as const, complete: false };
            presentGlowupContent(input);
            await streams.settled();
            expect(presentGlowupContent(input)).toContain("const ready=1;");
            expect(presentGlowupContent(input)).not.toContain("pending");
        }
    });

    it.each(["token", "sentence", "paragraph"] as const)(
        "uses %s prose mode for declared generated output",
        (prose) => {
            install(prose);
            const input = {
                key: "prose",
                kind: "prose" as const,
                source: "Ready. Unfinished",
                complete: false,
            };
            const expected = { token: input.source, sentence: "Ready. ", paragraph: "" };
            expect(presentGlowupContent(input)).toBe(expected[prose]);
            expect(presentGlowupContent({ ...input, complete: true })).toBe(input.source);
            expect(presentGlowupContent({ ...input, mode: "immediate" })).toBe(input.source);
        },
    );

    it("does not resurrect disposed registrations or publish a stale snapshot after reset", async () => {
        const input = {
            key: "session",
            kind: "prose" as const,
            source: "unfinished",
            complete: false,
        };
        const first = registerGlowupStreamingPolicy({
            present: () => "first",
            settled: async () => {},
        });
        const second = registerGlowupStreamingPolicy({
            present: () => "second",
            settled: async () => {},
        });
        expect(presentGlowupContent(input)).toBe("second");
        first.dispose();
        second.dispose();
        second.dispose();
        expect(presentGlowupContent(input)).toBe(input.source);
        const handle = registerGlowupStreamingPolicy({
            present: () => "stale",
            settled: async () => {
                handle.dispose();
            },
        });
        expect(await presentGlowupSnapshot(input)).toBe("");
    });

    it.each(["value = (1 +\n 2)\n", "value = \\\n1\n", 'value = """first\nsecond"""\n'])(
        "preserves legitimate Python continuation boundaries: %s",
        async (source) => {
            const { streams } = install();
            const input = {
                key: "python-valid",
                kind: "code" as const,
                source,
                language: "python",
                complete: false,
            };
            presentGlowupContent(input);
            await streams.settled();
            expect(presentGlowupContent(input)).toBe(source.trimEnd());
        },
    );

    it("rejects a snapshot across reset even when the same presenter is re-registered", async () => {
        let replacement: { dispose(): void } | undefined;
        const policy = {
            present: () => "stale",
            settled: async () => {
                registration.dispose();
                replacement = registerGlowupStreamingPolicy(policy);
            },
        };
        const registration = registerGlowupStreamingPolicy(policy);
        try {
            expect(
                await presentGlowupSnapshot({
                    key: "reset",
                    kind: "prose",
                    source: "source",
                    complete: false,
                }),
            ).toBe("");
        } finally {
            registration.dispose();
            replacement?.dispose();
        }
    });

    it.each([
        ["javascript", "if (\nconst okay=1;"],
        ["python", "broken =\nokay=1\n"],
    ])("holds invalid gaps in %s until explicit final completion", async (language, source) => {
        const { streams } = install();
        const input = { key: language, kind: "code" as const, source, language, complete: false };
        presentGlowupContent(input);
        await streams.settled();
        expect(presentGlowupContent(input)).toBe("");
        expect(await presentGlowupSnapshot({ ...input, complete: true })).toBe(source);
    });
});
