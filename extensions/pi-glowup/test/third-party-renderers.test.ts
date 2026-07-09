import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering/core.ts";
import type { CodexLookRenderingAdapter } from "../src/tool-rendering/protocol.ts";
import {
    CODEX_LOOK_RENDERING_PROPERTY,
    createThirdPartyToolRenderer,
    hasCodexLookRenderingAdapter,
    parsePreservedThirdPartyToolNames,
    shouldPreserveThirdPartyToolRenderer,
} from "../src/third-party-tools/renderers.ts";

const plainTheme: CodexRenderTheme = {
    fg(token: string, text: string): string {
        return token === "accent" ? `<accent>${text}</accent>` : text;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

const renderContext = {
    args: {},
    toolCallId: "call-1",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: true,
    isError: false,
};

function stripAccentStyle(text: string): string {
    return text.replaceAll("<accent>", "").replaceAll("</accent>", "");
}

function compactRenderedText(text: string): string {
    return text.replace(/[│└]/gu, " ").replace(/\s+/gu, " ");
}

describe("third-party tool renderers", () => {
    it("uses passive codexLookRendering adapters when present", () => {
        type DbQueryArgs = {
            readonly sql: string;
        };
        type DbQueryResult = {
            readonly details?: {
                readonly rowCount?: number;
            };
        };
        const rendering = {
            version: 1,
            renderCall(args) {
                return {
                    kind: "call",
                    label: "DB Query",
                    body: args.sql,
                };
            },
            renderResult(result) {
                return {
                    kind: "output",
                    text: `${result.details?.rowCount ?? 0} rows`,
                    mode: "head",
                };
            },
        } satisfies CodexLookRenderingAdapter<DbQueryArgs, DbQueryResult>;
        const renderer = createThirdPartyToolRenderer("db_query", undefined, {
            [CODEX_LOOK_RENDERING_PROPERTY]: rendering,
        });

        expect(hasCodexLookRenderingAdapter({ [CODEX_LOOK_RENDERING_PROPERTY]: rendering })).toBe(
            true,
        );
        expect(
            renderer
                .renderCall({ sql: "select * from users" }, plainTheme, renderContext)
                .render(120)
                .join("\n"),
        ).toContain("DB Query select * from users");
        expect(
            renderer
                .renderResult(
                    { content: [], details: { rowCount: 3 } },
                    { expanded: false, isPartial: false },
                    plainTheme,
                    renderContext,
                )
                .render(120)
                .join("\n"),
        ).toContain("3 rows");
    });

    it("renders unknown tools as compact Codex-style calls", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");

        const lines = renderer
            .renderCall({ action: "run", value: 42 }, plainTheme, renderContext)
            .render(80);

        expect(lines.join("\n")).toContain("• Called custom_tool");
        expect(lines.join("\n")).toContain('"action": "run"');
    });

    it("bounds huge generic third-party tool call argument previews", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const args = {
            lines: Array.from({ length: 10_000 }, (_value, index) => `line ${index + 1}`),
        };

        const rendered = renderer
            .renderCall(args, plainTheme, { ...renderContext, expanded: true })
            .render(120)
            .join("\n");

        expect(rendered).toContain('"lines":');
        expect(rendered).toContain("… +9980 items");
        expect(rendered).not.toContain("line 10000");
    });

    it("uses shallow previews for partial generic third-party tool arguments", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const args = {
            prompt: "generate " + "token ".repeat(10_000),
            nested: { content: "do not traverse this".repeat(1_000) },
            files: Array.from({ length: 5_000 }, (_value, index) => `file-${index}`),
        };

        const rendered = renderer
            .renderCall(args, plainTheme, {
                ...renderContext,
                argsComplete: false,
                isPartial: true,
                expanded: true,
            })
            .render(120)
            .join("\n");

        expect(rendered).toContain("prompt: generate token");
        expect(rendered).toContain("nested: object");
        expect(rendered).toContain("files: 5000 items");
        expect(rendered).not.toContain("do not traverse this");
        expect(rendered).not.toContain("file-4999");
    });

    it("expands long third-party tool call arguments", () => {
        const renderer = createThirdPartyToolRenderer("custom_tool");
        const args = { lines: Array.from({ length: 10 }, (_value, index) => `line ${index + 1}`) };

        const collapsed = renderer
            .renderCall(args, plainTheme, renderContext)
            .render(80)
            .join("\n");
        const expanded = renderer
            .renderCall(args, plainTheme, { ...renderContext, expanded: true })
            .render(80)
            .join("\n");

        expect(collapsed).toContain("… +");
        expect(expanded).toContain("line 10");
        expect(expanded).not.toContain("… +");
    });

    it("uses browser-specific labels for agent browser calls", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser");

        const lines = renderer
            .renderCall({ args: ["snapshot", "-i"] }, plainTheme, renderContext)
            .render(80);

        expect(lines[0]).toContain("Browser Snapshot");
        expect(lines.join("\n")).toContain('"-i"');
    });

    it("uses shallow previews for partial agent browser job arguments", () => {
        const renderer = createThirdPartyToolRenderer("agent_browser");

        const rendered = renderer
            .renderCall(
                {
                    job: {
                        steps: Array.from({ length: 5_000 }, (_value, index) => ({
                            action: "fill",
                            text: `secretly large ${index}`,
                        })),
                    },
                },
                plainTheme,
                { ...renderContext, argsComplete: false, isPartial: true, expanded: true },
            )
            .render(120)
            .join("\n");

        expect(rendered).toContain("Browser");
        expect(rendered).toContain("steps: 5000 items");
        expect(rendered).not.toContain("secretly large");
    });

    it("uses Chrome DevTools labels for MCP gateway calls", () => {
        const renderer = createThirdPartyToolRenderer("mcp");

        const lines = renderer
            .renderCall(
                { tool: "take_snapshot", args: '{"verbose":true}' },
                plainTheme,
                renderContext,
            )
            .render(80);

        expect(lines[0]).toContain("Browser Snapshot");
        expect(lines.join("\n")).toContain("verbose");
    });

    it("normalizes namespaced Chrome DevTools MCP tool names", () => {
        const renderer = createThirdPartyToolRenderer("mcp__chrome-devtools__take_snapshot");

        const lines = renderer.renderCall({}, plainTheme, renderContext).render(80);

        expect(lines[0]).toContain("Browser Snapshot");
    });

    it("keeps partial result output compact unless expanded", () => {
        const renderer = createThirdPartyToolRenderer("custom_exec");

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: Array.from(
                                { length: 30 },
                                (_, index) => `line ${index + 1}`,
                            ).join("\n"),
                        },
                    ],
                },
                { expanded: false, isPartial: true },
                plainTheme,
                { ...renderContext, isPartial: true },
            )
            .render(100);

        expect(lines).toHaveLength(4);
        expect(lines.join("\n")).toContain("… +27 lines");
    });

    it("summarizes agent launch calls without dumping JSON", () => {
        const renderer = createThirdPartyToolRenderer("Agent");

        const lines = renderer
            .renderCall(
                {
                    description: "Update Pi template",
                    subagent_type: ".",
                    run_in_background: true,
                    prompt: "Do not duplicate this agent's work.",
                },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("Launched Agent");
        expect(rendered).toContain("Update Pi template");
        expect(rendered).toContain("running in background");
        expect(rendered).not.toContain("type: .");
        expect(rendered).not.toContain("subagent_type");
        expect(rendered).not.toContain("prompt");
    });

    it("bounds huge subagent steering messages", () => {
        const renderer = createThirdPartyToolRenderer("steer_subagent");
        const message = `  ${Array.from({ length: 10_000 }, (_value, index) => `word${index}`).join(
            "\n",
        )}  `;

        const rendered = renderer
            .renderCall({ agent_id: "0811c123-dcbe-4d3", message }, plainTheme, renderContext)
            .render(120)
            .join("\n");

        expect(rendered).toContain("Steered Agent");
        expect(rendered).toContain("0811c123-dcbe-4d3");
        expect(rendered).toContain("word0 word1");
        expect(rendered).toContain("…");
        expect(rendered).not.toContain("word9999");
        expect(rendered).not.toContain("message");
    });

    it("summarizes subagent result checks without dumping JSON", () => {
        const renderer = createThirdPartyToolRenderer("get_subagent_result");

        const lines = renderer
            .renderCall(
                { agent_id: "0811c123-dcbe-4d3", wait: true, verbose: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("Checked Agent");
        expect(rendered).toContain("0811c123-dcbe-4d3 · wait");
        expect(rendered).not.toContain("agent_id");
        expect(rendered).not.toContain("verbose");
    });

    it("summarizes completed subagent results", () => {
        const renderer = createThirdPartyToolRenderer("get_subagent_result");

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: [
                                "Agent: 0811c123-dcbe-4d3",
                                "Type: Agent | Status: completed | Tool uses: 20 | 63.1k token | Context: 11% | Duration: 57.0s",
                                "… +10 lines (ctrl+u to expand)",
                                "- Confirmed `/home/zigai/Projects/config` has no modifications.",
                            ].join("\n"),
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(120);

        const rendered = lines.join("\n");
        expect(rendered).toContain("completed · Agent · 0811c123-dcbe-4d3");
        expect(rendered).toContain("20 tools · 63.1k tok · context 11% · 57.0s");
        expect(rendered).toContain("Confirmed `/home/zigai/Projects/config` has no modifications.");
        expect(rendered).not.toContain("Type: Agent | Status");
    });

    it("summarizes completed subagent results from large output", () => {
        const renderer = createThirdPartyToolRenderer("get_subagent_result");
        const output = [
            ...Array.from({ length: 2_000 }, (_value, index) => `noise ${index}`),
            "Agent: 0811c123-dcbe-4d3",
            "Type: Agent | Status: completed | Tool uses: 20 | 63.1k token | Context: 11% | Duration: 57.0s",
            "- First useful note",
            "- Second useful note",
            "- Third useful note",
            "- Fourth useful note",
            "- Fifth hidden note",
        ].join("\n");

        const rendered = renderer
            .renderResult(
                { content: [{ type: "text", text: output }] },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(120)
            .join("\n");

        expect(rendered).toContain("completed · Agent · 0811c123-dcbe-4d3");
        expect(rendered).toContain("First useful note");
        expect(rendered).toContain("Fourth useful note");
        expect(rendered).not.toContain("Fifth hidden note");
        expect(rendered).not.toContain("noise 1999");
    });

    it("summarizes background subagent launch results", () => {
        const renderer = createThirdPartyToolRenderer("Agent");

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: [
                                "Agent started in background.",
                                "Agent ID: 0811c123-dcbe-4d3",
                                "Do not duplicate this agent's work.",
                            ].join("\n"),
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("started in background · 0811c123-dcbe-4d3");
        expect(rendered).toContain("Do not duplicate this agent's work.");
        expect(rendered).not.toContain("Agent ID:");
    });

    it("summarizes goal results from structured details", () => {
        const renderer = createThirdPartyToolRenderer("pi__get_goal");

        const lines = renderer
            .renderResult(
                {
                    content: [{ type: "text", text: "noisy json" }],
                    details: {
                        goal: {
                            objective: "Ship the renderer patch",
                            status: "active",
                            tokensUsed: 1200,
                            timeUsedSeconds: 90,
                        },
                    },
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        expect(lines.join("\n")).toContain("active: Ship the renderer patch");
        expect(lines.join("\n")).toContain("1,200 tok");
        expect(lines.join("\n")).not.toContain("noisy json");
    });

    it("renders finalized plans without duplicating markdown arguments", () => {
        const renderer = createThirdPartyToolRenderer("finalize_plan");

        const lines = renderer
            .renderCall(
                { markdown: "# Refactor Plan\n\n## Summary\nLong plan text" },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("Plan Finalized");
        expect(rendered).not.toContain("Refactor Plan");
        expect(rendered).not.toContain("markdown");
        expect(rendered).not.toContain("expand");
    });

    it("hides successful finalized plan results", () => {
        const renderer = createThirdPartyToolRenderer("finalize_plan");

        const lines = renderer
            .renderResult(
                { content: [{ type: "text", text: "Plan rendered in the plan UI" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        expect(lines).toEqual([]);
    });

    it("renders ask_user_question calls as readable choices instead of JSON", () => {
        const renderer = createThirdPartyToolRenderer("ask_user_question");

        const lines = renderer
            .renderCall(
                {
                    questions: [
                        {
                            header: "Candidates",
                            question:
                                "Which items should `/loti review` consider eligible for promotion into durable memory?",
                            options: [
                                {
                                    label: "Stable durable only (Recommended)",
                                    description: "Only promote candidates already marked stable.",
                                },
                                {
                                    label: "Stable and pending",
                                    description: "Include pending candidates in the review.",
                                },
                            ],
                        },
                    ],
                },
                plainTheme,
                renderContext,
            )
            .render(120);

        const rendered = lines.join("\n");
        expect(rendered).toContain("Asked User");
        expect(stripAccentStyle(rendered)).toContain("Candidates");
        expect(compactRenderedText(stripAccentStyle(rendered))).toContain(
            "Which items should `/loti review` consider eligible for promotion into durable memory?",
        );
        expect(rendered).toContain("Choose one:");
        expect(rendered).toContain("Stable durable only (Recommended)");
        expect(rendered).not.toContain('"questions"');
        expect(rendered).not.toContain('"description"');
    });

    it("renders ask_user_question answers without the boilerplate result sentence", () => {
        const renderer = createThirdPartyToolRenderer("ask_user_question");
        const args = {
            questions: [
                {
                    header: "Candidates",
                    question:
                        "Which items should `/loti review` consider eligible for promotion into durable memory?",
                    options: [
                        {
                            label: "Stable durable only (Recommended)",
                            description: "Only promote candidates already marked stable.",
                        },
                    ],
                },
            ],
        };

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: 'User has answered your questions: "Which items should `/loti review` consider eligible for promotion into durable memory?"="Stable durable only (Recommended)". You can now continue with the user\'s answers in mind.',
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args },
            )
            .render(120);

        const rendered = lines.join("\n");
        expect(stripAccentStyle(rendered)).toContain("Candidates → Stable durable only");
        expect(stripAccentStyle(rendered)).toContain(
            "Which items should `/loti review` consider eligible for promotion into durable memory?",
        );
        expect(rendered).not.toContain("User has answered your questions");
        expect(rendered).not.toContain("You can now continue");
    });

    it("labels view_image detail mode", () => {
        const renderer = createThirdPartyToolRenderer("view_image");

        const lines = renderer
            .renderCall(
                { path: "~/Projects/theme/preview.png", detail: "high" },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        const visible = stripAccentStyle(rendered);
        expect(visible).toContain("View Image");
        expect(visible).toContain("~/Projects/theme/preview.png");
        expect(visible).toContain("~/Projects/theme/preview.png · detail: high");
        expect(rendered).not.toContain(" • high");
        expect(rendered).not.toContain(" • detail: high");
    });

    it("hides successful view_image attachment text results", () => {
        const renderer = createThirdPartyToolRenderer("view_image");

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: "[view_image image attached: /tmp/preview.png]",
                        },
                    ],
                },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args: { path: "/tmp/preview.png" } },
            )
            .render(100);

        expect(lines).toEqual([]);
    });

    it("keeps failed view_image result text visible", () => {
        const renderer = createThirdPartyToolRenderer("view_image");

        const rendered = renderer
            .renderResult(
                { content: [{ type: "text", text: "Failed to load image" }] },
                { expanded: false, isPartial: false },
                plainTheme,
                { ...renderContext, args: { path: "/tmp/missing.png" }, isError: true },
            )
            .render(100)
            .join("\n");

        expect(rendered).toContain("Failed to load image");
    });

    it("summarizes pi-codex-core web_run search calls without repeating search", () => {
        const renderer = createThirdPartyToolRenderer("web_run");

        const lines = renderer
            .renderCall({ search_query: [{ q: "latest pi docs" }] }, plainTheme, renderContext)
            .render(100);

        expect(lines[0]).toContain("Web Search");
        expect(lines.join("\n")).toContain('Web Search "latest pi docs"');
        expect(lines.join("\n")).not.toContain("Web Search search");
    });

    it("highlights web_run urls in call summaries", () => {
        const renderer = createThirdPartyToolRenderer("web_run");

        const rendered = renderer
            .renderCall(
                {
                    open: [
                        { ref_id: "https://api.github.com/repos/yohamta/donburi" },
                        { ref_id: "https://example.com/second" },
                    ],
                },
                plainTheme,
                renderContext,
            )
            .render(120)
            .join("\n");

        expect(stripAccentStyle(rendered)).toContain(
            'Web Search open "https://api.github.com/repos/yohamta/donburi" +1',
        );
        expect(rendered).toContain("<accent>https://api.github.com/repos/yohamta/donburi</accent>");
    });

    it("renders dense web_run result summaries from inline output", () => {
        const renderer = createThirdPartyToolRenderer("web_run");
        const output = [
            "API References | Shiki (https://shiki.style/api)",
            'citeturn6view0 [wordlim: 200] Content type: text/html; Source: open({"ref_id":"https://shiki.style/api","lineno":null}); Total lines: 306',
            "L0: Skip to content",
            "L198: # API References",
            "L199: ## `codeToHast`",
            "L201: You can also get the intermediate `hast` to do custom rendering without serializing them into HTML.",
        ].join("\n");

        const lines = renderer
            .renderResult(
                {
                    content: [{ type: "text", text: output }],
                    details: { sourceCount: 3, fullOutputPath: "/tmp/web-run.txt" },
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(120);
        const rendered = lines.join("\n");
        const visible = stripAccentStyle(rendered);

        expect(visible).toContain("3 sources");
        expect(visible).toContain("API References | Shiki — shiki.style/api");
        expect(rendered).toContain("<accent>shiki.style/api</accent>");
        expect(visible).toContain("… +2 sources");
        expect(visible).not.toContain("│ API References");
        expect(visible).not.toContain("codeToHast");
        expect(visible).not.toContain("/tmp/web-run.txt");
    });

    it("collapses web_run source lists after four sources", () => {
        const renderer = createThirdPartyToolRenderer("web_run");
        const output = [
            "Ripgrep Benchmarks (https://ripgrep.dev/benchmarks)",
            "Ripgrep Repository (https://github.com/BurntSushi/ripgrep)",
            "Rust Regex (https://docs.rs/regex/latest/regex)",
            "Grep Crate (https://docs.rs/grep/latest/grep)",
            "Ripgrep Crate (https://crates.io/crates/ripgrep)",
            "GNU Grep (https://www.gnu.org/software/grep/)",
        ].join("\n");

        const collapsed = renderer
            .renderResult(
                { content: [{ type: "text", text: output }], details: { sourceCount: 6 } },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100)
            .join("\n");
        const expanded = renderer
            .renderResult(
                { content: [{ type: "text", text: output }], details: { sourceCount: 6 } },
                { expanded: true, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100)
            .join("\n");

        const visibleCollapsed = stripAccentStyle(collapsed);
        const visibleExpanded = stripAccentStyle(expanded);

        expect(visibleCollapsed).toContain("6 sources");
        expect(visibleCollapsed).toContain("Grep Crate — docs.rs/grep/latest/grep");
        expect(collapsed).toContain("<accent>docs.rs/grep/latest/grep</accent>");
        expect(visibleCollapsed).toContain("… +2 sources");
        expect(visibleCollapsed).not.toContain("Ripgrep Crate — crates.io/crates/ripgrep");
        expect(visibleCollapsed).not.toContain("│ Grep Crate");
        expect(visibleExpanded).toContain("Ripgrep Crate — crates.io/crates/ripgrep");
        expect(visibleExpanded).toContain("GNU Grep — gnu.org/software/grep");
        expect(visibleExpanded).not.toContain("… +2 sources");
    });

    it("summarizes large web_run output without dumping the body", () => {
        const renderer = createThirdPartyToolRenderer("web_run");
        const output = [
            ...Array.from({ length: 2_000 }, (_value, index) => `L${index}: menu`),
            "Pi Documentation (https://pi.example/docs)",
            "L2001: # Important Result",
            "L2002: This paragraph is intentionally useful and long enough to be selected as a highlight for the compact summary.",
        ].join("\n");

        const rendered = renderer
            .renderResult(
                { content: [{ type: "text", text: output }], details: { sourceCount: 1 } },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(120)
            .join("\n");

        expect(stripAccentStyle(rendered)).toContain("1 source");
        expect(stripAccentStyle(rendered)).toContain("Pi Documentation — pi.example/docs");
        expect(stripAccentStyle(rendered)).not.toContain("Important Result");
        expect(stripAccentStyle(rendered)).not.toContain("L1999");
    });

    it("bounds web_run source and highlight tracking for huge outputs", () => {
        const renderer = createThirdPartyToolRenderer("web_run");
        const output = Array.from(
            { length: 1_000 },
            (_value, index) =>
                `Unique Source ${index + 1} (https://example.com/source-${index + 1})\nL${index + 1}: # Unique Highlight ${index + 1}`,
        ).join("\n");

        const rendered = renderer
            .renderResult(
                { content: [{ type: "text", text: output }], details: { sourceCount: 1_000 } },
                { expanded: true, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(120)
            .join("\n");
        const visible = stripAccentStyle(rendered);

        expect(visible).toContain("1000 sources");
        expect(visible).toContain("Unique Source 100 — example.com/source-100");
        expect(visible).toContain("… +900 sources");
        expect(visible).not.toContain("Unique Source 101 — example.com/source-101");
        expect(visible).not.toContain("Unique Highlight 500");
    });

    it("renders numeric-only web_run source titles as urls", () => {
        const renderer = createThirdPartyToolRenderer("web_run");

        const lines = renderer
            .renderResult(
                {
                    content: [
                        {
                            type: "text",
                            text: "4. (https://winget.ragerworks.com/package/BurntSushi.ripgrep.GNU)",
                        },
                    ],
                    details: { sourceCount: 6 },
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("6 sources");
        expect(rendered).toContain("winget.ragerworks.com/package/BurntSushi.ripgrep.GNU");
        expect(rendered).toContain("… +5 sources");
        expect(rendered).not.toContain("4. —");
    });

    it("falls back to source count without rendering web_run dump paths", () => {
        const renderer = createThirdPartyToolRenderer("web_run");

        const lines = renderer
            .renderResult(
                {
                    details: { sourceCount: 2, fullOutputPath: "/tmp/missing-web-run.txt" },
                },
                { expanded: false, isPartial: false },
                plainTheme,
                renderContext,
            )
            .render(100);

        const rendered = lines.join("\n");
        expect(rendered).toContain("2 sources");
        expect(rendered).not.toContain("/tmp/missing-web-run.txt");
    });

    it("parses env opt-out tool names", () => {
        expect(parsePreservedThirdPartyToolNames("mcp, rich_tool ,, web_run ")).toEqual([
            "mcp",
            "rich_tool",
            "web_run",
        ]);
    });

    it("preserves tools by matcher or explicit tool preference", () => {
        expect(
            shouldPreserveThirdPartyToolRenderer({
                toolName: "rich_tool",
                toolDefinition: {},
                renderingOptions: { preserveTools: ["rich_tool"] },
            }),
        ).toBe(true);

        expect(
            shouldPreserveThirdPartyToolRenderer({
                toolName: "another_tool",
                toolDefinition: { [CODEX_LOOK_RENDERING_PROPERTY]: "preserve" },
            }),
        ).toBe(true);
    });
});
