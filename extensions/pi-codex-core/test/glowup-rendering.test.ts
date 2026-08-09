import assert from "node:assert/strict";
import { test } from "vitest";

import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import { isGlowupWireRecord } from "../src/glowup/wire.ts";
import { createImagegenTool } from "../src/tools/imagegen.ts";
import { createViewImageTool } from "../src/tools/view-image/tool.ts";
import { createWebRunTool } from "../src/tools/web-run/tool.ts";

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

function inlineText(value: unknown): string {
    if (typeof value === "string") return value;
    return isGlowupWireRecord(value) && typeof value.text === "string" ? value.text : "";
}

function nodeText(node: unknown): string {
    if (!isGlowupWireRecord(node)) return "";
    switch (node.kind) {
        case "text":
            return inlineText(node.text);
        case "call":
            return nodeText(node.body);
        case "output":
            return typeof node.text === "string" ? node.text : "";
        case "stack":
            return Array.isArray(node.children) ? node.children.map(nodeText).join("\n") : "";
        case "empty":
            return "";
        default:
            return "";
    }
}

function parseArgs<Args>(
    renderer: { readonly parseArgs: (value: unknown) => Args | undefined },
    value: unknown,
): Args {
    const parsed = renderer.parseArgs(value);
    assert.ok(parsed);
    return parsed;
}

function parseResult<Result>(
    renderer: { readonly parseResult: (value: unknown) => Result | undefined },
    value: unknown,
): Result {
    const parsed = renderer.parseResult(value);
    assert.ok(parsed);
    return parsed;
}

test("Codex tools expose dependency-free Glowup protocol v3 adapters", () => {
    const tools = [
        createWebRunTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG }),
        createImagegenTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG }),
        createViewImageTool({ getConfig: () => DEFAULT_CODEX_CORE_CONFIG }),
    ];

    for (const tool of tools) {
        assert.equal(tool.glowupRendering.version, 3);
        assert.ok(tool.renderCall, `${tool.name} keeps its native renderer without Glowup`);
    }
});

test("web_run adapter summarizes calls and bounded source results", () => {
    const renderer = createWebRunTool({
        getConfig: () => DEFAULT_CODEX_CORE_CONFIG,
    }).glowupRendering;
    const args = parseArgs(renderer, { search_query: [{ q: "latest pi docs" }] });
    assert.equal(renderer.parseArgs?.(null), undefined);

    const call = renderer.renderCall?.(args, completeContext);
    assert.equal(call?.kind, "call");
    if (call?.kind !== "call") return;
    assert.equal(call.labels.static, "Web Search");
    assert.equal(nodeText(call), '"latest pi docs"');
    assert.doesNotMatch(nodeText(call), /search search/u);

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
    const call = renderer.renderCall?.(args, completeContext);
    assert.equal(call?.kind, "call");
    assert.match(nodeText(call), /~\/Projects\/theme\/preview\.png · detail: high/u);

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
