import assert from "node:assert/strict";
import { test } from "vitest";
import { decodeGlowupNode } from "@zigai/pi-glowup/protocol";
import { compactPresentation } from "@zigai/pi-glowup/presentation";

import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import { parseGlowupWireRecord, type GlowupWireValue } from "../src/glowup/wire.ts";
import { StringDecoder } from "../src/schema-parsing.ts";
import { applyPatchGlowupRendering } from "../src/tools/apply-patch/glowup-rendering.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch/tool.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import { createViewImageTool } from "../src/tools/view-image/tool.ts";
import { createWebRunTool } from "../src/tools/web-run/tool.ts";
import { TEST_THEME, makeRenderContext, testDouble } from "./helpers.ts";

const completeContext = {
    toolName: "tool",
    toolCallId: "glowup-test",
    phase: "complete",
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
} as const;

function inlineText(value: GlowupWireValue | undefined): string {
    const text = StringDecoder.decode(value);
    if (text !== undefined) return text;
    return StringDecoder.decode(parseGlowupWireRecord(value)?.text) ?? "";
}

function nodeText(node: GlowupWireValue | undefined): string {
    const record = parseGlowupWireRecord(node);
    if (!record) return "";
    if (record.kind === "text") return inlineText(record.text);
    if (record.kind === "call") return nodeText(record.body);
    if (record.kind === "output") return StringDecoder.decode(record.text) ?? "";

    if (record.kind === "summary" && Array.isArray(record.rows)) {
        return record.rows
            .map((row) => {
                const item = parseGlowupWireRecord(row);
                return `${inlineText(item?.label)} — ${inlineText(item?.value)}`;
            })
            .join("\n");
    }

    if (record.kind === "stack" && Array.isArray(record.children)) {
        return record.children.map(nodeText).join("\n");
    }

    return "";
}

function parseArgs<Args, Value>(
    renderer: { readonly parseArgs: (value: Value) => Args | undefined },
    value: Value,
): Args {
    const parsed = renderer.parseArgs(value);
    assert.ok(parsed);
    return parsed;
}

function parseResult<Result, Value>(
    renderer: { readonly parseResult: (value: Value) => Result | undefined },
    value: Value,
): Result {
    const parsed = renderer.parseResult(value);
    assert.ok(parsed);
    return parsed;
}

test("Codex tools expose passive Glowup protocol v3 adapters", () => {
    const tools = [
        createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG }),
        createImagegenTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG }),
        createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG }),
    ];

    for (const tool of tools) {
        assert.equal(tool.glowupRendering.version, 3);
        assert.ok(tool.renderCall, `${tool.name} keeps its native renderer without Glowup`);
    }

    const applyPatch = createApplyPatchTool();
    const rendering = testDouble<{
        readonly glowupRendering: typeof applyPatchGlowupRendering;
    }>(applyPatch).glowupRendering;
    assert.equal(rendering.version, 3);
    assert.ok(applyPatch.renderCall, "apply_patch keeps its native renderer without Glowup");
});

