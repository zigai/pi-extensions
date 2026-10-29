import { describe, expect, test } from "vitest";
import { unwrapTableFences } from "../src/table-fence-normalization.ts";

describe("table fence normalization", () => {
    test.each([
        [
            "```md\n| A | B |\n| --- | :---: |\n| x | y |\n```",
            "| A | B |\n| --- | :---: |\n| x | y |\n",
        ],
        [
            "before\n~~~MARKDOWN extra\r\na | b\r\n--- | ---\r\n~~~\r\nafter",
            "before\na | b\r\n--- | ---\r\nafter",
        ],
        ["> ```markdown\n> | A |\n> | --- |\n> | x |\n> ```\n", "> | A |\n> | --- |\n> | x |\n"],
        ["````md\n| a |\n| --- |\n`````\n", "| a |\n| --- |\n"],
    ])("unwraps %j", (input, expected) => expect(unwrapTableFences(input)).toBe(expected));

    test.each([
        "```md\n| a |\n| --- |\n",
        "```js\n| a |\n| --- |\n```",
        "```markdown\nordinary text\n```",
        "```md\n| a |\n| -- |\n```",
        "```md\n| a | b |\n| --- |\n```",
        "~~~md\n```text\n| a |\n| --- |\n```\n~~~",
        "```md\n| --- |\n| --- |\n```",
        "```md\na \\| b\n--- | ---\n```",
        "    ```md\n| a |\n| --- |\n    ```",
        "````md\n| a |\n| --- |\n```\n",
        "```md\n| a |\n| --- |\n~~~\n",
        "```text\n```md\n| a |\n| --- |\n```\n```",
    ])("preserves %j", (input) => expect(unwrapTableFences(input)).toBe(input));

    test("preserves code before a table and nested quote prefixes inside an unwrapped fence", () => {
        const body =
            "> > ```ts\n> > const value = 1;\n> > ```\n> >\n> > | Name |\n> > | --- |\n> > | value |\n";
        const input = "> > ~~~markdown\n" + body + "> > ~~~\n";
        expect(unwrapTableFences(input)).toBe(body);
    });

    test("handles multiple fences and preserves unclosed candidates", () => {
        const first = "```md\n| a |\n| --- |\n```\n";
        const last = "```markdown\n| b |\n| --- |\n";
        expect(unwrapTableFences(first + last)).toBe("| a |\n| --- |\n" + last);
    });
});
