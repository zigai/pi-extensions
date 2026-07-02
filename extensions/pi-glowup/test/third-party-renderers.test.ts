import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexRenderTheme } from "../src/rendering.ts";
import {
  CODEX_LOOK_RENDERING_PROPERTY,
  createThirdPartyToolRenderer,
  parsePreservedThirdPartyToolNames,
  shouldPreserveThirdPartyToolRenderer,
} from "../src/third-party-renderers.ts";

const plainTheme: CodexRenderTheme = {
  fg(_token: string, text: string): string {
    return text;
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

describe("third-party tool renderers", () => {
  it("renders unknown tools as compact Codex-style calls", () => {
    const renderer = createThirdPartyToolRenderer("custom_tool");

    const lines = renderer
      .renderCall({ action: "run", value: 42 }, plainTheme, renderContext)
      .render(80);

    expect(lines.join("\n")).toContain("• Called custom_tool");
    expect(lines.join("\n")).toContain('"action": "run"');
  });

  it("expands long third-party tool call arguments", () => {
    const renderer = createThirdPartyToolRenderer("custom_tool");
    const args = { lines: Array.from({ length: 10 }, (_value, index) => `line ${index + 1}`) };

    const collapsed = renderer.renderCall(args, plainTheme, renderContext).render(80).join("\n");
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

  it("uses Chrome DevTools labels for MCP gateway calls", () => {
    const renderer = createThirdPartyToolRenderer("mcp");

    const lines = renderer
      .renderCall({ tool: "take_snapshot", args: '{"verbose":true}' }, plainTheme, renderContext)
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
              text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
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
    expect(rendered).toContain("View Image");
    expect(rendered).toContain("~/Projects/theme/preview.png");
    expect(rendered).toContain("~/Projects/theme/preview.png · detail: high");
    expect(rendered).not.toContain(" • high");
    expect(rendered).not.toContain(" • detail: high");
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

  it("renders dense web_run result summaries from saved output", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-codex-look-web-run-"));
    const outputPath = join(directory, "web-run.txt");
    writeFileSync(
      outputPath,
      [
        "API References | Shiki (https://shiki.style/api)",
        'citeturn6view0 [wordlim: 200] Content type: text/html; Source: open({"ref_id":"https://shiki.style/api","lineno":null}); Total lines: 306',
        "L0: Skip to content",
        "L198: # API References",
        "L199: ## `codeToHast`",
        "L201: You can also get the intermediate `hast` to do custom rendering without serializing them into HTML.",
      ].join("\n"),
    );

    try {
      const renderer = createThirdPartyToolRenderer("web_run");
      const lines = renderer
        .renderResult(
          {
            content: [{ type: "text", text: `3 sources →\n${outputPath}` }],
            details: { sourceCount: 3, fullOutputPath: outputPath },
          },
          { expanded: false, isPartial: false },
          plainTheme,
          renderContext,
        )
        .render(120);
      const rendered = lines.join("\n");

      expect(rendered).toContain("3 sources");
      expect(rendered).toContain("API References | Shiki — shiki.style/api");
      expect(rendered).toContain("… +2 sources");
      expect(rendered).not.toContain("│ API References");
      expect(rendered).not.toContain("codeToHast");
      expect(rendered).not.toContain(outputPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

    expect(collapsed).toContain("6 sources");
    expect(collapsed).toContain("Grep Crate — docs.rs/grep/latest/grep");
    expect(collapsed).toContain("… +2 sources");
    expect(collapsed).not.toContain("Ripgrep Crate — crates.io/crates/ripgrep");
    expect(collapsed).not.toContain("│ Grep Crate");
    expect(expanded).toContain("Ripgrep Crate — crates.io/crates/ripgrep");
    expect(expanded).toContain("GNU Grep — gnu.org/software/grep");
    expect(expanded).not.toContain("… +2 sources");
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
