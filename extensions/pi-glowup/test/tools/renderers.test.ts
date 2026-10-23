import { describe, expect, it } from "vitest";
import {
    shouldPreserveThirdPartyToolRenderer,
    hasGlowupRenderingAdapter,
    createThirdPartyToolRenderer,
} from "../../src/tools/renderers.ts";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_MUTATION_SETTINGS } from "../../src/rendering/preview-settings.ts";
import Type from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "../../src/json-value.ts";
import { stripVTControlCharacters } from "node:util";
import {
    call,
    list,
    mutation,
    stack,
    summary,
    text,
    output,
    withGlowupRendering,
} from "../../src/tools/protocol/contract.ts";
import {
    registerGlowupToolRenderer,
    registerGlowupPresentation,
    selectGlowupPresentation,
    outlinePresentation,
    compactPresentation,
} from "../../src/presentation.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../support/theme-colors.ts";
import type { ThirdPartyToolRenderingOptions } from "../../src/tools/types.ts";
import {
    contributedToolRenderer,
    observeGlowupRendering,
} from "../../src/rendering/presentation-registry.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
const context = {
    toolCallId: "sample-call",
    args: {},
    executionStarted: true,
    argsComplete: true,
    expanded: false,
    isPartial: false,
    showImages: false,
    isError: false,
};

function preserves(toolName: string, renderingOptions: ThirdPartyToolRenderingOptions): boolean {
    return shouldPreserveThirdPartyToolRenderer({
        toolName,
        toolDefinition: undefined,
        renderingOptions,
    });
}

