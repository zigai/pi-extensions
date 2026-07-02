import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { buildPierreDiffPayload, createWriteSnapshot } from "../src/pierre-diff.ts";
import { renderPierreDiff } from "../src/pierre-diff-renderer.ts";
import { loadHighlightedDiff } from "../src/pierre-highlight.ts";
import {
  highlightShell,
  parseDiffSections,
  renderCodexDiff,
  renderCodexOutput,
  renderScriptCall,
  type CodexRenderTheme,
} from "../src/rendering.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-renderers.ts";
import { highlightSyntaxCode, initializeSyntaxHighlighting } from "../src/syntax/highlighter.ts";
import { installMarkdownSyntaxPatch } from "../src/syntax/markdown-patch.ts";
import { loadSyntaxConfig } from "../src/syntax/theme-loader.ts";

const ANSI_ESCAPE = "\u001b[";
const TYPESCRIPT_KEYWORD_RGB_CODE = "38;2;86;156;214";
const TYPESCRIPT_KEYWORD_COLOR = `\u001b[${TYPESCRIPT_KEYWORD_RGB_CODE}m`;
const BRACKET_PAIR_1_RGB_CODE = "38;2;255;215;0";
const BRACKET_PAIR_2_RGB_CODE = "38;2;218;112;214";
const STRING_RGB_CODE = "38;2;206;145;120";
const TYPE_RGB_CODE = "38;2;78;201;176";
const VARIABLE_RGB_CODE = "38;2;156;220;254";
const FUNCTION_RGB_CODE = "38;2;220;220;170";

type ThemeBackgroundColors = ConstructorParameters<typeof Theme>[1];

const piTheme = new Theme(
  {
    toolDiffContext: "#d4d4d4",
    toolDiffAdded: "#89d185",
    toolDiffRemoved: "#f48771",
    dim: "#777777",
    muted: "#999999",
    toolTitle: "#ffffff",
    accent: "#4fc1ff",
    customMessageLabel: "#c586c0",
    syntaxFunction: "#dcdcaa",
    syntaxOperator: "#d4d4d4",
    syntaxString: "#ce9178",
    toolOutput: "#d4d4d4",
    success: "#89d185",
  } as Record<ThemeColor, string>,
  {
    toolSuccessBg: "#123012",
    toolErrorBg: "#301212",
  } as ThemeBackgroundColors,
  "truecolor",
  { name: "zigai-dark-test" },
);

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

const markdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

const renderContext = {
  args: {},
  toolCallId: "call-1",
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: true,
  showImages: true,
  isError: false,
};