test("apply_patch adapter owns partial, planned, settled, and restored mutation rendering", () => {
    const rendering = applyPatchGlowupRendering;

    const patch = [
        "*** Begin Patch",
        "*** Add File: src/a.ts",
        "+export const a = 1;",
        "*** Update File: src/b.ts",
        "@@",
        "-export const b = 1;",
        "+export const b = 2;",
        "*** End Patch",
    ].join("\n");
    const args = rendering.parseArgs({ patch });
    assert.ok(args);
    const planned: unknown = rendering.renderCall(args, completeContext);
    const plannedRecord = parseGlowupWireRecord(planned);
    assert.ok(plannedRecord);
    assert.equal(plannedRecord.kind, "mutation");
    assert.ok(Array.isArray(plannedRecord.files));
    assert.equal(plannedRecord.files.length, 2);

    const partial: unknown = rendering.renderPartialCall({
        patch: "*** Begin Patch\n*** Add File: src/live.ts\n+export const live =",
    });
    const partialRecord = parseGlowupWireRecord(partial);
    assert.ok(partialRecord);
    assert.equal(partialRecord.kind, "mutation");
    const splitEmoji: unknown = rendering.renderPartialCall({
        patch: `*** Begin Patch\n*** Add File: src/live.ts\n+${"🧪".slice(0, 1)}`,
    });
    assert.deepEqual(
        splitEmoji,
        rendering.renderPartialCall({
            patch: "*** Begin Patch\n*** Add File: src/live.ts\n+",
        }),
    );
    const splitNode = rendering.renderPartialCall({
        patch: `*** Begin Patch\n*** Add File: src/live.ts\n+text${"🧪".slice(0, 1)}`,
    });
    assert.equal(splitNode.kind, "mutation");
    const text = splitNode.files[0]?.lines[0]?.text;
    assert.equal(text, "text");
    assert.doesNotMatch(text, /[\uD800-\uDFFF]/u);

    const completeEmoji = rendering.renderPartialCall({
        patch: "*** Begin Patch\n*** Add File: src/live.ts\n+text🧪",
    });
    assert.equal(completeEmoji.kind, "mutation");
    assert.equal(completeEmoji.files[0]?.lines[0]?.text, "text🧪");

    const settled: unknown = rendering.renderCall(args, {
        ...completeContext,
        hasResult: true,
    });
    assert.deepEqual(settled, { kind: "empty" });

    const result = rendering.parseResult({
        details: {
            patch:
                "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n" +
                "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-export const b = 1;\n+export const b = 2;\n",
            lineSummary: {
                files: [
                    { action: "A", path: "src/a.ts", addedLines: 1, removedLines: 0 },
                    { action: "M", path: "src/b.ts", addedLines: 1, removedLines: 1 },
                ],
            },
        },
    });
    assert.ok(result);
    const restored: unknown = rendering.renderResult(result);
    const restoredRecord = parseGlowupWireRecord(restored);
    assert.ok(restoredRecord);
    assert.equal(restoredRecord.kind, "mutation");
    assert.equal(StringDecoder.decode(restoredRecord.patch)?.includes("src/b.ts"), true);
    assert.equal(rendering.parseResult({ details: { patch: "invalid" } }), undefined);
});

test("passive patch preview preserves deletion-first ties, blank context, and move paths", () => {
    const args = applyPatchGlowupRendering.parseArgs({
        patch: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@ section\n-a\n-b\n+b\n+a\n \n*** End Patch",
    });
    assert.ok(args);
    assert.deepEqual(args.files, [
        {
            path: "new.txt",
            previousPath: "old.txt",
            added: 1,
            removed: 1,
            lines: [
                { kind: "metadata", text: "@@ section" },
                { kind: "deletion", text: "a" },
                { kind: "context", text: "b" },
                { kind: "addition", text: "a" },
                { kind: "context", text: "" },
            ],
        },
    ]);
});

test("web_run renders one semantic action line per request without result or option noise", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, {
        search_query: [
            { q: "release notes", domains: ["example.org"], recency: 7 },
            { q: "second query" },
            { q: "third query" },
        ],
        open: [{ ref_id: "https://example.org/docs?version=2", lineno: 42 }],
        click: [{ ref_id: "turn0view0", id: 12 }],
        find: [{ ref_id: "turn0view0", pattern: "render result" }],
        response_length: "long",
    });
    assert.equal(renderer.parseArgs(null), undefined);
    const node = decodeGlowupNode(renderer.renderCall(args, completeContext));
    assert.ok(node);
    const rendered = compactPresentation
        .renderNode(
            node,
            {
                fg: (_token, value) => value,
                bold: (value) => value,
            },
            { ...completeContext, args: {} },
            "static",
        )
        .render(200)
        .join("\n");
    assert.equal(
        rendered,
        [
            '• Searched the web for "release notes"',
            '• Searched the web for "second query"',
            '• Searched the web for "third query"',
            "• Opened https://example.org/docs?version=2",
            "• Followed link 12 on an earlier page",
            '• Searched for "render result" in turn0view0',
        ].join("\n"),
    );
    assert.doesNotMatch(rendered, /sources|recency|domains|length|lineno|42/u);
    assert.deepEqual(
        renderer.renderResult(
            parseResult(renderer, {
                content: [{ type: "text", text: "Source content that stays hidden" }],
                details: { sourceCount: 20 },
            }),
            { ...completeContext, args: parseArgs(renderer, { search_query: [{ q: "docs" }] }) },
        ),
        { kind: "empty" },
    );
});