describe("registered rendering contributions", () => {
    it("allows corrected registration after an observer rejects a matcher", () => {
        const failure = new Error("Matcher rejected the observed tool");
        const renderer = {
            version: 3,
            parseArgs: (value: JsonValue) => value,
            renderCall: () => call({ static: "Recovered" }),
        } as const;
        const stop = observeGlowupRendering(() => {
            contributedToolRenderer("registration_probe");
        });
        try {
            expect(() =>
                registerGlowupToolRenderer(
                    "rejected-registration",
                    (name) => {
                        if (name === "registration_probe") throw failure;
                        return false;
                    },
                    renderer,
                ),
            ).toThrow(failure);
        } finally {
            stop();
        }

        const registration = registerGlowupToolRenderer(
            "rejected-registration",
            (name) => name === "registration_probe",
            renderer,
        );
        try {
            const rows = createThirdPartyToolRenderer("registration_probe")
                .renderCall({}, theme, context)
                .render(70)
                .map((row) => stripVTControlCharacters(row).trimEnd());
            expect(rows).toEqual(["• Recovered"]);
        } finally {
            registration.dispose();
        }
    });

    it.each(["update", "dispose"] as const)(
        "retains the previous renderer after rejected %s and allows retry",
        (operation) => {
            const renderer = {
                version: 3,
                parseArgs: (value: JsonValue) => value,
                renderCall: () => call({ static: "Original" }),
            } as const;
            const registration = registerGlowupToolRenderer(
                `rejected-${operation}`,
                (name) => name === "transaction_probe",
                renderer,
            );
            const replacement = { ...renderer, renderCall: () => call({ static: "Replacement" }) };
            const render = () =>
                createThirdPartyToolRenderer("transaction_probe")
                    .renderCall({}, theme, context)
                    .render(70)
                    .map((row) => stripVTControlCharacters(row).trimEnd());

            const failure = new Error("Observed rendering rejected the change");
            let reject = true;
            const stop = observeGlowupRendering(() => {
                if (reject) {
                    reject = false;
                    throw failure;
                }
            });
            try {
                expect(() => {
                    if (operation === "update") registration.update(replacement);
                    else registration.dispose();
                }).toThrow(failure);

                expect(render()).toEqual(["• Original"]);
                stop();

                if (operation === "update") {
                    registration.update(replacement);
                    expect(render()).toEqual(["• Replacement"]);
                } else {
                    registration.dispose();
                    expect(render().join("\n")).not.toContain("Original");
                }
            } finally {
                stop();
                registration.dispose();
            }
        },
    );

    it("selects separate contributions, keeps owner priority, and restores generic selection after disposal", () => {
        const argsSchema = Type.Object({ path: Type.String() });
        const renderer = {
            version: 3,
            parseArgs(value: JsonValue) {
                return Value.Parse(argsSchema, value);
            },
            renderCall: (args: { path: string }) =>
                call(
                    { static: "Inventory" },
                    { body: summary([{ label: "Folder", value: args.path }]) },
                ),
        } as const;
        const registration = registerGlowupToolRenderer(
            "inventory-layout",
            (name) => name === "inventory",
            renderer,
        );
        const args = { path: "samples" };
        const owner = withGlowupRendering(
            {},
            { ...renderer, renderCall: () => call({ static: "Owned inventory" }) },
        );
        const render = (definition?: typeof owner) =>
            createThirdPartyToolRenderer("inventory", undefined, definition)
                .renderCall(args, theme, { ...context, args })
                .render(70)
                .map((line) => stripVTControlCharacters(line).trimEnd());
        try {
            expect(render()).toEqual(["• Inventory", "  └ Folder → samples"]);
            expect(render(owner)).toEqual(["• Owned inventory"]);
            registration.update({
                ...renderer,
                renderCall: () => call({ static: "Updated inventory" }),
            });

            expect(render()).toEqual(["• Updated inventory"]);
            registration.dispose();
            expect(render().join("\n")).toContain("inventory");
            expect(render().join("\n")).not.toContain("Updated inventory");
            registration.dispose();
        } finally {
            registration.dispose();
        }
    });

    it("selects whole presentations with different headers, fields, and output flow", () => {
        const registration = registerGlowupPresentation("focus", outlinePresentation);
        const args = { path: "samples" };
        const definition = withGlowupRendering(
            {},
            {
                version: 3,
                parseArgs: (value) => value,
                renderCall: () =>
                    call(
                        { static: "Inventory" },
                        { body: summary([{ label: "Folder", value: "samples" }]) },
                    ),
            },
        );
        const render = () =>
            createThirdPartyToolRenderer("inventory", undefined, definition)
                .renderCall(args, theme, { ...context, args })
                .render(70)
                .map((line) => stripVTControlCharacters(line).trimEnd());
        try {
            selectGlowupPresentation("focus");
            expect(render()).toEqual(["  » Inventory", "    Folder: samples"]);
            const result = createThirdPartyToolRenderer("inventory")
                .renderResult(
                    { content: [{ type: "text", text: "first\nsecond" }] },
                    { expanded: false, isPartial: false },
                    theme,
                    context,
                )
                .render(70)
                .map((line) => stripVTControlCharacters(line).trimEnd());
            expect(result).toEqual(["  first", "  second"]);
            const ownerText = outlinePresentation
                .renderNode(text("first\nsecond"), theme, context, "static")
                .render(70)
                .map((line) => stripVTControlCharacters(line).trimEnd());
            expect(ownerText).toEqual(["  first", "  second"]);
            registration.update(compactPresentation);
            expect(render()).toEqual(["• Inventory", "  └ Folder → samples"]);
            registration.dispose();
            expect(render()).toEqual(["• Inventory", "  └ Folder → samples"]);
        } finally {
            registration.dispose();
            selectGlowupPresentation("compact");
        }
    });
});

describe("outline preview policy", () => {
    it.each([false, true])("redacts sensitive argument values with expanded=%s", (expanded) => {
        const args = {
            api_key: "sample-secret-key",
            password: "sample-secret-password",
            items: [{ name: "visible-item", token: "sample-secret-token" }],
        };
        try {
            selectGlowupPresentation("outline");
            const rendered = createThirdPartyToolRenderer("sample_lookup")
                .renderCall(args, theme, { ...context, args, expanded })
                .render(100)
                .map(stripVTControlCharacters)
                .join("\n");
            expect(rendered).toContain("api_key: [redacted]");
            expect(rendered).toContain("password: [redacted]");
            expect(rendered).toContain("visible-item");
            expect(rendered).toContain('"token":"[redacted]"');
            expect(rendered).not.toContain("sample-secret");
        } finally {
            selectGlowupPresentation("compact");
        }
    });

    it("keeps expansion-only list content hidden until expanded", () => {
        const node = list(["first", "second"], { mode: "hidden" });
        const collapsed = outlinePresentation.renderNode(node, theme, context, "static").render(60);
        const expanded = outlinePresentation
            .renderNode(node, theme, { ...context, expanded: true }, "static")
            .render(60);
        expect(collapsed).toEqual([]);
        expect(expanded.map(stripVTControlCharacters).map((line) => line.trimEnd())).toEqual([
            "  1. first",
            "  2. second",
        ]);
    });

    it("keeps the first and last list rows in a head-tail preview", () => {
        const node = list(["first", "second", "third", "fourth", "last"], {
            mode: "headTail",
            collapsedLines: 2,
        });
        const rows = outlinePresentation
            .renderNode(node, theme, context, "static")
            .render(100)
            .map(stripVTControlCharacters)
            .map((line) => line.trimEnd());
        expect(rows).toHaveLength(3);
        expect(rows[0]).toBe("  1. first");
        expect(rows[1]).toMatch(/^  … \+3 lines/u);
        expect(rows[2]).toBe("  5. last");
    });

    it("preserves the output owner's empty-result status", () => {
        const node = output(undefined, { noOutputLabel: "No matching records" });
        const rows = outlinePresentation
            .renderNode(node, theme, context, "static")
            .render(60)
            .map(stripVTControlCharacters)
            .map((line) => line.trimEnd());
        expect(rows).toEqual(["  No matching records"]);
    });
});