describe("central syntax highlighting", () => {
  beforeAll(async () => {
    await initializeSyntaxHighlighting();
  });

  it("loads syntax env config including default, custom, black variant, and off switch", () => {
    expect(loadSyntaxConfig()).toEqual({
      enabled: true,
      themeName: "pi-codex-look-darker-modern",
      themePath: "/home/zigai/Projects/vscode-darker-plus/themes/darker-modern-theme.json",
    });
    expect(loadSyntaxConfig({ PI_CODEX_LOOK_SYNTAX_THEME: "/tmp/theme.json" })).toEqual({
      enabled: true,
      themeName: "pi-codex-look-darker-modern",
      themePath: "/tmp/theme.json",
    });
    expect(loadSyntaxConfig({ PI_CODEX_LOOK_SYNTAX_THEME_VARIANT: "black" })).toEqual({
      enabled: true,
      themeName: "pi-codex-look-darker-modern",
      themePath: "/home/zigai/Projects/vscode-darker-plus/themes/darker-modern-black-theme.json",
    });
    expect(loadSyntaxConfig({ PI_CODEX_LOOK_SYNTAX: "off" })).toEqual({
      enabled: false,
      reason: "PI_CODEX_LOOK_SYNTAX=off",
    });
  });

  it("highlights TypeScript with the VS Code theme colors", () => {
    const lines = highlightSyntaxCode('const value = "ok";', "typescript");

    expect(lines.join("\n")).toContain(TYPESCRIPT_KEYWORD_COLOR);
    expect(lines.join("\n")).toContain("const");
  });

  it("colors Python import identifiers like VS Code semantic highlighting", () => {
    const rendered = highlightSyntaxCode(
      "import sys\nfrom collections.abc import Callable",
      "python",
    ).join("\n");

    expect(rendered).toContain(`${TYPE_RGB_CODE}msys`);
    expect(rendered).toContain(`${TYPE_RGB_CODE}mcollections.abc`);
    expect(rendered).toContain(`${TYPE_RGB_CODE}mCallable`);
  });

  it("colors Python neutral identifiers as variables, constants, and calls", () => {
    const rendered = highlightSyntaxCode(
      "if IGNORE_BREAKS:\n    handler(line)\n    value = get_terminal_size().columns",
      "python",
    ).join("\n");

    expect(rendered).toContain(`${TYPE_RGB_CODE}mIGNORE_BREAKS`);
    expect(rendered).toContain(`${FUNCTION_RGB_CODE}mhandler`);
    expect(rendered).toContain(`${VARIABLE_RGB_CODE}mline`);
    expect(rendered).toContain(`${VARIABLE_RGB_CODE}mvalue`);
    expect(rendered).toContain(`${FUNCTION_RGB_CODE}mget_terminal_size`);
  });

  it("adds VS Code bracket pair colors without recoloring strings", () => {
    const rendered = highlightSyntaxCode(
      'const value = make([]Item, "(text)");',
      "typescript",
    ).join("\n");

    expect(rendered).toContain(BRACKET_PAIR_1_RGB_CODE);
    expect(rendered).toContain(BRACKET_PAIR_2_RGB_CODE);
    expect(rendered).toContain(`${STRING_RGB_CODE}m"(text)"`);
  });

  it("falls back to plain lines for unknown languages", () => {
    expect(highlightSyntaxCode("hello\nworld", "not-a-real-language")).toEqual(["hello", "world"]);
  });

  it("injects the central highlighter into Markdown code fences", () => {
    installMarkdownSyntaxPatch();
    const rendered = new Markdown("```ts\nconst value = 1;\n```", 0, 0, markdownTheme)
      .render(100)
      .join("\n");

    expect(rendered).toContain(TYPESCRIPT_KEYWORD_COLOR);
    expect(rendered).toContain("const");
  });

  it("leaves thinking Markdown code fences without syntax colors", () => {
    installMarkdownSyntaxPatch();
    const rendered = new Markdown("```ts\nconst value = 1;\n```", 0, 0, markdownTheme, {
      color: (text) => text,
      italic: true,
    })
      .render(100)
      .join("\n");

    expect(rendered).not.toContain(TYPESCRIPT_KEYWORD_RGB_CODE);
    expect(rendered).toContain("const value = 1;");
  });

  it("highlights bash command and executable script previews", () => {
    expect(highlightShell(plainTheme, "npm run check")).toContain(ANSI_ESCAPE);

    const rendered = renderScriptCall(
      plainTheme,
      { label: "Node", language: "javascript", code: "const value = 1;" },
      { state: "success", expanded: false },
    )
      .render(100)
      .join("\n");

    expect(rendered).toContain(ANSI_ESCAPE);
    expect(rendered).toContain("const");
  });

  it("highlights code output previews when a path is known", () => {
    const rendered = renderCodexOutput(plainTheme, "const value = 1;", {
      expanded: false,
      syntax: { path: "src/example.ts" },
    })
      .render(100)
      .join("\n");

    expect(rendered).toContain(TYPESCRIPT_KEYWORD_COLOR);
    expect(rendered).toContain("const");
  });

  it("highlights third-party JSON fallback previews", () => {
    const renderer = createThirdPartyToolRenderer("custom_tool");
    const rendered = renderer
      .renderResult(
        { content: [{ type: "text", text: '{"ok": true}' }] },
        { expanded: false, isPartial: false },
        plainTheme,
        { ...renderContext, expanded: false },
      )
      .render(100)
      .join("\n");

    expect(rendered).toContain(ANSI_ESCAPE);
    expect(rendered).toContain("ok");
  });

  it("highlights fallback diff previews when a path is known", () => {
    const rendered = renderCodexDiff(
      plainTheme,
      parseDiffSections(
        " 7 import pytest\n+9 def test_value():\n-9 def old_value():",
        "tests/example.py",
      ),
      false,
    )
      .render(120)
      .join("\n");

    expect(rendered).toContain("def");
    expect(rendered).toContain("38;2");
  });

  it("uses the same VS Code theme for Pierre diff highlighting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-codex-look-syntax-"));
    const filePath = join(directory, "example.ts");
    writeFileSync(filePath, "const value = call(1);\n");

    try {
      const snapshot = await createWriteSnapshot(
        directory,
        "example.ts",
        "const value = call(2);\n",
      );
      const payload = buildPierreDiffPayload(snapshot);
      expect(payload).toBeDefined();
      if (!payload) {
        throw new Error("expected Pierre diff payload");
      }

      const highlighted = await loadHighlightedDiff(payload.metadata);
      const serialized = JSON.stringify(highlighted.dark.deletionLines);

      expect(serialized).toContain("#569CD6");
      expect(serialized).toContain("const");

      const component = renderPierreDiff(
        payload,
        piTheme,
        { expanded: false },
        {
          lastComponent: undefined,
          invalidate() {},
        },
      );
      component.render(120);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const rendered = component.render(120).join("\n");

      expect(rendered).toContain(TYPESCRIPT_KEYWORD_RGB_CODE);
      expect(rendered).toContain(BRACKET_PAIR_1_RGB_CODE);
      expect(rendered).not.toContain(" │ ");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
