import assert from "node:assert/strict";
import { test } from "vitest";

import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import { parseGlowupWireRecord } from "../src/glowup/wire.ts";
import { StringDecoder } from "../src/schema-parsing.ts";
import { applyPatchGlowupRendering } from "../src/tools/apply-patch/glowup-rendering.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch/tool.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import { createViewImageTool } from "../src/tools/view-image/tool.ts";
import { createWebRunTool } from "../src/tools/web-run/tool.ts";
import { testDouble } from "./helpers.ts";

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

function inlineText<Value>(value: Value): string {
    const text = StringDecoder.decode(value);
    if (text !== undefined) return text;
    return StringDecoder.decode(parseGlowupWireRecord(value)?.text) ?? "";
}

function nodeText<Value>(node: Value): string {
    const record = parseGlowupWireRecord(node);
    if (!record) return "";
    if (record.kind === "text") return inlineText(record.text);
    if (record.kind === "call") return nodeText(record.body);
    if (record.kind === "output") return StringDecoder.decode(record.text) ?? "";
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
    }>()(applyPatch).glowupRendering;
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
    if (splitNode.kind === "mutation") {
        const text = splitNode.files[0]?.lines[0]?.text;
        assert.equal(text, "text");
        assert.doesNotMatch(text ?? "", /[\uD800-\uDFFF]/u);
    }
    const completeEmoji = rendering.renderPartialCall({
        patch: "*** Begin Patch\n*** Add File: src/live.ts\n+text🧪",
    });
    assert.equal(completeEmoji.kind, "mutation");
    if (completeEmoji.kind === "mutation") {
        assert.equal(completeEmoji.files[0]?.lines[0]?.text, "text🧪");
    }

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

test("web_run adapter summarizes calls and bounded source results", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, { search_query: [{ q: "latest pi docs" }] });
    assert.equal(renderer.parseArgs?.(null), undefined);
    assert.equal("renderPartialCall" in renderer, false);

    const call = renderer.renderCall?.(args, completeContext);
    assert.equal(call?.kind, "call");
    if (call?.kind !== "call") return;
    assert.equal(call.labels.static, "Web Search");
    assert.equal(nodeText(call), '"latest pi docs"');
    assert.doesNotMatch(nodeText(call), /search search/u);

    const operationLabels = [
        [{ image_query: [{ q: "terminal UI" }] }, "Image Search"],
        [{ open: [{ ref_id: "source-1" }] }, "Open Web"],
        [{ click: [{ ref_id: "source-1", id: 2 }] }, "Web Click"],
        [{ find: [{ ref_id: "source-1", pattern: "Renderer" }] }, "Web Find"],
        [{ screenshot: [{ ref_id: "source-1", pageno: 0 }] }, "Web Screenshot"],
        [{ finance: [{ ticker: "OPENAI", type: "equity" }] }, "Market Data"],
        [{ weather: [{ location: "London" }] }, "Weather"],
        [{ sports: [{ fn: "standings", league: "epl" }] }, "Sports"],
        [{ time: [{ utc_offset: "+00:00" }] }, "Time"],
        [{ search_query: [{ q: "Pi" }], open: [{ ref_id: "source-1" }] }, "Web Research"],
    ] as const;
    for (const [rawArgs, label] of operationLabels) {
        const parsedArgs = parseArgs(renderer, rawArgs);
        const node = renderer.renderCall?.(parsedArgs, completeContext);
        const record = parseGlowupWireRecord(node);
        const labels = parseGlowupWireRecord(record?.labels);
        assert.ok(labels);
        assert.equal(labels.static, label);
    }

    const output = [
        "Ripgrep Benchmarks (https://ripgrep.dev/benchmarks)",
        "Ripgrep Repository (https://github.com/BurntSushi/ripgrep)",
        "Rust Regex (https://docs.rs/regex/latest/regex)",
        "Grep Crate (https://docs.rs/grep/latest/grep)",
        "Ripgrep Crate (https://crates.io/crates/ripgrep)",
        "GNU Grep (https://www.gnu.org/software/grep/)",
    ].join("\n");
    const result = parseResult(renderer, {
        content: [{ type: "text", text: output }],
        details: { sourceCount: 6, fullOutputPath: "/tmp/private-web-run.txt" },
    });
    const collapsed = nodeText(renderer.renderResult?.(result, { ...completeContext, args }));
    const expanded = nodeText(
        renderer.renderResult?.(result, { ...completeContext, args, expanded: true }),
    );

    assert.match(collapsed, /6 sources/u);
    assert.match(collapsed, /Grep Crate — docs\.rs\/grep\/latest\/grep/u);
    assert.match(collapsed, /… \+2 sources/u);
    assert.doesNotMatch(collapsed, /Ripgrep Crate/u);
    assert.doesNotMatch(collapsed, /private-web-run/u);
    assert.match(expanded, /Ripgrep Crate — crates\.io\/crates\/ripgrep/u);
    assert.match(expanded, /GNU Grep — gnu\.org\/software\/grep/u);
    assert.doesNotMatch(expanded, /… \+2 sources/u);
});

