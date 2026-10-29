import { expect, it } from "vitest";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
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

it("uses padded open columns, heavy header rules and aligned cells", () => {
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
        " Name     Count",
        "━━━━━━━  ━━━━━━━",
        " alpha       42",
        "───────  ───────",
        " beta         7",
    ]);
});

it("uses the separator style, not the header accent, for both rules", () => {
    const lines = renderCodexTable({
        headers: ["Name"],
        rows: [["alpha"], ["beta"]],
        align: [null],
        width: 30,
        header: (text) => `<header>${text}</header>`,
        rule: (text) => `<rule>${text}</rule>`,
    });

    expect(lines[1]).toBe("<rule>━━━━━━━</rule>");
    expect(lines[3]).toBe("<rule>───────</rule>");
});

it("allocates columns with very large natural widths", () => {
    const lines = renderCodexTable({
        headers: ["Path", "Note"],
        rows: [["x".repeat(100_000), "short descriptive prose here"]],
        align: [null, null],
        width: 40,
        header: identity,
        rule: identity,
    });

    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(lines.join(" ")).toContain("short");
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
        " A      B",
        "━━━━━  ━━━━━━━",
        " a      plain",
        " b",
    ]);
});

it.each([1, 2])("renders readable record content at width %i", (width) => {
    const lines = renderCodexTable({
        headers: ["Name"],
        rows: [["alpha"]],
        align: [null],
        width,
        header: identity,
        rule: identity,
    });
    expect(lines.map(stripVTControlCharacters).join("")).toContain("alpha");
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
});

it("omits output only at zero width", () => {
    expect(
        renderCodexTable({
            headers: ["Name"],
            rows: [["alpha"]],
            align: [null],
            width: 0,
            header: identity,
            rule: identity,
        }),
    ).toEqual([]);
});

it.each([2, 3])("fits wide graphemes at width %i without dropping them", (width) => {
    const lines = renderCodexTable({
        headers: ["列"],
        rows: [["界x"]],
        align: [null],
        width,
        header: identity,
        rule: identity,
    });
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("")).toContain("界");
    expect(lines.join("")).toContain("x");
});

it("replaces only unfit wide graphemes at width one and preserves ANSI", () => {
    const lines = renderCodexTable({
        headers: ["A"],
        rows: [["\u001b[31m界x\u001b[39m"]],
        align: [null],
        width: 1,
        header: identity,
        rule: identity,
    });
    expect(lines.every((line) => visibleWidth(line) <= 1)).toBe(true);
    expect(lines.map(stripVTControlCharacters).join("")).toContain("�x");
    expect(lines.join("")).toContain("\u001b[31m");
});

it("resets background at a wrapped cell boundary and restores it on continuation", () => {
    const lines = renderCodexTable({
        headers: ["One", "Two"],
        rows: [["\u001b[41mone two three four five six seven\u001b[49m", "plain"]],
        align: [null, null],
        width: 25,
        header: identity,
        rule: identity,
    });
    const first = lines.find((line) => line.includes("plain")) ?? "";
    expect(first).toContain(";49m");
    expect(first.indexOf(";49m")).toBeLessThan(first.indexOf("plain"));
    const continuations = lines.slice(lines.indexOf(first) + 1).join("\n");
    expect(continuations).toContain("\u001b[41m");
});