describe("outline mutation policy", () => {
    it("hides unknown deletion counts instead of presenting zero placeholders", () => {
        const node = mutation({ static: "Patch" }, [
            { path: "removed.txt", added: 0, removed: 0, countsKnown: false, lines: [] },
        ]);
        expect(
            outlinePresentation
                .renderNode(node, theme, context, "static")
                .render(80)
                .map((row) => stripVTControlCharacters(row).trimEnd()),
        ).toEqual(["  removed.txt"]);
    });

    it.each([
        { expanded: true, settings: { ...DEFAULT_MUTATION_SETTINGS, defaultView: "preview" } },
        { expanded: false, settings: DEFAULT_MUTATION_SETTINGS },
    ] as const)("replays complete patches with expanded=$expanded", ({ expanded, settings }) => {
        const node = mutation(
            { static: "Patch" },
            [
                {
                    path: "sample.txt",
                    added: 1,
                    removed: 0,
                    lines: [{ kind: "addition", text: "new" }],
                },
            ],
            {
                patch: "--- a/sample.txt\n+++ b/sample.txt\n@@ -1,2 +1,3 @@\n before\n+new\n after\n",
            },
        );
        const rows = outlinePresentation
            .renderNode(node, theme, { ...context, expanded }, "static", settings)
            .render(80)
            .map((row) => stripVTControlCharacters(row).trimEnd());
        expect(rows).toEqual(["  sample.txt (+1)", "    before", "  + new", "    after"]);
    });

    const additions = mutation({ static: "Patch" }, [
        {
            path: "sample.ts",
            added: 100,
            removed: 0,
            lines: Array.from({ length: 100 }, (_, index) => ({
                kind: "addition",
                text: `row ${index + 1}`,
            })),
        },
    ]);
    const previewSettings = {
        ...DEFAULT_MUTATION_SETTINGS,
        defaultView: "preview",
        previewLines: 3,
    } as const;

    it("bounds a collapsed preview to changed/content rows with one bottom omission", () => {
        const rows = outlinePresentation
            .renderNode(additions, theme, context, "static", previewSettings)
            .render(100)
            .map((row) => stripVTControlCharacters(row).trimEnd());
        expect(rows).toHaveLength(5);
        expect(rows.slice(0, 4)).toEqual([
            "  sample.ts (+100)",
            "  + row 1",
            "  + row 2",
            "  + row 100",
        ]);

        expect(rows[4]).toMatch(/^  … \+97 lines \(.*to expand\)$/u);
    });

    it.each([
        { expanded: true, settings: previewSettings },
        { expanded: false, settings: DEFAULT_MUTATION_SETTINGS },
    ])(
        "shows every available row with expanded=$expanded and $settings.defaultView",
        ({ expanded, settings }) => {
            const rows = outlinePresentation
                .renderNode(additions, theme, { ...context, expanded }, "static", settings)
                .render(100)
                .map((row) => stripVTControlCharacters(row).trimEnd());
            expect(rows).toHaveLength(101);
            expect(rows[1]).toBe("  + row 1");
            expect(rows[100]).toBe("  + row 100");
            expect(rows.some((row) => row.includes("…"))).toBe(false);
        },
    );

    it("propagates policy through calls, stacks, and lists without losing outline style", () => {
        const node = call({ static: "Review" }, { body: stack([list([additions])]) });
        const rows = outlinePresentation
            .renderNode(node, theme, context, "static", previewSettings)
            .render(100)
            .map((row) => stripVTControlCharacters(row).trimEnd());
        expect(rows).toHaveLength(6);
        expect(rows[0]).toBe("  » Review");
        expect(rows[1]).toBe("    1. sample.ts (+100)");
        expect(rows[4]).toContain("+ row 100");
        expect(rows[5]).toContain("… +97 lines");
    });

    it("prioritizes changes over metadata and context, preserving explicit omissions in full view", () => {
        const node = mutation({ static: "Patch" }, [
            {
                path: "sample.ts",
                added: 1,
                removed: 1,
                lines: [
                    { kind: "metadata", text: "@@ hunk @@" },
                    { kind: "context", text: "before" },
                    { kind: "deletion", text: "old" },
                    { kind: "addition", text: "new" },
                    { kind: "context", text: "after" },
                    { kind: "omission", text: "unavailable rows" },
                ],
            },
        ]);
        const render = (settings: typeof DEFAULT_MUTATION_SETTINGS) =>
            outlinePresentation
                .renderNode(node, theme, context, "static", settings)
                .render(100)
                .map((row) => stripVTControlCharacters(row).trimEnd());
        const preview = render({ ...previewSettings, previewLines: 2 });
        expect(preview.slice(0, 3)).toEqual(["  sample.ts (+1 -1)", "  - old", "  + new"]);
        expect(preview).toHaveLength(4);
        expect(preview[3]).toContain("… +4 lines");
        expect(render(DEFAULT_MUTATION_SETTINGS).at(-1)).toBe("  … unavailable rows");
    });

    it("bounds wrapped preview rows and reacts to narrow widths", () => {
        const node = mutation({ static: "Patch" }, [
            {
                path: "界.ts",
                added: 2,
                removed: 0,
                lines: [
                    { kind: "addition", text: "界".repeat(200) },
                    { kind: "addition", text: "hidden" },
                ],
            },
        ]);
        const component = outlinePresentation.renderNode(node, theme, context, "static", {
            ...previewSettings,
            previewLines: 1,
        });
        for (const width of [80, 12, 1, 40]) {
            const rows = component.render(width);
            expect(rows.length).toBeLessThanOrEqual(6);
            expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        }
    });
});

