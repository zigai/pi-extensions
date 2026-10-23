import { expect, it } from "vitest";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    Markdown,
    visibleWidth,
    wrapTextWithAnsi,
    type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { readFileSync } from "node:fs";
import { renderCodexTable, registerTableRenderer, selectTableRenderer } from "../src/index.ts";
import { installResponseRendering } from "../src/response-rendering.ts";
import { markFencesHidden } from "../src/markdown-rendering.ts";
import { installTableRendering } from "../src/table-patch.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: (text) => `\u001b[31m${text}\u001b[39m`,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
};

it("uses open columns, segmented rules, left headers and aligned body cells", () => {
    expect(
        renderCodexTable({
            headers: ["Name", "Count"],
            rows: [
                ["alpha", "42"],
                ["beta", "7"],
            ],
            align: [null, "right"],
            width: 30,
            header: identity,
            rule: identity,
        }),
    ).toEqual([
        " Name   Count ",
        " ─────  ───── ",
        " alpha     42 ",
        " ─────  ───── ",
        " beta       7 ",
    ]);
});

it.each([
    ["foreground", "\u001b[31m", "\u001b[39m"],
    ["bold", "\u001b[1m", "\u001b[22m"],
    ["foreground and bold", "\u001b[31;1m", "\u001b[39;22m"],
])("keeps wrapped %s styling inside its cell", (_name, start, end) => {
    const rows = renderCodexTable({
        headers: ["First", "Second"],
        rows: [[`${start}abcdefghijklmnopqrstuvwx${end}`, "plain"]],
        align: [null, null],
        width: 30,
        header: identity,
        rule: identity,
    });

    expect(
        rows
            .filter((row) => row.includes("plain"))
            .map((row) => wrapTextWithAnsi(`${row.slice(0, row.indexOf("plain"))}!`, 1).at(-1)),
    ).toEqual(["!"]);

    expect(wrapTextWithAnsi(`${rows.at(-1)}!`, 1).at(-1)).toBe("!");
});

it.each(["\n", "\r\n", "\r"])("aligns multiline cells using physical rows (%j)", (newline) => {
    const rows = renderCodexTable({
        headers: ["A", "B"],
        rows: [[`a${newline}b`, "plain"]],
        align: [null, null],
        width: 30,
        header: identity,
        rule: identity,
    });

    expect(rows.map(stripVTControlCharacters)).toEqual([
        " A   B     ",
        " ──  ───── ",
        " a   plain ",
        " b         ",
    ]);
});

it.each([0, 1, 2])(
    "omits tables too narrow for content and both margins at %i columns",
    (width) => {
        expect(
            renderCodexTable({
                headers: ["Name"],
                rows: [["alpha"]],
                align: [null],
                width,
                header: identity,
                rule: identity,
            }),
        ).toEqual([]);
    },
);

it.each([3, 5, 7, 8, 9, 12, 32, 80])(
    "keeps left and right padding through Markdown wrapping at %i columns",
    async (width) => {
        const handle = await installResponseRendering();
        try {
            selectTableRenderer("codex");
            const markdown = new Markdown(
                "| Name | Value |\n| --- | ---: |\n| alpha | `界123456789012345678901234567890` |",
                0,
                0,
                theme,
            );
            markFencesHidden(markdown);

            const lines = markdown.render(width).map(stripVTControlCharacters);

            expect(lines.some((line) => line.trim().length > 0)).toBe(true);
            expect(lines.every((line) => line.startsWith(" "))).toBe(true);
            expect(lines.every((line) => line.endsWith(" "))).toBe(true);
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        } finally {
            handle.dispose();
        }
    },
);

it.each([28, 32])("keeps short fields readable when a long column wraps at %i columns", (width) => {
    const rows = renderCodexTable({
        headers: ["Group", "Size", "Details"],
        rows: [["alpha", "42", "a wide note with data"]],
        align: [null, "right", null],
        width,
        header: identity,
        rule: identity,
    });
    expect(rows[0]).toContain("Group");
    expect(rows[0]).toContain("Size");
    expect(rows.some((row) => row.includes("alpha") && row.includes("42"))).toBe(true);
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
});