test("web_run highlights search queries with Pi accent while keeping URLs blue", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, {
        search_query: [{ q: "docs" }, { q: "https://example.org/search-term" }],
        image_query: [{ q: "https://example.org/image-term" }],
        open: [{ ref_id: "https://example.org/docs" }],
        click: [{ ref_id: "https://example.org/docs", id: 3 }],
        find: [{ ref_id: "https://example.org/docs", pattern: "usage" }],
    });
    const node = decodeGlowupNode(renderer.renderCall(args, completeContext));
    assert.ok(node?.kind === "stack");
    assert.deepEqual(
        node.children.map((child) => child.kind === "call" && child.body),
        [
            { kind: "text", text: { kind: "text", text: '"docs"', tone: "accent" } },
            {
                kind: "text",
                text: { kind: "text", text: '"https://example.org/search-term"', tone: "accent" },
            },
            {
                kind: "text",
                text: { kind: "text", text: '"https://example.org/image-term"', tone: "accent" },
            },
            { kind: "text", text: { kind: "text", text: "https://example.org/docs", tone: "url" } },
            {
                kind: "text",
                text: { kind: "text", text: "link 3 on https://example.org/docs", tone: "url" },
            },
            {
                kind: "text",
                text: { kind: "text", text: '"usage" in https://example.org/docs', tone: "url" },
            },
        ],
    );

    for (const expanded of [false, true]) {
        const rendered = compactPresentation
            .renderNode(
                node,
                {
                    fg: (token, value) => `<${token}>${value}</${token}>`,
                    bold: (value) => value,
                },
                { ...completeContext, args: {}, expanded },
                "static",
            )
            .render(240)
            .join("\n");
        assert.match(rendered, /<accent>"docs"<\/accent>/u);
        assert.match(rendered, /<accent>"https:\/\/example\.org\/search-term"<\/accent>/u);
        assert.match(rendered, /<accent>"https:\/\/example\.org\/image-term"<\/accent>/u);
        assert.match(rendered, /<mdLinkUrl>https:\/\/example\.org\/docs<\/mdLinkUrl>/u);
    }
});

