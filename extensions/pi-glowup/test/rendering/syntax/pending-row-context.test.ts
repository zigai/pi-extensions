import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
    disposeSyntaxHighlighting,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
    observeSyntaxHighlightSource,
    settleSyntaxHighlights,
} from "../../../src/rendering/syntax/highlighter.ts";

afterEach(async () => disposeSyntaxHighlighting());

it.each([
    ["multiline comment", "/*\nconst duplicate = 1;\n*/\nconst duplicate = 1;"],
    ["template literal", "const text = `\nconst duplicate = 1;\n`;\nconst duplicate = 1;"],
])(
    "does not borrow an ambiguous identical row's %s colors during a rewrite",
    async (_label, source) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
        const invalidate = () => {};
        const render = (code: string) => {
            observeSyntaxHighlightSource(code, invalidate);
            return highlightSyntaxCode(code, "typescript", { invalidate, cache: false });
        };
        render(source);
        await settleSyntaxHighlights();
        const colored = render(source);
        expect(colored[1]).not.toBe(colored[3]);
        expect(colored[3]).toContain("\u001b[38;2;86;156;214mconst");
        const next = `// prefix\n${source}`;
        const pending = render(next);
        expect(pending[2]).toBe(colored[1]);
        expect(pending[4]).toBe(colored[3]);
        expect(pending.map(stripVTControlCharacters)).toEqual(next.split("\n"));
        await settleSyntaxHighlights();
        expect(render(next)[4]).toBe(colored[3]);
    },
);

it("leaves conflicting rows neutral when their immediate neighborhoods are also identical", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["typescript"] });
    const invalidate = () => {};
    const block = "const before = 0;\nconst duplicate = 1;\nconst after = 2;";
    const source = `/*\n${block}\n*/\n${block}`;
    const render = (code: string) => {
        observeSyntaxHighlightSource(code, invalidate);
        return highlightSyntaxCode(code, "typescript", { invalidate, cache: false });
    };
    render(source);
    await settleSyntaxHighlights();
    const colored = render(source);
    expect(colored[2]).not.toBe(colored[6]);
    const next = `// prefix\n${source}`;
    const pending = render(next);
    expect(pending[3]).toBe("const duplicate = 1;");
    expect(pending[7]).toBe("const duplicate = 1;");
    expect(pending.map(stripVTControlCharacters)).toEqual(next.split("\n"));
    await settleSyntaxHighlights();
    expect(render(next)[7]).toBe(colored[6]);
});