it.each([3, 5, 7, 8, 9, 12, 32, 80])(
    "fits table rendering through Markdown wrapping at %i columns",
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

it("transposes fragmented compact fields and separates records", () => {
    const lines = renderCodexTable({
        headers: ["Name", "Status"],
        rows: [
            ["alpha", "pending"],
            ["beta", "ready"],
        ],
        align: [null, null],
        width: 14,
        header: identity,
        rule: identity,
    });
    expect(lines).toEqual([
        " Name",
        "  alpha",
        " Status",
        "  pending",
        "──────────────",
        " Name",
        "  beta",
        " Status",
        "  ready",
    ]);
});

it("uses aligned records for wide labels and token-heavy values", () => {
    const lines = renderCodexTable({
        headers: ["Name", "Path", "Other"],
        rows: [
            [
                "alpha",
                "/a/very/long/path/that/will/not/fit/in/a/grid",
                "/another/very/long/path/to/somewhere",
            ],
        ],
        align: [null, null, null],
        width: 35,
        header: identity,
        rule: identity,
    });
    expect(lines[0]).toBe(" Name   alpha");
    expect(lines[1]).toContain(" Path   ");
    expect(lines.every((line) => visibleWidth(line) <= 35)).toBe(true);
});

it("preserves inline styles and OSC links in a record fallback", () => {
    const link = "\u001b]8;;https://example.com\u0007linked\u001b]8;;\u0007";
    const lines = renderCodexTable({
        headers: ["Name", "Value"],
        rows: [["alpha", `\u001b[31m${link}\u001b[39m`]],
        align: [null, null],
        width: 15,
        header: identity,
        rule: identity,
    });
    expect(lines.join("\n")).toContain("\u001b]8;;https://example.com\u0007");
    expect(lines.join("\n")).toContain("\u001b[31m");
    expect(lines.map(stripVTControlCharacters).join("\n")).toContain("linked");
});

it("preserves a header-only table as pipes when its grid cannot fit", () => {
    const lines = renderCodexTable({
        headers: ["A", "B"],
        rows: [],
        align: ["center", "right"],
        width: 11,
        header: identity,
        rule: identity,
    });
    expect(lines[0]).toBe("| A | B |");
    expect(lines.slice(1).join("")).toContain(":---:");
});

it("applies column alignment to headers as well as body values", () => {
    const lines = renderCodexTable({
        headers: ["A", "B"],
        rows: [["long", "longer"]],
        align: ["right", "center"],
        width: 30,
        header: identity,
        rule: identity,
    });
    expect(lines[0]).toBe("    A      B");
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
            if (width === 173) expect(widths).toEqual([41, 49, 49, 28]);
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
            " Name     Value",
            "━━━━━━━  ━━━━━━━━",
            " alpha    styled",
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
            [" Name", "━━━━━━━", " alpha"],
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
            ).toEqual([" Name", "━━━━━━━", " alpha"]);

            handles.push(await installResponseRendering());
            handles[first]?.dispose();
            markdown.invalidate();
            expect(
                markdown.render(40).map((line) => stripVTControlCharacters(line).trimEnd()),
            ).toEqual([" Name", "━━━━━━━", " alpha"]);

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
        expect(render()).toEqual(["", " Name", "━━━━━━━━", " sample"]);
        first.dispose();
        expect(render()).toEqual(["", " Name", "━━━━━━━━", " sample"]);
        second.dispose();
        replacement = await installResponseRendering();
        first.dispose();
        second.dispose();
        expect(render()).toEqual(["", " Name", "━━━━━━━━", " sample"]);
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
        nativeTableBorderStyle: "dim",
    });
    const handles = [first];
    try {
        selectTableRenderer("native");
        const markdown = new Markdown("| Name |\n| --- |\n| alpha |", 0, 0, theme);
        markFencesHidden(markdown);
        expect(markdown.render(40).join("\n")).toContain("\u001b[2m┌");

        const second = installTableRendering({
            nativeTableBorderStyle: "normal",
        });
        handles.push(second);
        expect(markdown.render(40).join("\n")).not.toContain("\u001b[2m");

        second?.update({ nativeTableBorderStyle: "dim" });
        expect(markdown.render(40).join("\n")).toContain("\u001b[2m┌");

        second?.update({ nativeTableBorderStyle: "normal" });
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
        ).toEqual([" Name", "━━━━━━━", " alpha"]);
    } finally {
        handle.dispose();
        selectTableRenderer("native");
    }
});