test("web_run keeps operation-specific lifecycle labels even in static label mode", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const cases = [
        [
            { search_query: [{ q: "release notes" }] },
            "Search the web for",
            "Searching the web for",
            "Searched the web for",
            "Web search failed for",
        ],
        [
            { image_query: [{ q: "terminal UI" }] },
            "Search images for",
            "Searching images for",
            "Searched images for",
            "Image search failed for",
        ],
        [{ open: [{ ref_id: "source-1" }] }, "Open", "Opening", "Opened", "Failed to open"],
        [
            { click: [{ ref_id: "source-1", id: 2 }] },
            "Follow",
            "Following",
            "Followed",
            "Failed to follow",
        ],
        [
            { find: [{ ref_id: "source-1", pattern: "Renderer" }] },
            "Search page for",
            "Searching for",
            "Searched for",
            "Page search failed for",
        ],
        [
            { screenshot: [{ ref_id: "source-1", pageno: 0 }] },
            "Capture",
            "Capturing",
            "Captured",
            "Failed to capture",
        ],
        [
            { finance: [{ ticker: "ACME", type: "equity", market: "USA" }] },
            "Fetch market data for",
            "Fetching market data for",
            "Fetched market data for",
            "Failed to fetch market data for",
        ],
        [
            { weather: [{ location: "London", duration: 3 }] },
            "Check weather for",
            "Checking weather for",
            "Checked weather for",
            "Failed to check weather for",
        ],
        [
            { sports: [{ fn: "standings", league: "epl", team: "ABC" }] },
            "Check sports",
            "Checking sports",
            "Checked sports",
            "Failed to check sports",
        ],
        [
            { time: [{ utc_offset: "+00:00" }] },
            "Check time in",
            "Checking time in",
            "Checked time in",
            "Failed to check time in",
        ],
    ] as const;
    for (const [rawArgs, pending, running, completed, failed] of cases) {
        const args = parseArgs(renderer, rawArgs);
        for (const [phase, isError, expected] of [
            ["pending", false, pending],
            ["running", false, running],
            ["complete", false, completed],
            ["complete", true, failed],
        ] as const) {
            const node = parseGlowupWireRecord(
                renderer.renderCall(args, { ...completeContext, phase, isError }),
            );
            const labels = parseGlowupWireRecord(node?.labels);
            assert.ok(labels);
            assert.equal(labels.static, expected);
            assert.equal(labels.running, running);
            assert.equal(labels.completed, completed);
            assert.equal(labels.failed, failed);
        }
    }
});

test("web_run expands readable source entries with blue URLs and explicit excerpt omissions", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, { open: [{ ref_id: "https://example.org/docs" }] });
    const rawOutput = [
        "Docs (https://example.org/docs)",
        "citeturn0view0 Content type: text/html; Total lines: 1000",
        "L0: Menu",
        "L1: Short",
        "Unnumbered content must survive.",
        ...Array.from({ length: 600 }, (_, i) => `L${i + 2}: Complete page line ${i + 2}`),
        "Final unnumbered content.",
    ].join("\n");
    const result = parseResult(renderer, {
        content: [
            { type: "text", text: rawOutput },
            { type: "text", text: "Second text block." },
        ],
    });
    const expanded = renderer.renderResult(result, { ...completeContext, args, expanded: true });
    assert.match(
        nodeText(expanded),
        /Docs\nhttps:\/\/example\.org\/docs\nShort Unnumbered content must survive\./u,
    );
    assert.match(nodeText(expanded), /omitted/u);
    assert.doesNotMatch(
        nodeText(expanded),
        /Content type:|Total lines:|L\d+:|Complete page line 601|cite/u,
    );
    const node = decodeGlowupNode(expanded);
    assert.ok(node);
    const rendered = compactPresentation
        .renderNode(
            node,
            {
                fg: (_token, value) => value,
                bold: (value) => value,
            },
            { ...completeContext, args: {}, expanded: true },
            "static",
        )
        .render(200)
        .join("\n");
    assert.match(rendered, /Docs/u);
    assert.match(rendered, /Unnumbered content must survive/u);
    assert.doesNotMatch(rendered, /L601:|Final unnumbered content/u);
    assert.match(JSON.stringify(expanded), /"tone":"url"/u);
    assert.match(JSON.stringify(expanded), /"bold":true/u);
});

test("native and Glowup expanded sources keep all entries and the same readable prose", () => {
    const tool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(tool.renderResult);
    const renderer = tool.glowupRendering;
    const raw = Array.from({ length: 7 }, (_, index) =>
        [
            `Guide ${index + 1} (https://example.org/guide-${index + 1})`,
            "【turn0search0】 [wordlim: 200] Crawled: today;",
            "# Navigation",
            "* Home",
            "* Guide",
            "History",
            "",
            "This guide explains how to configure the application with practical examples.",
        ].join("\n"),
    ).join("\n--------------------------------------------------------------------------------\n");
    const result = {
        content: [{ type: "text" as const, text: raw }],
        details: {
            fullOutputPath: "/existing/artifact.txt",
            outputCharacters: raw.length,
            sourceCount: 7,
        },
    };
    const args = parseArgs(renderer, { search_query: [{ q: "guides" }] });
    const expanded = renderer.renderResult(parseResult(renderer, result), {
        ...completeContext,
        args,
        expanded: true,
    });
    const native = tool.renderResult(
        result,
        { expanded: true, isPartial: false },
        TEST_THEME,
        makeRenderContext({}),
    );
    assert.equal(
        native
            .render(1000)
            .map((line) => line.trimEnd())
            .join("\n"),
        nodeText(expanded),
    );
    assert.match(
        nodeText(expanded),
        /Guide 7\nhttps:\/\/example\.org\/guide-7\nThis guide explains/u,
    );
    assert.doesNotMatch(nodeText(expanded), /Navigation|History|wordlim|Crawled|----|【turn/u);
    assert.equal(result.content[0]?.text, raw);
});