it.each([
    [100, 98, 39, 26],
    [26, 39, 98, 100],
    [1000, 100, 20, 2],
])("balances constrained columns without starving any field (%j)", (...natural) => {
    for (const width of [16, 17, 40, 80, 100, 173, 280]) {
        const lines = renderCodexTable({
            headers: natural.map(() => "H"),
            rows: [natural.map((size) => "x".repeat(size))],
            align: natural.map(() => null),
            width,
            header: identity,
            rule: identity,
        });
        const widths = [...(lines[1] ?? "").matchAll(/─+/gu)].map((match) => match[0].length);
        expect(widths).toHaveLength(natural.length);
        expect(widths.reduce((sum, size) => sum + size, 0)).toBe(
            Math.min(
                width - 8,
                natural.reduce((sum, size) => sum + size, 0),
            ),
        );
        for (const [index, size] of widths.entries()) {
            expect(size).toBeGreaterThanOrEqual(2);
            expect(size).toBeLessThanOrEqual(natural[index] ?? 0);
            if (size < (natural[index] ?? 0)) {
                expect(Math.max(...widths) - size).toBeLessThanOrEqual(1);
            }
        }
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
});

it("keeps the screenshot's long prose columns readable through Markdown and resizing", async () => {
    const handle = await installResponseRendering();
    try {
        selectTableRenderer("codex");
        const source = readFileSync(
            new URL("./fixtures/card-sources-table.md", import.meta.url),
            "utf8",
        );
        const markdown = new Markdown(source, 0, 0, theme);
        markFencesHidden(markdown);
        for (const width of [173, 100, 180, 173]) {
            const rendered = markdown.render(width);
            const lines = rendered.map(stripVTControlCharacters);
            const rule = lines.find((line) => line.includes("──")) ?? "";
            const widths = [...rule.matchAll(/─+/gu)].map((match) => match[0].length);
            expect(Math.min(...widths)).toBeGreaterThanOrEqual(23);
            expect(lines.length).toBeLessThan(35);
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            if (width === 173) expect(widths).toEqual([39, 50, 50, 26]);
            expect(rendered.join("\n")).toContain("\u001b[31mhsbg_data\u001b[39m");
        }
    } finally {
        handle.dispose();
    }
});

it("replaces actual table layout without replacing inline Markdown or adjacent prose", async () => {
    const handle = await installResponseRendering();
    selectTableRenderer("codex");
    try {
        const markdown = new Markdown(
            "Before.\n\n| Name | Value |\n| --- | --- |\n| alpha | `styled` |\n\nAfter.",
            0,
            0,
            theme,
        );
        markFencesHidden(markdown);
        const wide = markdown.render(50);
        expect(wide.map((line) => stripVTControlCharacters(line).trimEnd())).toEqual([
            "Before.",
            "",
            " Name   Value",
            " ─────  ──────",
            " alpha  styled",
            "",
            "After.",
        ]);

        expect(wide.join("\n")).toContain("\u001b[31mstyled\u001b[39m");
        const narrow = markdown.render(7);
        expect(narrow.every((row) => visibleWidth(row) <= 7)).toBe(true);
        expect(narrow.join("\n")).not.toContain("┌");
        expect(narrow.map(stripVTControlCharacters).join("\n")).toContain("alpha");
    } finally {
        handle.dispose();
    }
});

it.each([
    { renderer: "codex", padding: 0 },
    { renderer: "codex", padding: 1 },
    { renderer: "codex", padding: 2 },
    { renderer: "native", padding: 1 },
])(
    "keeps one blank line around assistant tables with $renderer and padding $padding",
    async ({ renderer, padding }) => {
        const handle = await installResponseRendering();
        try {
            selectTableRenderer(renderer);
            const message: AssistantMessage = {
                role: "assistant",
                content: [
                    {
                        type: "text",
                        text: "Data:\n\n| Category | Count |\n| --- | --- |\n| sample | 2 |\n\nDone.",
                    },
                ],
                api: "openai-responses",
                provider: "synthetic",
                model: "sample",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: 0,
            };
            const component = new AssistantMessageComponent(
                message,
                false,
                theme,
                "Thinking",
                padding,
            );

            for (const width of [80, 12, 9, 80]) {
                const lines = component
                    .render(width)
                    .map((line) => stripVTControlCharacters(line).trim());
                const intro = lines.indexOf("Data:");
                const outro = lines.indexOf("Done.");
                expect(intro).toBeGreaterThanOrEqual(0);
                expect(lines.at(intro + 1)).toBe("");
                expect(lines.at(intro + 2)).not.toBe("");
                expect(outro).toBeGreaterThan(intro + 2);
                expect(lines.at(outro - 1)).toBe("");
                expect(lines.at(outro - 2)).not.toBe("");
            }
        } finally {
            handle.dispose();
        }
    },
);

it("does not keep table spacing after replacing its cells with ordinary paragraphs", async () => {
    const handle = await installResponseRendering();
    try {
        selectTableRenderer("codex");
        const markdown = new Markdown(
            "| First paragraph. |\n| --- |\n| Last paragraph. |",
            1,
            0,
            theme,
        );
        markFencesHidden(markdown);
        markdown.render(80);
        markdown.setText("First paragraph.\n\nLast paragraph.");

        expect(markdown.render(80).map((line) => stripVTControlCharacters(line).trim())).toEqual([
            "First paragraph.",
            "Last paragraph.",
        ]);
    } finally {
        handle.dispose();
    }
});

it("restores native table borders on the same Markdown instance and width after patch disposal", async () => {
    const handle = await installResponseRendering();
    try {
        const markdown = new Markdown("| Name |\n| --- |\n| alpha |", 0, 0, theme);
        markFencesHidden(markdown);
        selectTableRenderer("codex");
        expect(markdown.render(40).map((line) => stripVTControlCharacters(line).trimEnd())).toEqual(
            [" Name", " ─────", " alpha"],
        );

        handle.dispose();

        const restored = markdown.render(40).map(stripVTControlCharacters).join("\n");
        expect(restored).toContain("┌");
        expect(restored).toContain("└");
        expect(restored).toContain("alpha");
    } finally {
        handle.dispose();
    }
});

it.each([0, 1])(
    "keeps tables patched until the last owner disposes (first disposal: %i)",
    async (first) => {
        const originalRender = Object.getOwnPropertyDescriptor(Markdown.prototype, "render");
        const originalTable = Object.getOwnPropertyDescriptor(Markdown.prototype, "renderTable");
        const handles = [await installResponseRendering()];
        try {
            const markdown = new Markdown("| Name |\n| --- |\n| alpha |", 0, 0, theme);
            markFencesHidden(markdown);
            selectTableRenderer("codex");
            expect(
                markdown.render(40).map((line) => stripVTControlCharacters(line).trimEnd()),
            ).toEqual([" Name", " ─────", " alpha"]);

            handles.push(await installResponseRendering());
            handles[first]?.dispose();
            markdown.invalidate();
            expect(
                markdown.render(40).map((line) => stripVTControlCharacters(line).trimEnd()),
            ).toEqual([" Name", " ─────", " alpha"]);

            handles[1 - first]?.dispose();
            expect(markdown.render(40).join("\n")).toContain("┌");
            expect(Object.getOwnPropertyDescriptor(Markdown.prototype, "render")).toEqual(
                originalRender,
            );

            expect(Object.getOwnPropertyDescriptor(Markdown.prototype, "renderTable")).toEqual(
                originalTable,
            );
        } finally {
            for (const handle of handles) handle.dispose();
        }
    },
);

it("keeps newly created assistant tables styled until the last live owner disposes", async () => {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "| Name |\n| --- |\n| sample |" }],
        api: "openai-responses",
        provider: "synthetic",
        model: "sample",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
    };
    const render = () =>
        new AssistantMessageComponent(message, false, theme, "Thinking", 0)
            .render(40)
            .map(stripVTControlCharacters)
            .map((line) => line.trimEnd());

    const first = await installResponseRendering();
    const second = await installResponseRendering();
    let replacement: Awaited<ReturnType<typeof installResponseRendering>> | undefined;
    try {
        selectTableRenderer("codex");
        first.dispose();
        expect(render()).toEqual(["", " Name", " ──────", " sample"]);
        first.dispose();
        expect(render()).toEqual(["", " Name", " ──────", " sample"]);
        second.dispose();
        replacement = await installResponseRendering();
        first.dispose();
        second.dispose();
        expect(render()).toEqual(["", " Name", " ──────", " sample"]);
    } finally {
        first.dispose();
        second.dispose();
        replacement?.dispose();
    }
});