it("uses the current accent for Codex table headers after a theme change", () => {
    let color = 31;
    const handle = installTableRendering({
        nativeTableBorderStyle: "dim",
        accent: (text) => `\u001b[${color}m${text}\u001b[39m`,
    });
    try {
        selectTableRenderer("codex");
        const markdown = new Markdown("| Name |\n| --- |\n| alpha |", 0, 0, theme);
        markFencesHidden(markdown);
        expect(markdown.render(40).join("\n")).toContain("\u001b[31mName");
        color = 34;
        expect(markdown.render(40).join("\n")).toContain("\u001b[34mName");
    } finally {
        handle?.dispose();
    }
});

it("styles assistant headings relative to the highest real parsed heading while preserving source depth", async () => {
    const handle = await installResponseRendering();
    try {
        const styledTheme = { ...theme, bold: (text: string) => `\u001b[1m${text}\u001b[22m` };
        const markdown = new Markdown(
            "### Top\n\n#### Child\n\n##### Deep\n\n```\n# not a heading\n```",
            0,
            0,
            styledTheme,
        );
        markFencesHidden(markdown);
        const lines = markdown.render(80);
        const top = lines.find((line) => line.includes("Top")) ?? "";
        const child = lines.find((line) => line.includes("Child")) ?? "";
        const deep = lines.find((line) => line.includes("Deep")) ?? "";
        expect(top).toContain("\u001b[38;2;255;255;0m");
        expect(top).toContain("\u001b[1m");
        expect(child).toContain("\u001b[38;2;255;255;0m");
        expect(child).not.toContain("\u001b[1m");
        expect(stripVTControlCharacters(top).trim()).toBe("Top");
        expect(stripVTControlCharacters(child).trim()).toBe("Child");
        expect(stripVTControlCharacters(deep).trim()).toBe("##### Deep");
        markdown.setText("# New\n\n### Top");
        expect(stripVTControlCharacters(markdown.render(80).join("\n"))).not.toContain("### Top");
    } finally {
        handle.dispose();
    }
});

it("folds nested sections by clicking the actual assistant component, including after streaming updates", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: "# Parent\n\nparent body\n\n## Child\n\nchild body\n\n# Sibling\n\nsibling body",
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const click = (name: string) => {
            const lines = component.render(80);
            const y = lines.findIndex((line) => stripVTControlCharacters(line).includes(name));
            expect(y).toBeGreaterThanOrEqual(0);
            expect(
                component.handleMouse({
                    type: "click",
                    button: "left",
                    x: 0,
                    y,
                    screenX: 0,
                    screenY: y,
                    width: 80,
                    height: lines.length,
                    shift: false,
                    alt: false,
                    ctrl: false,
                })?.handled,
            ).toBe(true);
        };
        click("Child");
        expect(component.render(80).join("\n")).not.toContain("child body");
        click("Parent");
        expect(component.render(80).join("\n")).not.toContain("Child");
        expect(component.render(80).join("\n")).toContain("sibling body");
        component.updateContent(message, true);
        expect(component.render(80).join("\n")).not.toContain("Child");
        click("Parent");
        expect(component.render(80).join("\n")).toContain("Child");
        expect(component.render(80).join("\n")).not.toContain("child body");
        click("Child");
        expect(component.render(80).join("\n")).toContain("child body");
    } finally {
        handle.dispose();
    }
});

it("uses one relative heading hierarchy across separate assistant text blocks", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                { type: "text", text: "### Earlier" },
                { type: "text", text: "# Later" },
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const text = stripVTControlCharacters(component.render(80).join("\n"));
        expect(text).not.toContain("### Earlier");
        expect(text).toContain("Earlier");
        expect(text).toContain("Later");
        expect(text).not.toContain("# Later");
    } finally {
        handle.dispose();
    }
});