test("web_run handles streaming arguments, partial results, empty output, and errors", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, {});
    const streaming = renderer.renderCall(
        parseArgs(renderer, {
            open: [],
            find: [{ ref_id: "turn0view0" }],
            search_query: [{ q: "partial query" }],
        }),
        { ...completeContext, phase: "pending", argsComplete: false, isPartial: true },
    );
    assert.match(nodeText(streaming), /partial query/u);
    assert.doesNotMatch(nodeText(streaming), /undefined|request/u);
    const partial = parseResult(renderer, { content: [{ type: "text", text: "Partial page" }] });
    assert.deepEqual(
        renderer.renderResult(partial, { ...completeContext, args, isPartial: true }),
        { kind: "empty" },
    );
    assert.equal(
        nodeText(
            renderer.renderResult(partial, {
                ...completeContext,
                args,
                expanded: true,
                isPartial: true,
            }),
        ),
        "Partial page",
    );
    assert.equal(
        nodeText(
            renderer.renderResult(parseResult(renderer, {}), {
                ...completeContext,
                args,
                expanded: true,
            }),
        ),
        "No web output.",
    );
    assert.deepEqual(
        renderer.renderResult(parseResult(renderer, {}), { ...completeContext, args }),
        { kind: "empty" },
    );
    assert.equal(
        renderer.renderResult(partial, { ...completeContext, args, isError: true }),
        undefined,
    );
    assert.equal(
        renderer.renderResult(partial, { ...completeContext, args, expanded: true, isError: true }),
        undefined,
    );
});

const REFERENCE_ARGS = {
    search_query: [{ q: "plugins" }],
    open: [{ ref_id: "https://example.org/start" }, { ref_id: "turn0view0", lineno: 40 }],
    click: [
        { ref_id: "turn0view0", id: 5 },
        { ref_id: "turn0view0", id: 6 },
        { ref_id: "turn0view0", id: 7 },
        { ref_id: "turn0view0", id: 8 },
        { ref_id: "turn0view0", id: 9 },
        { ref_id: "turn0view0", id: 10 },
    ],
};

// Sections arrive in Codex's order, not the argument order, and titles may wrap.
const REFERENCE_OUTPUT = [
    "Plugins A (https://example.org/a)\n【turn1view3】 [wordlim: 200] Content type: text/html; " +
        'Source: click({"ref_id":"turn0view0","id":5}); Total lines: 3\nL0: This page lists every available search plugin.',
    "Internal Error ()\n【turn1view4】 [wordlim: 200] " +
        'Source: click({"ref_id":"turn0view0","id":6}); \nFailed to fetch https://example.org/b: (403) Forbidden',
    "Internal Error ()\n【turn1view5】 [wordlim: 200] " +
        'Source: click({"ref_id":"turn0view0","id":7}); Total lines: 1\n' +
        "L0: URL https://example.org/c is not accessible via this tool.",
    "Start (https://example.org/start)\n【turn1view0】 [wordlim: 200] " +
        'Source: open({"ref_id":"https://example.org/start","lineno":null}); Total lines: 1\nL0: Start',
    "Earlier page with a\n long title (https://example.org/earlier)\n【turn1view1】 [wordlim: 200] " +
        'Source: open({"ref_id":"turn0view0","lineno":40}); Total lines: 9\nL40: Middle',
    "Internal Error ()\n【turn1view6】 [wordlim: 200] " +
        'Source: click({"ref_id":"turn0view0","id":8}); Total lines: 0',
    "Widget (software) (https://example.org/wiki/Widget_(software))\n【turn1view7】 [wordlim: 200] " +
        'Source: click({"ref_id":"turn0view0","id":10}); Total lines: 2\n' +
        "L0: The client logs Failed to fetch https://example.org/api: (500) Server Error when offline.",
].join("\n--------------------------------------------------------------------------------\n");

