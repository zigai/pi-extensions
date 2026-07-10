import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { buildPierreDiffPayload, createWriteSnapshot } from "../src/diffs/diff.ts";
import { renderPierreDiff } from "../src/diffs/renderer.ts";
import { loadHighlightedDiff } from "../src/diffs/highlight.ts";
import {
    highlightShell,
    parseDiffSections,
    renderCodexDiff,
    renderCodexOutput,
    renderScriptCall,
    type CodexRenderTheme,
} from "../src/rendering/core.ts";
import { renderWriteCallPreview } from "../src/rendering/write-rendering.ts";
import { createThirdPartyToolRenderer } from "../src/third-party-tools/renderers.ts";
import {
    disposeSyntaxHighlighting,
    highlightSyntaxCode,
    initializeSyntaxHighlighting,
} from "../src/syntax/highlighter.ts";
import { normalizeSyntaxLanguage, PRELOADED_SYNTAX_LANGUAGES } from "../src/syntax/language.ts";
import { installMarkdownSyntaxPatch } from "../src/syntax/markdown-patch.ts";
import { SYNTAX_ACCENT_COLORS } from "../src/syntax/palette.ts";
import { loadSyntaxConfig } from "../src/syntax/theme-loader.ts";

const ANSI_ESCAPE = "\u001b[";
const TYPESCRIPT_KEYWORD_RGB_CODE = "38;2;86;156;214";
const TYPESCRIPT_KEYWORD_COLOR = `\u001b[${TYPESCRIPT_KEYWORD_RGB_CODE}m`;
const STRING_RGB_CODE = "38;2;206;145;120";
const TOML_INVALID_RGB_CODE = "38;2;244;71;71";
const TYPE_RGB_CODE = ansiRgbCode(SYNTAX_ACCENT_COLORS.pythonImportIdentifier);
const VARIABLE_RGB_CODE = ansiRgbCode(SYNTAX_ACCENT_COLORS.pythonVariableIdentifier);
const FUNCTION_RGB_CODE = ansiRgbCode(SYNTAX_ACCENT_COLORS.pythonFunctionIdentifier);
const BRACKET_PAIR_1_RGB_CODE = ansiRgbCode(SYNTAX_ACCENT_COLORS.bracketPair[0]);
const BRACKET_PAIR_2_RGB_CODE = ansiRgbCode(SYNTAX_ACCENT_COLORS.bracketPair[1]);

function ansiRgbCode(hex: string): string {
    return `38;2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}`;
}

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
        syntaxKeyword: "#569cd6",
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
const bundledThemePath = join(process.cwd(), "themes", "darker-modern-theme.json");

