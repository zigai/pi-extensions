import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { renderOutlineNode } from "../../../src/rendering/outline.ts";
import { renderGlowupExplore } from "../../../src/rendering/tool-header.ts";
import type { GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import {
    call,
    code,
    decodeGlowupNode,
    list,
    output,
    stack,
    text,
    type GlowupNode,
} from "../../../src/tools/protocol/contract.ts";
import { renderProtocolNode } from "../../../src/tools/protocol/node-renderer.ts";
import type { ThirdPartyToolRenderContext } from "../../../src/tools/types.ts";

const theme: GlowupRenderTheme = {
    fg: (_token, value) => value,
    bold: (value) => value,
};

const context: ThirdPartyToolRenderContext = {
    toolCallId: "tree",
    args: {},
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    isError: false,
    expanded: true,
    showImages: false,
};

const component = (node: GlowupNode, overrides: Partial<ThirdPartyToolRenderContext> = {}) =>
    renderProtocolNode(node, theme, { ...context, ...overrides }, "static");

const lines = (rows: readonly string[]) =>
    rows.map((row) => stripVTControlCharacters(row).trimEnd());

describe("protocol list styles", () => {
    it("keeps the default helper shape and bullet frames unchanged", () => {
        expect(list(["first", "last"])).toEqual({ kind: "list", items: ["first", "last"] });
        const implicit = list(["first", text("last")]);
        const explicit = list(["first", text("last")], undefined, "bullet");
        expect(decodeGlowupNode(explicit)).toEqual(explicit);

        for (const width of [40, 80]) {
            expect(component(implicit).render(width)).toEqual(component(explicit).render(width));
            expect(lines(component(implicit).render(width))).toEqual(["  └ • first", "    • last"]);
        }
    });

    it("decodes and preserves tree style and snapshots its items", () => {
        const items = ["first"];
        const node = list(items, { mode: "headTail", collapsedLines: 4 }, "tree");
        expect(decodeGlowupNode(node)).toEqual(node);
        const decoded = decodeGlowupNode(node);
        items.push("later");
        expect(decoded).toEqual({
            kind: "list",
            items: ["first"],
            style: "tree",
            preview: { mode: "headTail", collapsedLines: 4 },
        });

        expect(decodeGlowupNode({ kind: "list", items: [], style: undefined })).toEqual(list([]));
    });

    it.each(["numbered", "TREE", "", null, false, 1, [], {}])(
        "rejects invalid list style %j rather than silently dropping it",
        (style) => {
            expect(decodeGlowupNode({ kind: "list", items: [], style })).toBeUndefined();
        },
    );

    it.each([40, 80])(
        "matches native read/search rows at width %s, under a call or as a result",
        (width) => {
            const items = [
                "Read first.ts\nsecond physical line " + "words ".repeat(18),
                "Search last.ts " + "界 👩‍💻 é ".repeat(20),
            ];

            const node = list(items, undefined, "tree");
            const result = component(node).render(width);
            const native = renderGlowupExplore(theme, items, { statusText: "Read" }).render(width);
            const underCall = component(call({ static: "Read" }, { body: node })).render(width);
            expect(result).toEqual(native.slice(1));
            expect(lines(underCall)).toEqual(lines(native));
            expect(result.length).toBeGreaterThan(4);
            const plain = lines(result);
            expect(plain[0]).toBe("  ├ Read first.ts");
            expect(plain[1]).toMatch(/^  │ second physical line/u);
            const lastIndex = plain.findIndex((row) => row.startsWith("  └ "));
            expect(lastIndex).toBeGreaterThan(1);
            expect(plain.slice(1, lastIndex).every((row) => row.startsWith("  │ "))).toBe(true);
            expect(plain.slice(lastIndex + 1).every((row) => row.startsWith("    "))).toBe(true);
            expect(plain.join("\n")).not.toContain("└ •");
            expect(result.every((row) => visibleWidth(row) <= width)).toBe(true);
        },
    );

    it("dims only tree connectors and preserves semantic item styling", () => {
        const styledTheme: GlowupRenderTheme = {
            fg: (token, value) => {
                if (token === "dim") return `\u001b[2m${value}\u001b[22m`;
                if (token === "accent") return `\u001b[36m${value}\u001b[39m`;
                return value;
            },
            bold: (value) => value,
        };
        const rows = renderProtocolNode(
            list(
                [{ kind: "text", text: "first\ncontinued", tone: "accent" }, "last"],
                undefined,
                "tree",
            ),
            styledTheme,
            context,
            "static",
        ).render(40);
        expect(rows[0]).toContain("\u001b[2m  ├ \u001b[22m\u001b[36mfirst");
        expect(rows[1]).toContain("\u001b[2m  │ \u001b[22m");
        expect(rows[2]).toBe("\u001b[2m  └ \u001b[22mlast");
    });

    it("rewraps the same component on resize without stale rails or lost content", () => {
        const node = list(
            ["first " + "words ".repeat(30), "last\nlast continuation"],
            undefined,
            "tree",
        );
        const reused = component(node);
        for (const width of [80, 40, 8, 4, 3, 2, 1, 80, 40]) {
            const rows = reused.render(width);
            expect(rows).toEqual(component(node).render(width));
            expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);

            if (width >= 40) expect(lines(rows).at(-1)).toBe("    last continuation");
        }
    });

    it.each([40, 80])("bounds head-tail previews and expansion at width %s", (width) => {
        const node = list(
            Array.from({ length: 12 }, (_, index) => `item ${index}`),
            { mode: "headTail", collapsedLines: 4, expandedLines: 8 },
            "tree",
        );
        const collapsed = lines(component(node, { expanded: false }).render(width));
        expect(collapsed).toHaveLength(5);
        expect(collapsed.slice(0, 2)).toEqual(["  ├ item 0", "  ├ item 1"]);
        expect(collapsed[2]).toMatch(/^… \+8 lines \(.+\)$/u);
        expect(collapsed.slice(-2)).toEqual(["  ├ item 10", "  └ item 11"]);
        const expanded = lines(component(node).render(width));
        expect(expanded).toHaveLength(9);
        expect(expanded[7]).toBe("  ├ item 7");
        expect(expanded[8]).toBe("… +4 lines");
        const all = { ...node, preview: { expandedLines: 20 } };
        expect(component(all).render(width)).toHaveLength(12);
        expect(component(list([], undefined, "tree")).render(width)).toEqual([]);
    });

    it.each([40, 80])(
        "bounds wrapped previews and keeps continuation rails at width %s",
        (width) => {
            const node = list(
                ["first " + "words ".repeat(100), "last\nlast continuation"],
                { mode: "headTail", collapsedLines: 4 },
                "tree",
            );
            const rows = lines(component(node, { expanded: false }).render(width));
            expect(rows).toHaveLength(5);
            expect(rows[0]).toMatch(/^  ├ first/u);
            expect(rows[1]).toMatch(/^  │ /u);
            expect(rows[2]).toContain("lines (");
            expect(rows.slice(-2)).toEqual(["  └ last", "    last continuation"]);
            expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        },
    );

    it("honors hidden and head previews", () => {
        const items = Array.from({ length: 12 }, (_, index) => `item ${index}`);
        expect(
            component(list(items, { mode: "hidden" }, "tree"), { expanded: false }).render(40),
        ).toEqual([]);

        expect(component(list(items, { mode: "hidden" }, "tree")).render(40)).toHaveLength(12);
        const rows = lines(
            component(list(items, { mode: "head", collapsedLines: 2 }, "tree"), {
                expanded: false,
            }).render(40),
        );
        expect(rows).toHaveLength(3);
        expect(rows.slice(0, 2)).toEqual(["  ├ item 0", "  ├ item 1"]);
        expect(rows[2]).toContain("… +10 lines");
    });

    it.each([40, 80])(
        "renders nested semantic components and budgets streaming content at width %s",
        (width) => {
            const streamCode = vi.fn<NonNullable<ThirdPartyToolRenderContext["streamCode"]>>(
                (input) => (input.complete ? input.source : (input.source.split("\n")[0] ?? "")),
            );
            const node = list(
                [
                    stack([code("first complete\nfirst pending")]),
                    call(
                        { static: "Nested" },
                        {
                            body: list(
                                [
                                    output("second complete\nsecond pending", {
                                        streaming: { kind: "code" },
                                    }),
                                    output("ordinary output stays immediate"),
                                ],
                                undefined,
                                "tree",
                            ),
                        },
                    ),
                ],
                undefined,
                "tree",
            );
            const partial = component(node, {
                streamCode,
                argsComplete: false,
                isPartial: true,
            }).render(width);
            expect(lines(partial)).toEqual([
                "  ├ first complete",
                "  └ • Nested",
                "      ├ second complete",
                "      └ ordinary output stays immediate",
            ]);

            expect(streamCode.mock.calls.map(([input]) => input.targetWidth)).toEqual([
                width - 4,
                width - 8,
            ]);
            const keys = streamCode.mock.calls.map(([input]) => input.key);
            expect(new Set(keys).size).toBe(2);
            streamCode.mockClear();
            const complete = component(node, { streamCode }).render(width);
            expect(lines(complete)).toContain("  │ first pending");
            expect(lines(complete)).toContain("      │ second pending");
            expect(streamCode.mock.calls.map(([input]) => input.key)).toEqual(keys);
            expect(complete.every((row) => visibleWidth(row) <= width)).toBe(true);
        },
    );

    it("bounds nested generated previews after streaming policy presentation", () => {
        const streamCode = vi.fn<NonNullable<ThirdPartyToolRenderContext["streamCode"]>>(
            () => "shown-1\nshown-2\nshown-3\nshown-4\nshown-5\nshown-6",
        );
        const node = list(
            [
                stack([
                    text("reviewer · running"),
                    output("private raw source", {
                        streaming: { kind: "code" },
                        preview: { mode: "head", collapsedLines: 2, expandedLines: 4 },
                    }),
                ]),
                text("tests · queued"),
            ],
            { collapsedLines: 20 },
            "tree",
        );
        const compact = lines(component(node, { expanded: false, streamCode }).render(80));
        expect(compact).toContain("  │ shown-2");
        expect(compact.join("\n")).not.toContain("shown-3");
        expect(compact.join("\n")).not.toContain("private raw source");
        expect(compact).toContain("  └ tests · queued");
        const expanded = lines(component(node, { expanded: true, streamCode }).render(80));
        expect(expanded).toContain("  │ shown-4");
        expect(expanded.join("\n")).not.toContain("shown-5");
        expect(streamCode).toHaveBeenCalledTimes(2);
    });

    it("honors tree style in outline while keeping default numbering", () => {
        const items = ["first\ncontinued", "last"];
        expect(
            lines(
                renderOutlineNode(list(items, undefined, "tree"), theme, context, "static").render(
                    40,
                ),
            ),
        ).toEqual(["    ├ first", "    │ continued", "    └ last"]);

        expect(lines(renderOutlineNode(list(items), theme, context, "static").render(40))).toEqual([
            "  1. first",
            "     continued",
            "  2. last",
        ]);
    });
});