function plainNode(
    node: GlowupWireValue | undefined,
    context: { readonly expanded?: boolean; readonly isError?: boolean } = {},
): string {
    const decoded = decodeGlowupNode(node);
    assert.ok(decoded);
    return compactPresentation
        .renderNode(
            decoded,
            { fg: (_token, value) => value, bold: (value) => value },
            { ...completeContext, ...context, args: {} },
            "static",
        )
        .render(200)
        .map((line) => line.trimEnd())
        .join("\n");
}

test("web_run shows the pages that clicks and earlier-page opens reached", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, REFERENCE_ARGS);
    const settled = { ...completeContext, hasResult: true };
    const result = parseResult(renderer, { content: [{ type: "text", text: REFERENCE_OUTPUT }] });

    assert.equal(
        plainNode(renderer.renderCall(args, settled)),
        ['• Searched the web for "plugins"', "• Opened https://example.org/start"].join("\n"),
    );
    const rows = [
        "• Opened https://example.org/earlier",
        "• Followed link to https://example.org/a",
        "• Failed to follow link to https://example.org/b (403 Forbidden)",
        "• Failed to follow link to https://example.org/c (not accessible via this tool)",
        "• Failed to follow link 8 on an earlier page (request failed)",
        "• Followed link 9 on an earlier page",
        "• Followed link to https://example.org/wiki/Widget_(software)",
    ];
    assert.equal(plainNode(renderer.renderResult(result, { ...settled, args })), rows.join("\n"));

    const expanded = plainNode(
        renderer.renderResult(result, { ...settled, args, expanded: true }),
        { expanded: true },
    );
    assert.ok(expanded.startsWith(rows.join("\n")));
    assert.match(expanded, /lists every available search plugin/u);
    const styled = JSON.stringify(renderer.renderResult(result, { ...settled, args }));
    assert.match(styled, /"text":"https:\/\/example\.org\/b","tone":"url"/u);
    assert.match(styled, /"text":" \(403 Forbidden\)","tone":"muted"/u);
    assert.match(styled, /"state":"error"/u);
});

test("web_run names referenced pages by position until a result arrives or when the call fails", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, {
        open: [{ ref_id: "turn0view0" }],
        click: [{ ref_id: "turn0view0", id: 65 }],
    });

    assert.equal(
        plainNode(renderer.renderCall(args, { ...completeContext, phase: "running" })),
        ["• Opening an earlier page", "• Following link 65 on an earlier page"].join("\n"),
    );
    assert.equal(
        plainNode(
            renderer.renderCall(args, { ...completeContext, hasResult: true, isError: true }),
            { isError: true },
        ),
        ["• Failed to open an earlier page", "• Failed to follow link 65 on an earlier page"].join(
            "\n",
        ),
    );
    assert.deepEqual(renderer.renderCall(args, { ...completeContext, hasResult: true }), {
        kind: "empty",
    });
});

