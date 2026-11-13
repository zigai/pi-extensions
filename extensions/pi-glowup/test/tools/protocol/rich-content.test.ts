import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
    getKeybindings,
    KeybindingsManager,
    Markdown,
    setKeybindings,
    visibleWidth,
    type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { configureMarkdownSyntaxPatch } from "../../../src/pi/patches/markdown-syntax.ts";
import { renderOutlineNode } from "../../../src/rendering/outline.ts";
import type { GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../src/rendering/syntax/highlighter.ts";
import { renderProtocolNode } from "../../../src/tools/protocol/node-renderer.ts";
import {
    call,
    code,
    DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
    decodeGlowupNode,
    list,
    output,
    registerGlowupStreamingPolicy,
    stack,
    summary,
    text,
    type GlowupInline,
    type GlowupNode,
} from "../../../src/tools/protocol/contract.ts";
import type { ThirdPartyToolRenderContext } from "../../../src/tools/types.ts";

const theme: GlowupRenderTheme = { fg: (_token, value) => value, bold: (value) => value };
const context: ThirdPartyToolRenderContext = {
    toolCallId: "rich-content",
    args: {},
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    isError: false,
    expanded: true,
    showImages: false,
};

const plain = (rows: readonly string[]) =>
    rows.map(stripVTControlCharacters).map((row) => row.trimEnd());

const render = (
    node: GlowupNode,
    overrides: Partial<ThirdPartyToolRenderContext> = {},
    style = theme,
) => renderProtocolNode(node, style, { ...context, ...overrides }, "static");

const nativeTheme: MarkdownTheme = {
    heading: (value) => value,
    link: (value) => value,
    linkUrl: (value) => value,
    code: (value) => value,
    codeBlock: (value) => value,
    codeBlockBorder: (value) => value,
    quote: (value) => value,
    quoteBorder: (value) => value,
    hr: (value) => value,
    listBullet: (value) => value,
    bold: (value) => value,
    italic: (value) => value,
    strikethrough: (value) => value,
    underline: (value) => value,
};
const markdownSource = "## Progress\n\n- Review `file.ts`\n- " + "words 界 👩‍💻 ".repeat(22);

for (const backend of ["compact", "outline"] as const) {
    const component = (
        node: GlowupNode,
        overrides: Partial<ThirdPartyToolRenderContext> = {},
        style = theme,
    ) =>
        backend === "compact"
            ? render(node, overrides, style)
            : renderOutlineNode(node, style, { ...context, ...overrides }, "static");
    describe(`${backend} rich protocol content`, () => {
        it.each([40, 80, 165])(
            "uses native Markdown headings, bullets and inline code at %s",
            (width) => {
                const rows = component(output(markdownSource, { format: "markdown" })).render(
                    width,
                );
                const indent = backend === "compact" ? 4 : 2;
                const native = plain(
                    new Markdown(markdownSource, 0, 0, nativeTheme).render(width - indent),
                );
                expect(plain(rows).map((row) => row.slice(indent))).toEqual(native);
                expect(rows.join("\n")).not.toContain("`");
                expect(rows.join("\n")).toContain("file.ts");
                expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
                const resized = component(output(markdownSource, { format: "markdown" }));
                for (const nextWidth of [80, 40, 165, 40]) {
                    expect(resized.render(nextWidth)).toEqual(
                        component(output(markdownSource, { format: "markdown" })).render(nextWidth),
                    );
                }
            },
        );

        it("styles parts independently and keeps the fallback out of the view", () => {
            const style: GlowupRenderTheme = {
                fg: (token, value) =>
                    token === "dim"
                        ? `\u001b[2m${value}\u001b[22m`
                        : token === "accent"
                          ? `\u001b[36m${value}\u001b[39m`
                          : value,
                bold: (value) => `\u001b[1m${value}\u001b[22m`,
            };

            const parts: readonly GlowupInline[] = [
                { kind: "text", text: "Task", tone: "accent", bold: true },
                { kind: "text", text: " · running", tone: "dim" },
            ];

            const node = list([{ ...text("plain fallback"), parts }], undefined, "tree");
            const decoded = decodeGlowupNode(node);
            expect(decoded).toEqual(node);

            if (decoded === undefined) throw new Error("Expected decoded node");

            const rows = component(decoded, {}, style).render(40).join("\n");
            expect(rows).toContain("\u001b[1m\u001b[36mTask\u001b[39m\u001b[22m");
            expect(rows).toContain("\u001b[2m · running\u001b[22m");
            expect(rows).not.toContain("plain fallback");
            expect(stripVTControlCharacters(rows)).toContain("└ Task · running");
        });

        it("lays out a styled call body like a plain one", () => {
            const style: GlowupRenderTheme = {
                fg: (token, value) => (token === "muted" ? `\u001b[2m${value}\u001b[22m` : value),
                bold: (value) => value,
            };
            const node = call(
                { static: "Fetched" },
                {
                    body: text("plain fallback", {
                        parts: [
                            "https://example.org/a",
                            { kind: "text", text: " (404)", tone: "muted" },
                        ],
                    }),
                },
            );

            const unstyled = call(
                { static: "Fetched" },
                { body: text("https://example.org/a (404)") },
            );

            const rows = component(node, {}, style).render(80);
            expect(plain(rows)).toEqual(plain(component(unstyled).render(80)));
            expect(rows.join("\n")).toContain("\u001b[2m (404)\u001b[22m");
        });

        it.each([40, 80, 165])("bounds rendered rows, not source rows, at %s", (width) => {
            const node = output("# Heading\n\n- " + "long words ".repeat(150), {
                format: "markdown",
                preview: { mode: "head", collapsedLines: 3, expandedLines: 200 },
            });
            const all = component(node).render(width);
            const collapsed = component(node, { expanded: false }).render(width);
            expect(collapsed).toHaveLength(4);
            expect(collapsed.slice(0, 3)).toEqual(all.slice(0, 3));
            expect(stripVTControlCharacters(collapsed.at(-1) ?? "")).toContain(
                `… +${all.length - 3} lines`,
            );

            expect(collapsed.every((row) => visibleWidth(row) <= width)).toBe(true);
        });

        it("keeps requested expansion above twenty rows and reports exact omissions", () => {
            const source = Array.from({ length: 75 }, (_, index) => `line ${index}`).join("\n\n");
            const node = output(source, { format: "markdown", preview: { expandedLines: 60 } });
            const rows = plain(component(node).render(80));
            const all = component({ ...node, preview: { expandedLines: 500 } }).render(80);
            expect(rows).toHaveLength(61);
            expect(rows[59]).toEqual(plain(all)[59]);
            expect(rows[60]?.trim()).toBe(`… +${all.length - 60} lines`);
            expect(rows.at(-1)).not.toContain("expand");
        });

        it("gates Markdown before rendering/preview and preserves nested stream identity", () => {
            const present = vi.fn((input: { key: string; source: string; complete: boolean }) =>
                input.complete
                    ? input.source
                    : "## Visible\n\n- `safe-one`\n- safe-two\n- safe-three",
            );
            const policy = registerGlowupStreamingPolicy({ present, settled: async () => {} });
            onTestFinished(() => policy.dispose());
            const node = list(
                [
                    stack([
                        text("Status"),
                        output("PRIVATE raw pending source", {
                            format: "markdown",
                            streaming: { kind: "markdown" },
                            preview: { mode: "head", collapsedLines: 3 },
                        }),
                    ]),
                    output("Immediate `inline`", { format: "markdown" }),
                ],
                { collapsedLines: 30 },
                "tree",
            );
            const partialContext = {
                expanded: false,
                argsComplete: false,
                isPartial: true,
                contentComplete: false,
                streamPhase: "result" as const,
            };
            const first = component(node, partialContext);
            const rows = plain(first.render(80)).join("\n");
            expect(rows).toContain("Visible");
            expect(rows).toContain("safe-one");
            expect(rows).not.toContain("safe-two");
            expect(rows).toContain("… +2 lines");
            expect(rows).toContain("Immediate inline");
            expect(rows).not.toMatch(/PRIVATE|`/u);
            expect(present).toHaveBeenCalledTimes(1);
            const key = present.mock.calls[0]?.[0].key;
            component(node, { ...partialContext, lastComponent: first }).render(40);
            expect(present.mock.calls[1]?.[0].key).toBe(key);
            component(node, {
                ...partialContext,
                argsComplete: true,
                contentComplete: true,
            }).render(80);

            expect(present.mock.calls[2]?.[0]).toMatchObject({ key, complete: true });
            component(node, { ...partialContext, toolCallId: "other-call" }).render(80);
            expect(present.mock.calls[3]?.[0].key).not.toBe(key);
        });

        it("uses the configured expansion key for omission hints", () => {
            initTheme("dark");
            const previous = getKeybindings();
            setKeybindings(
                new KeybindingsManager(
                    { "app.tools.expand": { defaultKeys: "ctrl+o" } },
                    { "app.tools.expand": "alt+x" },
                ),
            );

            onTestFinished(() => setKeybindings(previous));
            const node = output(
                Array.from({ length: 12 }, (_, index) => `- item ${index}`).join("\n"),
                {
                    format: "markdown",
                    preview: { collapsedLines: 2 },
                },
            );
            const rows = plain(component(node, { expanded: false }).render(80)).join("\n");
            expect(rows).toMatch(/(?:alt|option)\+x to expand/u);
            expect(rows).not.toContain("ctrl+o");
        });
    });
}

describe("rich content protocol decoding and semantics", () => {
    it("snapshots optional parts/format and accounts for their traversal budgets", () => {
        const span = { kind: "text" as const, text: "visible", tone: "accent" as const };
        const parts = [span];
        const source = stack([
            text("fallback", { parts }),
            output("## Heading", { format: "markdown" }),
        ]);
        const decoded = decodeGlowupNode(source);
        expect(decoded).toEqual(source);
        span.text = "changed";
        parts.push(span);
        expect(JSON.stringify(decoded)).not.toContain("changed");
        expect(
            decodeGlowupNode(text("a", { parts: ["bc"] }), {
                ...DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
                maxTextCharacters: 2,
            }),
        ).toBeUndefined();

        expect(
            decodeGlowupNode(text("a", { parts: ["b", "c"] }), {
                ...DEFAULT_GLOWUP_NODE_DECODE_LIMITS,
                maxCollectionItems: 1,
            }),
        ).toBeUndefined();

        expect(text("fallback")).toEqual({ kind: "text", text: "fallback" });
        expect(output("plain")).toEqual({ kind: "output", text: "plain" });
    });

    it.each([null, false, 1, {}, [false], [{ kind: "text", text: "bad", tone: "unknown" }]])(
        "rejects malformed parts %j",
        (parts) => {
            expect(decodeGlowupNode({ kind: "text", text: "fallback", parts })).toBeUndefined();
            expect(
                decodeGlowupNode({
                    kind: "list",
                    style: "tree",
                    items: [{ kind: "text", text: "fallback", parts }],
                }),
            ).toBeUndefined();
        },
    );

    it.each([null, false, 1, "plain", "Markdown", {}])(
        "rejects malformed output format %j",
        (format) => {
            expect(decodeGlowupNode({ kind: "output", text: "source", format })).toBeUndefined();
        },
    );

    it.each([40, 80, 165])(
        "preserves arbitrary nested stack/list child semantics at %s",
        (width) => {
            const node = stack([
                list(
                    [
                        stack([
                            text("Task", {
                                parts: [{ kind: "text", text: "Task", tone: "accent" }],
                            }),
                            list([
                                stack([
                                    output("## Heading\n\n- `inline`", { format: "markdown" }),
                                    code("const value = 1;", {
                                        title: "Source",
                                        syntax: { language: "javascript" },
                                    }),
                                ]),
                            ]),
                            call(
                                { static: "Nested call" },
                                { body: summary([{ label: "state", value: "ready" }]) },
                            ),
                        ]),
                        text("Last"),
                    ],
                    { expandedLines: 200 },
                    "tree",
                ),
            ]);
            const rows = plain(render(node).render(width));
            expect(rows[0]).toBe("  ├ Task");
            expect(rows.some((row) => row.startsWith("  │ • ") && row.includes("Heading"))).toBe(
                true,
            );

            expect(rows.join("\n")).toContain("inline");
            expect(rows.join("\n")).not.toContain("`");
            expect(rows.join("\n")).toContain("Source");
            expect(rows.join("\n")).toContain("const value = 1;");
            expect(rows.join("\n")).toContain("Nested call");
            expect(rows.join("\n")).toContain("state → ready");
            expect(rows.at(-1)).toBe("  └ Last");
            expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        },
    );

    it.each([40, 80, 165])("wraps long styled parts without losing spans at %s", (width) => {
        const name = "Important name ".repeat(10);
        const state = "界 running ".repeat(16);
        const style: GlowupRenderTheme = {
            fg: (token, value) =>
                token === "accent"
                    ? `\u001b[36m${value}\u001b[39m`
                    : token === "dim"
                      ? `\u001b[2m${value}\u001b[22m`
                      : value,
            bold: (value) => value,
        };
        const node = list(
            [
                text("fallback", {
                    parts: [
                        { kind: "text", text: name, tone: "accent" },
                        { kind: "text", text: state, tone: "dim" },
                    ],
                }),
            ],
            { expandedLines: 200 },
            "tree",
        );
        const rows = render(node, {}, style).render(width);
        const content = plain(rows)
            .map((row) => row.slice(4))
            .join(" ")
            .replace(/\s+/gu, " ")
            .trim();
        expect(content).toBe(`${name}${state}`.trim());
        expect(rows.join("\n")).toContain("\u001b[36m");
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    });

    it("retains high expanded Markdown budgets inside a tree", () => {
        const source = Array.from({ length: 90 }, (_, index) => `- row ${index}`).join("\n");
        const node = list(
            [
                stack([
                    text("Title"),
                    output(source, {
                        format: "markdown",
                        preview: { expandedLines: 60 },
                    }),
                ]),
                text("Last"),
            ],
            { expandedLines: 200 },
            "tree",
        );
        const rows = plain(render(node).render(80));
        expect(rows).toHaveLength(63);
        expect(rows.at(-2)).toBe("  │ … +30 lines");
        expect(rows.at(-1)).toBe("  └ Last");
    });

    it("keeps deeply nested card metadata readable and tiny widths bounded", () => {
        const dimmed: string[] = [];
        const style: GlowupRenderTheme = {
            fg: (token, value) => {
                if (token === "muted" || token === "dim") dimmed.push(value);
                return value;
            },
            bold: (value) => value,
        };
        const noClip = { collapsedLines: 100_000, expandedLines: 100_000 };
        const node = list(
            [
                stack([
                    text("Aggregate"),
                    list(
                        [
                            stack([
                                text("fallback", {
                                    parts: [
                                        "Task",
                                        { kind: "text", text: " · ready", tone: "dim" },
                                    ],
                                }),
                                output("## Notes\n\n- `done`", {
                                    format: "markdown",
                                    preview: { collapsedLines: 3, expandedLines: 100_000 },
                                }),
                                summary([
                                    { label: "duration", value: "12 seconds" },
                                    { label: "result", value: "complete" },
                                ]),
                            ]),
                        ],
                        noClip,
                        "tree",
                    ),
                ]),
            ],
            noClip,
            "tree",
        );
        const component = render(node, {}, style);
        for (const width of [1, 2, 3, 4, 40, 80, 165]) {
            const rows = component.render(width);
            expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        }

        expect(plain(component.render(80)).join("\n")).toContain("duration → 12 seconds");
        expect(
            dimmed.some((value) => value.includes("12 seconds") || value.includes("complete")),
        ).toBe(false);
    });

    it("refreshes parts, Markdown and dim rails when the theme changes", () => {
        let color = "36";
        const style: GlowupRenderTheme = {
            fg: (token, value) =>
                token === "dim"
                    ? `\u001b[2m${value}\u001b[22m`
                    : `\u001b[${color}m${value}\u001b[39m`,
            bold: (value) => value,
        };
        const node = list(
            [
                stack([
                    text("fallback", { parts: [{ kind: "text", text: "Name", tone: "accent" }] }),
                    output("## Heading\n\n`inline`", { format: "markdown" }),
                ]),
            ],
            undefined,
            "tree",
        );
        const component = render(node, {}, style);
        const first = component.render(80).join("\n");
        expect(first).toContain("\u001b[36mName");
        expect(first).toContain("\u001b[36mHeading");
        expect(first).toContain("\u001b[2m  └ ");
        color = "35";
        component.invalidate();
        const changed = component.render(80).join("\n");
        expect(changed).toContain("\u001b[35mName");
        expect(changed).toContain("\u001b[35mHeading");
        expect(changed).not.toContain("\u001b[36m");
    });

    it.each([false, true])(
        "retains tree syntax colors with native Markdown patch %s",
        async (patched) => {
            configureMarkdownSyntaxPatch(patched);
            onTestFinished(() => configureMarkdownSyntaxPatch(false));
            await initializeSyntaxHighlighting(
                { PI_GLOWUP_SYNTAX_THEME: resolve("themes/darker-modern-theme.json") },
                { preloadLanguages: ["javascript"] },
            );
            onTestFinished(async () => disposeSyntaxHighlighting());
            const invalidate = vi.fn<() => void>();
            const node = list(
                [
                    stack([
                        code("const direct = 1;", { syntax: { language: "javascript" } }),
                        output(
                            "```javascript\nconst fenced = 2;\n```\n\n```javascript\nconst secondFence = 3;\n```",
                            { format: "markdown" },
                        ),
                    ]),
                ],
                undefined,
                "tree",
            );
            const component = render(node, { invalidate });
            component.render(80);
            await settleSyntaxHighlights();
            const rows = component.render(80);
            for (const name of ["direct", "fenced", "secondFence"]) {
                const row = rows.find((line) => stripVTControlCharacters(line).includes(name));
                expect(row).toContain("38;2");
            }

            expect(plain(rows).join("\n")).toContain("const fenced = 2;");
        },
    );
});