it("keeps wrapped heading text visible when its section is folded", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                {
                    type: "text",
                    text: "# A long heading with words\n\nbody hidden\n\n# Next\n\nvisible",
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const lines = component.render(12);
        const y = lines.findIndex((line) => line.includes("words"));
        expect(y).toBeGreaterThan(1);
        expect(
            component.handleMouse({
                type: "click",
                button: "left",
                x: 0,
                y,
                screenX: 0,
                screenY: y,
                width: 12,
                height: lines.length,
                shift: false,
                alt: false,
                ctrl: false,
            })?.handled,
        ).toBe(true);
        const folded = stripVTControlCharacters(component.render(12).join("\n"));
        expect(folded).toContain("words");
        expect(folded).not.toContain("body hidden");
        expect(folded).toContain("visible");
    } finally {
        handle.dispose();
    }
});

it("uses distinct depths and recomputes their ranks as assistant content streams", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "## First\n\n#### Second\n\n###### Third" }],
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
        const styledTheme = {
            ...theme,
            heading: (text: string) => `\u001b[35m${text}\u001b[39m`,
            bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
        };
        const component = new AssistantMessageComponent(message, false, styledTheme, "Thinking", 0);
        const lines = component.render(80);
        const first = lines.find((line) => line.includes("First")) ?? "";
        const second = lines.find((line) => line.includes("Second")) ?? "";
        const third = lines.find((line) => line.includes("Third")) ?? "";
        expect(stripVTControlCharacters(first).trim()).toBe("First");
        expect(stripVTControlCharacters(second).trim()).toBe("Second");
        expect(stripVTControlCharacters(third).trim()).toBe("###### Third");
        for (const line of [first, second, third]) expect(line).toContain("\u001b[38;2;255;255;0m");
        expect(first).toContain("\u001b[1m");
        expect(second).not.toContain("\u001b[1m");
        component.updateContent(
            {
                ...message,
                content: [
                    { type: "text", text: "# New\n\n## First\n\n#### Second\n\n###### Third" },
                ],
            },
            true,
        );
        const updated = component.render(80).map(stripVTControlCharacters).join("\n");
        expect(updated).toContain("#### Second");
        expect(updated).not.toContain("## First");
    } finally {
        handle.dispose();
    }
});

it("folds sections across separate assistant text blocks while preserving thinking", async () => {
    initTheme("dark", false);
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                { type: "text", text: "## Parent\n\nbody" },
                { type: "thinking", thinking: "private reasoning", thinkingSignature: undefined },
                {
                    type: "text",
                    text: "continuation\n\n#### Child\n\nchild content\n\n## Next\n\nnext content",
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const lines = component.render(80);
        const y = lines.findIndex((line) => line.includes("Parent"));
        expect(
            component.handleMouse({
                type: "click",
                button: "left",
                x: 0,
                y,
                screenX: 0,
                screenY: y,
                width: 80,
                height: lines.length,
                shift: false,
                alt: false,
                ctrl: false,
            })?.handled,
        ).toBe(true);
        const folded = stripVTControlCharacters(component.render(80).join("\n"));
        expect(folded).not.toContain("continuation");
        expect(folded).not.toContain("Child");
        expect(folded).toContain("private reasoning");
        expect(folded).toContain("next content");
    } finally {
        handle.dispose();
    }
});