it("does not change a registered table renderer's cached output while adding spacing", async () => {
    const handle = await installResponseRendering();
    const cached = ["Cached row"];
    const contribution = registerTableRenderer("cached-output", () => cached);
    try {
        selectTableRenderer("cached-output");
        const markdown = new Markdown("| Name |\n| --- |\n| sample |\n# Heading", 0, 0, theme);
        markFencesHidden(markdown);
        const first = [...markdown.render(40)];
        expect(cached).toEqual(["Cached row"]);
        markdown.invalidate();
        expect(markdown.render(40)).toEqual(first);
        expect(cached).toEqual(["Cached row"]);
    } finally {
        contribution.dispose();
        handle.dispose();
    }
});

it("updates already-rendered tables when selecting, updating, and disposing implementations", async () => {
    const handle = await installResponseRendering();
    const contribution = registerTableRenderer("labels", (input) =>
        input.rows.map((row) => `${input.headers[0]}: ${row[0]}`),
    );
    try {
        const markdown = new Markdown("| Name |\n| --- |\n| alpha |", 0, 0, theme);
        markFencesHidden(markdown);
        selectTableRenderer("native");
        expect(markdown.render(40).join("\n")).toContain("┌");
        selectTableRenderer("labels");
        expect(markdown.render(40).map((line) => line.trimEnd())).toEqual(["Name: alpha"]);
        contribution.update((input) => input.rows.map((row) => `Entry ${row[0]}`));
        expect(markdown.render(40).map((line) => line.trimEnd())).toEqual(["Entry alpha"]);
        contribution.dispose();
        expect(markdown.render(40).join("\n")).toContain("┌");
        contribution.dispose();
    } finally {
        contribution.dispose();
        handle.dispose();
    }
});