describe("central syntax highlighting", () => {
    beforeAll(async () => {
        await disposeSyntaxHighlighting();
        await initializeSyntaxHighlighting(process.env, {
            preloadLanguages: [
                "markdown",
                "bash",
                "python",
                "toml",
                "typescript",
                "javascript",
                "json",
            ],
        });
    });

    afterAll(async () => {
        await disposeSyntaxHighlighting();
    });

    it("loads syntax env config including default, custom override, and off switch", () => {
        expect(loadSyntaxConfig()).toEqual({
            enabled: true,
            themeName: "pi-codex-look-darker-modern",
            themePath: bundledThemePath,
        });
        expect(loadSyntaxConfig({ PI_CODEX_LOOK_SYNTAX_THEME: "/tmp/theme.json" })).toEqual({
            enabled: true,
            themeName: "pi-codex-look-darker-modern",
            themePath: "/tmp/theme.json",
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

    it("highlights accepted one-line scripts longer than 1000 characters", () => {
        const code = `const values = [${Array.from({ length: 140 }, (_value, index) => `"value-${index}"`).join(",")}];`;

        expect(code.length).toBeGreaterThan(1_000);
        expect(code.length).toBeLessThanOrEqual(2_000);
        expect(highlightSyntaxCode(code, "javascript").join("\n")).toContain(
            TYPESCRIPT_KEYWORD_COLOR,
        );
    });

    it("does not reset surrounding backgrounds after highlighted lines", () => {
        const rendered = highlightSyntaxCode('const value = "ok";', "typescript").join("\n");

        expect(rendered).not.toContain("\u001b[0m");
        expect(rendered).not.toContain("\u001b[49m");
        expect(rendered).not.toContain("\u001b[48;");
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
        expect(highlightSyntaxCode("hello\nworld", "not-a-real-language")).toEqual([
            "hello",
            "world",
        ]);
    });

    it("normalizes Rust and Go language aliases and keeps a small default preload set", () => {
        expect(normalizeSyntaxLanguage("rust")).toBe("rust");
        expect(normalizeSyntaxLanguage("rs")).toBe("rust");
        expect(normalizeSyntaxLanguage("go")).toBe("go");
        expect(normalizeSyntaxLanguage("golang")).toBe("go");
        expect(PRELOADED_SYNTAX_LANGUAGES).toEqual(["markdown", "bash", "python", "typescript"]);
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

    it("keeps unquoted bash operands out of string color", () => {
        const rendered = renderScriptCall(
            piTheme,
            {
                label: "Bash",
                language: "bash",
                code: [
                    "python3 packages.py validate --os fedora && rsync -az Packages/manifests/vps.toml vps.01:~/Projects/config/Packages/manifests/vps.toml",
                    "sudo dnf install -y duf",
                ].join("\n"),
            },
            { state: "success", expanded: true },
        )
            .render(240)
            .join("\n");

        expect(rendered).toContain(ANSI_ESCAPE);
        expect(rendered).toContain("packages.py");
        expect(rendered).toContain("Packages/manifests/vps.toml");
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mpackages.py`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mfedora`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mPackages/manifests/vps.toml`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mvalidate`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}minstall`);
    });

    it("preserves multiline TypeScript comment highlighting in script previews", () => {
        const code = [
            "/**",
            " * Expands the collapsed paste marker currently under the editor cursor.",
            " */",
            "export function expandPasteMarkerAtCursor(): boolean {",
            "    return true;",
            "}",
        ].join("\n");
        const expectedCommentLine = highlightSyntaxCode(code, "typescript")[1];
        const renderedCommentLine = renderScriptCall(
            plainTheme,
            { label: "TypeScript", language: "typescript", code },
            { state: "success", expanded: false },
        )
            .render(160)
            .find((line) => line.includes("Expands the collapsed"));

        expect(expectedCommentLine).toBeDefined();
        expect(renderedCommentLine).toContain(expectedCommentLine);
    });

    it("preserves multiline TypeScript highlighting inside bash heredocs", () => {
        const code = [
            "/**",
            " * Expands the collapsed paste marker currently under the editor cursor.",
            " */",
            "const value: { readonly ok: boolean } = { ok: true };",
        ].join("\n");
        const command = [
            "pkg=/tmp/node_modules",
            "NODE_PATH=\"$pkg:./node_modules\" tsx - <<'TS'",
            code,
            "TS",
        ].join("\n");
        const expectedCommentLine = highlightSyntaxCode(code, "typescript")[1];
        const rendered = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        ).render(180);
        const renderedCommentLine = rendered.find((line) => line.includes("Expands the collapsed"));

        expect(rendered[0]).toContain("Bash");
        expect(expectedCommentLine).toBeDefined();
        expect(renderedCommentLine).toContain(expectedCommentLine);
    });

    it("highlights embedded Python heredocs inside bash previews as Python", () => {
        const command = [
            'for f in /tmp/*.json; do [ -f "$f" ] || continue;',
            "printf '%s: ' \"$f\"; python3 - <<'PY' \"$f\"",
            "import json, sys",
            "path = sys.argv[1]",
            "print(json.load(open(path)).get('$schema'))",
            "PY",
            "done",
        ].join("\n");

        const rendered = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        )
            .render(160)
            .join("\n");

        expect(rendered).toContain(`${TYPE_RGB_CODE}mjson`);
        expect(rendered).toContain(`${TYPE_RGB_CODE}msys`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mimport json, sys`);
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

    it("preserves multiline TypeScript comment highlighting in code output previews", () => {
        const code = [
            "/**",
            " * Expands the collapsed paste marker currently under the editor cursor.",
            " */",
            "export function expandPasteMarkerAtCursor(): boolean {",
            "    return true;",
            "}",
        ].join("\n");
        const expectedCommentLine = highlightSyntaxCode(code, "typescript")[1];
        const renderedCommentLine = renderCodexOutput(plainTheme, code, {
            expanded: false,
            maxPreviewLines: 8,
            syntax: { path: "src/example.ts" },
        })
            .render(160)
            .find((line) => line.includes("Expands the collapsed"));

        expect(expectedCommentLine).toBeDefined();
        expect(renderedCommentLine).toContain(expectedCommentLine);
    });

    it("highlights partial write previews while streaming", () => {
        const rendered = renderWriteCallPreview(
            { path: "src/example.ts", content: "const value = 1;\n" },
            plainTheme,
            { isError: false, isPartial: true, expanded: false },
        )
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

    it("uses surrounding TOML diff context for inline table braces", () => {
        const rendered = renderCodexDiff(
            plainTheme,
            parseDiffSections(
                [
                    " 1 [[package]]",
                    ' 2 name = "bat"',
                    " 3 targets = [",
                    ' 4     { os = "arch", id = "bat", pm = "pacman" },',
                    " 5 ]",
                ].join("\n"),
                "Packages/manifests/vps.toml",
            ),
            true,
        )
            .render(180)
            .join("\n");

        expect(rendered).toContain(BRACKET_PAIR_2_RGB_CODE);
        expect(rendered).not.toContain(TOML_INVALID_RGB_CODE);
    });

    it("does not highlight TOML after diff ellipses as invalid", () => {
        const rendered = renderCodexDiff(
            plainTheme,
            parseDiffSections(
                [
                    " 1 [[package]]",
                    ' 2 name = "libedit-dev"',
                    " 3 targets = [",
                    ' 4     { os = "arch", id = "libedit", pm = "pacman" },',
                    ' 5     { os = "fedora", id = "libedit-devel", pm = "dnf" },',
                    "   ...",
                    " 6 tags = [",
                    ' 7     "core",',
                    " 8 ]",
                    "+9 ",
                    "+10 [[package]]",
                    '+11 name = "perl-FindBin"',
                    "+12 targets = [",
                    '+13     { os = "fedora", id = "perl-FindBin", pm = "dnf" },',
                    "+14 ]",
                    "+15 tags = [",
                    '+16     "core",',
                    "+17 ]",
                ].join("\n"),
                "Packages/manifests/vps.toml",
            ),
            false,
        )
            .render(180)
            .join("\n");

        expect(rendered).toContain(BRACKET_PAIR_2_RGB_CODE);
        expect(rendered).not.toContain(TOML_INVALID_RGB_CODE);
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
            if (payload?.kind !== "renderable") {
                throw new Error("expected renderable Pierre diff payload");
            }

            const highlighted = await loadHighlightedDiff(payload.metadata);
            const serialized = JSON.stringify(highlighted.dark.deletionLines);

            expect(serialized).toContain("#569CD6");
            expect(serialized).toContain("const");

            const component = renderPierreDiff(
                payload,
                piTheme,
                { expanded: true },
                {
                    lastComponent: undefined,
                    invalidate() {},
                },
            );
            const rendered = component.render(120).join("\n");

            expect(rendered).toContain(TYPESCRIPT_KEYWORD_RGB_CODE);
            expect(rendered).toContain(BRACKET_PAIR_1_RGB_CODE);
            expect(rendered).not.toContain(" │ ");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