it("clears folds on heading insertion and removal but preserves append-only streaming", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "# Alpha\n\nalpha body\n\n# Target\n\ntarget body" }],
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const click = (name: string) => {
            const lines = component.render(80);
            const y = lines.findIndex((line) => stripVTControlCharacters(line).includes(name));
            expect(y).toBeGreaterThanOrEqual(0);
            expect(
                component.handleMouse({
                    type: "click",
                    button: "left",
                    x: 0,
                    y,
                    screenX: 0,
                    screenY: y,
                    width: 80,
                    height: lines.length,
                    shift: false,
                    alt: false,
                    ctrl: false,
                })?.handled,
            ).toBe(true);
        };
        const update = (text: string) =>
            component.updateContent({ ...message, content: [{ type: "text", text }] }, true);
        const text = () => stripVTControlCharacters(component.render(80).join("\n"));
        click("Target");
        expect(text()).not.toContain("target body");
        update("# Alpha\n\nalpha body\n\n# Target\n\ntarget body extended\n\n# New\n\nnew body");
        expect(text()).not.toContain("target body");
        expect(text()).toContain("new body");
        update("# Inserted\n\ninsert body\n\n# Alpha\n\nalpha body\n\n# Target\n\ntarget body");
        expect(text()).toContain("alpha body");
        expect(text()).toContain("target body");
        click("Target");
        expect(text()).not.toContain("target body");
        update("# Target\n\ntarget body");
        expect(text()).toContain("target body");
    } finally {
        handle.dispose();
    }
});

it("clears folds when an earlier assistant text block is inserted or removed", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [
                { type: "text", text: "# Target\n\ntarget body" },
                { type: "text", text: "# Last\n\nlast body" },
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const click = (name: string) => {
            const lines = component.render(80);
            const y = lines.findIndex((line) => stripVTControlCharacters(line).includes(name));
            expect(y).toBeGreaterThanOrEqual(0);
            expect(
                component.handleMouse({
                    type: "click",
                    button: "left",
                    x: 0,
                    y,
                    screenX: 0,
                    screenY: y,
                    width: 80,
                    height: lines.length,
                    shift: false,
                    alt: false,
                    ctrl: false,
                })?.handled,
            ).toBe(true);
        };
        const text = () => stripVTControlCharacters(component.render(80).join("\n"));
        click("Target");
        expect(text()).not.toContain("target body");
        component.updateContent(
            {
                ...message,
                content: [{ type: "text", text: "# Inserted\n\ninsert body" }, ...message.content],
            },
            true,
        );
        expect(text()).toContain("insert body");
        expect(text()).toContain("target body");
        click("Target");
        expect(text()).not.toContain("target body");
        component.updateContent(message, true);
        expect(text()).toContain("target body");
        expect(text()).toContain("last body");
    } finally {
        handle.dispose();
    }
});

it("retains a fold while its last heading text continues streaming", async () => {
    const handle = await installResponseRendering();
    try {
        const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "# Tar" }],
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
        const component = new AssistantMessageComponent(message, false, theme, "Thinking", 0);
        const lines = component.render(80);
        const y = lines.findIndex((line) => line.includes("Tar"));
        expect(
            component.handleMouse({
                type: "click",
                button: "left",
                x: 0,
                y,
                screenX: 0,
                screenY: y,
                width: 80,
                height: lines.length,
                shift: false,
                alt: false,
                ctrl: false,
            })?.handled,
        ).toBe(true);
        component.updateContent(
            { ...message, content: [{ type: "text", text: "# Target\n\nnew body" }] },
            true,
        );
        const text = stripVTControlCharacters(component.render(80).join("\n"));
        expect(text).toContain("Target");
        expect(text).not.toContain("new body");
    } finally {
        handle.dispose();
    }
});

it("invalidates fold state when the parsed heading sequence changes, even without an updateContent call", async () => {
    const { createHeadingGroup, foldableMarkdown, prepareHeadingGroup } =
        await import("../src/heading-rendering.ts");
    const handle = await installResponseRendering();
    try {
        const markdown = new Markdown("# First\n\n# Target\n\nbody", 0, 0, theme);
        markFencesHidden(markdown);
        const collapsed = new Set([1]);
        const group = createHeadingGroup(new Map([[0, collapsed]]), {});
        foldableMarkdown(markdown, collapsed, group);
        prepareHeadingGroup(group, 80);
        expect(collapsed.has(1)).toBe(true);
        markdown.setText("# Added\n\n# First\n\n# Target\n\nbody");
        prepareHeadingGroup(group, 81);
        expect(collapsed.size).toBe(0);
    } finally {
        handle.dispose();
    }
});