test("web_run adapter keeps dense and huge result summaries bounded", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, {});
    const denseOutput = [
        "API References | Shiki (https://shiki.style/api)",
        'citeturn6view0 [wordlim: 200] Content type: text/html; Source: open({"ref_id":"https://shiki.style/api","lineno":null}); Total lines: 306',
        "L0: Skip to content",
        "L198: # API References",
        "L199: ## `codeToHast`",
    ].join("\n");
    const denseResult = parseResult(renderer, {
        content: [{ type: "text", text: denseOutput }],
        details: { sourceCount: 3, fullOutputPath: "/tmp/private.txt" },
    });
    const dense = nodeText(renderer.renderResult?.(denseResult, { ...completeContext, args }));
    assert.match(dense, /3 sources/u);
    assert.match(dense, /API References \| Shiki — shiki\.style\/api/u);
    assert.match(dense, /… \+2 sources/u);
    assert.doesNotMatch(dense, /codeToHast/u);
    assert.doesNotMatch(dense, /private\.txt/u);

    const hugeOutput = Array.from(
        { length: 1_000 },
        (_value, index) =>
            `Unique Source ${index + 1} (https://example.com/source-${index + 1})\nL${index + 1}: # Unique Highlight ${index + 1}`,
    ).join("\n");
    const hugeResult = parseResult(renderer, {
        content: [{ type: "text", text: hugeOutput }],
        details: { sourceCount: 1_000 },
    });
    const huge = nodeText(
        renderer.renderResult?.(hugeResult, {
            ...completeContext,
            args,
            expanded: true,
        }),
    );
    assert.match(huge, /Unique Source 100 — example\.com\/source-100/u);
    assert.match(huge, /… \+900 sources/u);
    assert.doesNotMatch(huge, /Unique Source 101 —/u);
    assert.doesNotMatch(huge, /Unique Highlight 500/u);
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
    const active = renderer.renderPartialCall?.(
        { prompt: longPrompt },
        {
            ...completeContext,
            phase: "running",
            argsComplete: false,
            isPartial: true,
        },
    );
    const completed = renderer.renderCall?.(longArgs, completeContext);
    const compactActive = nodeText(active).replace(/\s+/gu, " ");
    const compactCompleted = nodeText(completed).replace(/\s+/gu, " ");
    assert.match(compactActive, /latest lighting direction/u);
    assert.doesNotMatch(compactActive, /opening composition/u);
    assert.match(compactCompleted, /opening composition/u);
    assert.match(compactCompleted, /latest lighting direction/u);

    const multilineArgs = parseArgs(renderer, {
        prompt: "First composition line.\nSecond lighting line.\nThird material line.",
    });
    const multiline = nodeText(renderer.renderCall?.(multilineArgs, completeContext));
    assert.match(
        multiline,
        /First composition line\.\nSecond lighting line\.\nThird material line\./u,
    );
    assert.doesNotMatch(multiline, /"First composition/u);

    const emojiPrompt = `${"a".repeat(87)}🧪${"b".repeat(10)}`;
    const emojiArgs = parseArgs(renderer, { prompt: emojiPrompt });
    const emoji = nodeText(renderer.renderCall?.(emojiArgs, { ...completeContext, expanded: true }))
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
        renderer.renderResult?.(result, { ...completeContext, args: longArgs }),
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
    const call = renderer.renderCall?.(args, completeContext);
    assert.equal(call?.kind, "call");
    assert.equal(nodeText(call), "~/Projects/theme/preview.png");

    const result = parseResult(renderer, {
        content: [{ type: "text", text: "[view_image image attached: /tmp/preview.png]" }],
    });
    assert.deepEqual(renderer.renderResult?.(result, { ...completeContext, args }), {
        kind: "empty",
    });
    assert.equal(
        renderer.renderResult?.(result, {
            ...completeContext,
            args,
            isError: true,
        }),
        undefined,
    );
});