describe("expanded presentation budgets", () => {
    it.each([
        { content: "one\ntwo\nthree\nfour", expected: ["  └ one", "    two", "    … +2 lines"] },
        { content: "one\ntwo\nthree", expected: ["  └ one", "    two", "    three"] },
    ])(
        "bounds expanded content without hiding a row that costs the same as its marker",
        ({ content, expected }) => {
            const component = compactPresentation.renderNode(
                output(content, { preview: { expandedLines: 2 } }),
                theme,
                { ...context, expanded: true },
                "static",
            );
            expect(
                component.render(50).map((row) => stripVTControlCharacters(row).trimEnd()),
            ).toEqual(expected);
        },
    );
});

describe("schema result rendering", () => {
    it("uses declared field titles, array paths and structured content instead of textual serialization", () => {
        const definition = {
            outputSchema: Type.Object({
                count: Type.Number({ title: "Count" }),
                items: Type.Array(Type.Object({ name: Type.String() })),
            }),
        };
        const result = {
            content: [{ type: "text", text: "Unstructured fallback" }],
            structuredContent: { count: 2, items: [{ name: "alpha" }, { name: "beta" }] },
        };
        const rows = createThirdPartyToolRenderer("inventory", undefined, definition)
            .renderResult(result, { expanded: false, isPartial: false }, theme, context)
            .render(80)
            .map((line) => stripVTControlCharacters(line).trimEnd());
        expect(rows).toEqual([
            "  └ Count → 2",
            "    items[1] · name → alpha",
            "    items[2] · name → beta",
        ]);
    });

    it.each([
        {
            structuredContent: undefined,
            isPartial: false,
            isError: false,
            message: "Structured result missing for declared output schema.",
        },
        {
            structuredContent: { count: "invalid" },
            isPartial: false,
            isError: false,
            message: "Structured result does not match the declared output schema.",
        },
        {
            structuredContent: undefined,
            isPartial: true,
            isError: false,
            message: "Structured result pending.",
        },
        {
            structuredContent: undefined,
            isPartial: false,
            isError: true,
            message: "Tool unavailable",
        },
    ])(
        "retains readable diagnostics and tool text for incomplete or rejected structured results ($message)",
        ({ structuredContent, isPartial, isError, message }) => {
            const definition = { outputSchema: Type.Object({ count: Type.Number() }) };
            const result = {
                content: [{ type: "text", text: "Tool unavailable" }],
                structuredContent,
            };
            const rows = createThirdPartyToolRenderer("inventory", undefined, definition)
                .renderResult(result, { expanded: false, isPartial }, theme, {
                    ...context,
                    isPartial,
                    isError,
                })
                .render(100)
                .map((line) => stripVTControlCharacters(line).trimEnd());
            expect(rows.join("\n")).toContain(message);
            expect(rows.join("\n")).toContain("Tool unavailable");
        },
    );
});

