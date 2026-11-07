import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { GlowupCallState, GlowupRenderTheme } from "../../../src/rendering/theme.ts";
import {
    call,
    decodeGlowupNode,
    stack,
    text,
    type GlowupNode,
} from "../../../src/tools/protocol/contract.ts";
import { renderProtocolNode } from "../../../src/tools/protocol/node-renderer.ts";
import type { ThirdPartyToolRenderContext } from "../../../src/tools/types.ts";

const context: ThirdPartyToolRenderContext = {
    toolCallId: "mixed-cards",
    args: {},
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    isError: true,
    expanded: true,
    showImages: false,
    result: { content: [], details: {} },
};

const theme: GlowupRenderTheme = {
    fg(token, value) {
        if (token === "success") return `\u001b[32m${value}\u001b[0m`;
        if (token === "toolDiffRemoved") return `\u001b[31m${value}\u001b[0m`;
        if (token === "muted") return `\u001b[90m${value}\u001b[0m`;
        if (token === "dim") return `\u001b[2m${value}\u001b[0m`;
        return value;
    },
    bold: (value) => value,
};

const labels = (name: string) => ({
    static: name,
    running: `Running ${name}`,
    completed: `Completed ${name}`,
    failed: `Failed ${name}`,
});

const component = (
    node: GlowupNode,
    overrides: Partial<ThirdPartyToolRenderContext> = {},
    mode: "static" | "lifecycle" = "lifecycle",
) => renderProtocolNode(node, theme, { ...context, ...overrides }, mode);

const plain = (rows: readonly string[]) =>
    rows.map((row) => stripVTControlCharacters(row).trimEnd());

const states: readonly GlowupCallState[] = ["running", "success", "error", "muted"];

describe("per-call protocol state", () => {
    it.each(states)("preserves explicit %s in helper and detached decoder snapshots", (state) => {
        const node = call(labels("Agent"), { state, body: text("summary") });
        expect(node).toEqual({
            kind: "call",
            labels: labels("Agent"),
            state,
            body: text("summary"),
        });

        expect(decodeGlowupNode(node)).toEqual(node);
        const source = { kind: "call", labels: labels("Agent"), state };
        const decoded = decodeGlowupNode(source);
        source.state = "muted";
        expect(decoded).toEqual({ kind: "call", labels: labels("Agent"), state });
    });

    it.each(["failed", "SUCCESS", "", null, false, 1, [], {}])(
        "rejects invalid state %j instead of silently inheriting global failure",
        (state) => {
            expect(
                decodeGlowupNode({ kind: "call", labels: labels("Agent"), state }),
            ).toBeUndefined();
        },
    );

    it("omits missing/undefined state and preserves the original helper shape", () => {
        const expected = { kind: "call", labels: labels("Agent") };
        expect(call(labels("Agent"))).toEqual(expected);
        expect(decodeGlowupNode({ ...expected, state: undefined })).toEqual(expected);
    });

    it("keeps one successful card green in a mixed failed result, including lifecycle labels", () => {
        const node = stack([
            call(labels("Writer"), { state: "success" }),
            call(labels("Reviewer"), { state: "error" }),
            call(labels("Inherited")),
        ]);
        const decoded = decodeGlowupNode(node);
        expect(decoded).toEqual(node);

        if (decoded === undefined) throw new Error("Expected valid call cards");

        const rows = component(decoded).render(80);
        expect(plain(rows)).toEqual([
            "• Completed Writer",
            "• Failed Reviewer",
            "• Failed Inherited",
        ]);

        expect(rows[0]).toContain("\u001b[32m•");
        expect(rows[1]).toContain("\u001b[31m•");
        expect(rows[2]).toContain("\u001b[31m•");
        expect(context.isError).toBe(true);
    });

    it.each([
        { state: "running", color: 90 },
        { state: "success", color: 32 },
        { state: "error", color: 31 },
        { state: "muted", color: 2 },
    ] as const)(
        "uses native $state indicator colors without changing static labels",
        ({ state, color }) => {
            const node = call(labels("Agent"), { state });
            const rows = component(node, {}, "static").render(80);
            expect(plain(rows)).toEqual(["• Agent"]);
            expect(rows[0]).toContain(`\u001b[${color}m•`);
        },
    );

    it("selects an explicit failure even when the surrounding result succeeds", () => {
        const rows = component(call(labels("Agent"), { state: "error" }), {
            isError: false,
        }).render(80);
        expect(plain(rows)).toEqual(["• Failed Agent"]);
        expect(rows[0]).toContain("\u001b[31m•");
    });

    it.each([
        { patch: {}, label: "Failed Agent", color: 31 },
        { patch: { isError: false }, label: "Completed Agent", color: 32 },
        {
            patch: { isError: false, isPartial: true, result: undefined },
            label: "Running Agent",
            color: 90,
        },
        {
            patch: { isError: false, argsComplete: false, result: undefined },
            label: "Running Agent",
            color: 90,
        },
    ])("preserves default state and lifecycle: $label", ({ patch, label, color }) => {
        const rows = component(call(labels("Agent")), patch).render(80);
        expect(plain(rows)).toEqual([`• ${label}`]);
        expect(rows[0]).toContain(`\u001b[${color}m•`);
    });

    it("does not propagate the override to nested calls or sibling defaults", () => {
        const node = stack([
            call(labels("Parent"), {
                state: "success",
                body: stack([call(labels("Child")), call(labels("Quiet"), { state: "muted" })]),
            }),
            call(labels("Sibling")),
        ]);
        const rows = component(node).render(80);
        expect(plain(rows)).toEqual([
            "• Completed Parent",
            "• Failed Child",
            "• Completed Quiet",
            "• Failed Sibling",
        ]);

        expect(rows[0]).toContain("\u001b[32m•");
        expect(rows[1]).toContain("\u001b[31m•");
        expect(rows[2]).toContain("\u001b[2m•");
        expect(rows[3]).toContain("\u001b[31m•");
    });

    it("bounds mixed cards at tiny widths and reflows the same component on resize", () => {
        const node = stack(
            states.map((state) =>
                call(labels(`Agent 界 ${state}`), {
                    state,
                    body: text("A long summary 👩‍💻 é " + "words ".repeat(12)),
                }),
            ),
        );
        const reused = component(node);
        for (const width of [80, 20, 8, 4, 3, 2, 1, 40, 80]) {
            const rows = reused.render(width);
            expect(rows).toEqual(component(node).render(width));
            expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);

            if (width >= 40) {
                expect(plain(rows).join("\n")).toContain("Completed Agent 界 success");
                expect(plain(rows).join("\n")).toContain("Failed Agent 界 error");
            }
        }
    });
});