it.each([undefined, {}])(
    "dims native table borders without dimming styled cell text or border-like content (%j)",
    async (settings) => {
        const handle = await installResponseRendering(settings);
        try {
            selectTableRenderer("native");
            const markdown = new Markdown(
                "| Name | Value |\n| --- | --- |\n| `界│─` | text |\n| beta | plain |",
                0,
                0,
                {
                    ...theme,
                    bold: (text) => `\u001b[1m${text}\u001b[22m`,
                },
            );
            markFencesHidden(markdown);

            expect(markdown.render(20).map((line) => line.trimEnd())).toEqual([
                "\u001b[2m┌──────┬───────┐\u001b[22m",
                "\u001b[2m│\u001b[22m \u001b[1mName\u001b[22m \u001b[2m│\u001b[22m \u001b[1mValue\u001b[22m \u001b[2m│\u001b[22m",
                "\u001b[2m├──────┼───────┤\u001b[22m",
                "\u001b[2m│\u001b[22m \u001b[31m界│─\u001b[39m \u001b[2m│\u001b[22m text  \u001b[2m│\u001b[22m",
                "\u001b[2m├──────┼───────┤\u001b[22m",
                "\u001b[2m│\u001b[22m beta \u001b[2m│\u001b[22m plain \u001b[2m│\u001b[22m",
                "\u001b[2m└──────┴───────┘\u001b[22m",
            ]);
        } finally {
            handle.dispose();
        }
    },
);

it.each([5, 40])(
    "preserves native rendering when borders are normal at %i columns",
    async (width) => {
        const handle = await installResponseRendering({ nativeTableBorderStyle: "normal" });
        try {
            selectTableRenderer("native");
            const source = "| Name | Value |\n| --- | --- |\n| alpha | `styled` |";
            const ordinary = new Markdown(source, 0, 0, theme);
            const assistant = new Markdown(source, 0, 0, theme);
            markFencesHidden(assistant);

            expect(assistant.render(width)).toEqual(ordinary.render(width));
        } finally {
            handle.dispose();
        }
    },
);

it("keeps narrow native Markdown fallback unchanged when borders are dim", async () => {
    const handle = await installResponseRendering();
    try {
        selectTableRenderer("native");
        const source = "| Name | Value |\n| --- | --- |\n| alpha | `styled` |";
        const ordinary = new Markdown(source, 0, 0, theme);
        const assistant = new Markdown(source, 0, 0, theme);
        markFencesHidden(assistant);

        expect(assistant.render(5)).toEqual(ordinary.render(5));
    } finally {
        handle.dispose();
    }
});

it("refreshes native borders on policy changes and restores the previous owner's style", () => {
    const first = installTableRendering({
        tableHeaderColor: "#5CCCCC",
        nativeTableBorderStyle: "dim",
    });
    const handles = [first];
    try {
        selectTableRenderer("native");
        const markdown = new Markdown("| Name |\n| --- |\n| alpha |", 0, 0, theme);
        markFencesHidden(markdown);
        expect(markdown.render(40).join("\n")).toContain("\u001b[2m┌");

        const second = installTableRendering({
            tableHeaderColor: "#5CCCCC",
            nativeTableBorderStyle: "normal",
        });
        handles.push(second);
        expect(markdown.render(40).join("\n")).not.toContain("\u001b[2m");

        second?.update({ tableHeaderColor: "#5CCCCC", nativeTableBorderStyle: "dim" });
        expect(markdown.render(40).join("\n")).toContain("\u001b[2m┌");

        second?.update({ tableHeaderColor: "#5CCCCC", nativeTableBorderStyle: "normal" });
        expect(markdown.render(40).join("\n")).not.toContain("\u001b[2m");

        second?.dispose();
        expect(markdown.render(40).join("\n")).toContain("\u001b[2m┌");

        first?.dispose();
        expect(markdown.render(40).join("\n")).not.toContain("\u001b[2m");
    } finally {
        for (const handle of handles) handle?.dispose();
    }
});

it("keeps non-assistant Markdown tables native without requiring Workspace", async () => {
    const handle = await installResponseRendering();
    try {
        selectTableRenderer("codex");
        const source = "| Name |\n| --- |\n| alpha |";
        const ordinary = new Markdown(source, 0, 0, theme);
        const assistant = new Markdown(source, 0, 0, theme);
        markFencesHidden(assistant);
        expect(ordinary.render(40).join("\n")).toContain("┌");
        expect(
            assistant.render(40).map((line) => stripVTControlCharacters(line).trimEnd()),
        ).toEqual([" Name", " ─────", " alpha"]);
    } finally {
        handle.dispose();
        selectTableRenderer("native");
    }
});