test("native web_run shows the same reached pages as Glowup", () => {
    const tool = createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG });
    assert.ok(tool.renderCall);
    assert.ok(tool.renderResult);
    const renderer = tool.glowupRendering;
    const result = {
        content: [{ type: "text" as const, text: REFERENCE_OUTPUT }],
        details: {
            fullOutputPath: "/existing/artifact.txt",
            outputCharacters: REFERENCE_OUTPUT.length,
            sourceCount: 4,
        },
    };
    const context = makeRenderContext(REFERENCE_ARGS);
    const plainComponent = (component: { render: (width: number) => string[] }) =>
        component
            .render(200)
            .map((line) => line.trimEnd())
            .join("\n");

    assert.equal(
        plainComponent(tool.renderCall(REFERENCE_ARGS, TEST_THEME, context)),
        ['Searched the web for "plugins"', "Opened https://example.org/start"].join("\n"),
    );
    const glowupRows = plainNode(
        renderer.renderResult(parseResult(renderer, result), {
            ...completeContext,
            hasResult: true,
            args: parseArgs(renderer, REFERENCE_ARGS),
        }),
    );
    assert.equal(
        plainComponent(
            tool.renderResult(result, { expanded: false, isPartial: false }, TEST_THEME, context),
        ),
        glowupRows.replaceAll("• ", ""),
    );
});

test("imagegen adapter preserves streaming, multiline, Unicode, and private-path behavior", () => {
    const renderer = createImagegenTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const longPrompt = `opening composition ${"middle detail ".repeat(
        100,
    )}latest lighting direction`;
    const longArgs = parseArgs(renderer, { prompt: longPrompt });
    assert.ok("renderPartialCall" in renderer);
    const active = renderer.renderPartialCall(
        { prompt: longPrompt },
        {
            ...completeContext,
            phase: "running",
            argsComplete: false,
            isPartial: true,
        },
    );
    const completed = renderer.renderCall(longArgs, completeContext);
    const compactActive = nodeText(active).replace(/\s+/gu, " ");
    const compactCompleted = nodeText(completed).replace(/\s+/gu, " ");
    assert.match(compactActive, /latest lighting direction/u);
    assert.doesNotMatch(compactActive, /opening composition/u);
    assert.match(compactCompleted, /opening composition/u);
    assert.match(compactCompleted, /latest lighting direction/u);

    const multilineArgs = parseArgs(renderer, {
        prompt: "First composition line.\nSecond lighting line.\nThird material line.",
    });
    const multiline = nodeText(renderer.renderCall(multilineArgs, completeContext));
    assert.match(
        multiline,
        /First composition line\.\nSecond lighting line\.\nThird material line\./u,
    );
    assert.doesNotMatch(multiline, /"First composition/u);
    const emojiPrompt = `${"a".repeat(87)}🧪${"b".repeat(10)}`;
    const emojiArgs = parseArgs(renderer, { prompt: emojiPrompt });
    const emoji = nodeText(renderer.renderCall(emojiArgs, { ...completeContext, expanded: true }))
        .trim()
        .replaceAll("\n", "");
    assert.equal(emoji, emojiPrompt);

    const result = parseResult(renderer, {
        details: {
            images: [
                {
                    latestPath: "/home/user/.pi/agent/pi-codex-core/imagegen/private/latest.png",
                },
            ],
        },
    });
    const renderedResult = nodeText(
        renderer.renderResult(result, { ...completeContext, args: longArgs }),
    );
    assert.equal(renderedResult, "Generated 1 image");
    assert.doesNotMatch(renderedResult, /latest\.png|\/\.pi\//u);
});

test("view_image adapter owns call labels and suppresses only successful attachment results", () => {
    const renderer = createViewImageTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, {
        path: "~/Projects/theme/preview.png",
        detail: "high",
    });
    assert.equal("renderPartialCall" in renderer, false);
    const call = renderer.renderCall(args, completeContext);
    assert.equal(call.kind, "call");
    assert.equal(nodeText(call), "~/Projects/theme/preview.png");

    const result = parseResult(renderer, {
        content: [{ type: "text", text: "[view_image image attached: /tmp/preview.png]" }],
    });
    assert.deepEqual(renderer.renderResult(result, { ...completeContext, args }), {
        kind: "empty",
    });
    assert.equal(
        renderer.renderResult(result, {
            ...completeContext,
            args,
            isError: true,
        }),
        undefined,
    );
});