describe("tool preservation policies", () => {
    it.each([
        { preference: "preserve", expected: true },
        { preference: undefined, expected: false },
    ])(
        "resolves preservation without evaluating unrelated output metadata ($expected)",
        ({ preference, expected }) => {
            const metadataReads: string[] = [];
            const definition = {
                glowupRendering: preference,
                get outputSchema() {
                    metadataReads.push("outputSchema");
                    throw new Error("Output metadata is not available during renderer selection");
                },
            };

            expect(
                shouldPreserveThirdPartyToolRenderer({
                    toolName: "inventory",
                    toolDefinition: definition,
                }),
            ).toBe(expected);

            expect(metadataReads).toEqual([]);
        },
    );

    it("recognizes owner adapters without evaluating unrelated output metadata", () => {
        const metadataReads: string[] = [];
        const definition = {
            ...withGlowupRendering(
                {},
                {
                    version: 3,
                    parseArgs: (value) => value,
                    renderCall: () => call({ static: "Inventory" }),
                },
            ),
            get outputSchema() {
                metadataReads.push("outputSchema");
                throw new Error("Output metadata is not available during renderer selection");
            },
        };

        expect(hasGlowupRenderingAdapter(definition)).toBe(true);
        expect(metadataReads).toEqual([]);
    });

    it("matches exact full and base names without matching substrings", () => {
        expect(preserves("owner__rich_tool", { preserveTools: ["rich_tool"] })).toBe(true);
        expect(preserves("owner__rich_tool", { preserveTools: ["owner__rich_tool"] })).toBe(true);
        expect(preserves("owner__rich_tool", { preserveTools: ["rich"] })).toBe(false);
        expect(preserves("other_tool", { preserveTools: ["rich_tool"] })).toBe(false);
    });

    it("matches patterns against full and base names and resets stateful patterns", () => {
        for (const pattern of [/^rich_tool$/g, /^owner__rich_tool$/y]) {
            const options: ThirdPartyToolRenderingOptions = {
                preserveMatchers: [{ kind: "pattern", pattern }],
            };
            pattern.lastIndex = 7;
            expect(preserves("owner__rich_tool", options)).toBe(true);
            expect(pattern.lastIndex).toBe(0);
            expect(preserves("owner__rich_tool", options)).toBe(true);
            expect(pattern.lastIndex).toBe(0);
            expect(preserves("owner__other_tool", options)).toBe(false);
            expect(pattern.lastIndex).toBe(0);
        }
    });

    it("passes only the original full name to predicates", () => {
        const received: string[] = [];
        const options: ThirdPartyToolRenderingOptions = {
            preserveMatchers: [
                {
                    kind: "predicate",
                    matches: (name) => {
                        received.push(name);

                        return name === "owner__rich_tool";
                    },
                },
            ],
        };
        expect(preserves("owner__rich_tool", options)).toBe(true);
        expect(preserves("rich_tool", options)).toBe(false);
        expect(received).toEqual(["owner__rich_tool", "rich_tool"]);
    });

    it("short-circuits programmatic matchers after exact-name preservation", () => {
        let calls = 0;
        expect(
            preserves("rich_tool", {
                preserveTools: ["rich_tool"],
                preserveMatchers: [
                    {
                        kind: "predicate",
                        matches: () => {
                            calls++;
                            return false;
                        },
                    },
                ],
            }),
        ).toBe(true);

        expect(calls).toBe(0);
        expect(preserves("rich_tool", {})).toBe(false);
    });
});
