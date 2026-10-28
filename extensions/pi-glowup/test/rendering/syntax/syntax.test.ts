import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Markdown, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createHash } from "node:crypto";
import { configureRenderDiagnostics } from "../../../src/diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../src/diagnostics/logger.ts";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { buildPierreDiffPayload } from "../../../src/rendering/diff/payload.ts";
import { renderPierreDiff } from "../../../src/rendering/diff/pierre-renderer.ts";
import { loadHighlightedDiff } from "../../../src/rendering/diff/highlight.ts";
import { configureRenderingAppearance } from "../../../src/rendering/theme.ts";
import { createPlainTheme } from "../../support/plain-theme.ts";
import { parseDiffSections } from "../../../src/rendering/diff/text-diff.ts";
import { renderGlowupDiff } from "../../../src/rendering/diff/text-renderer.ts";
import { renderGlowupOutput } from "../../../src/rendering/output.ts";
import { renderScriptCall } from "../../../src/tools/built-in/bash/script-renderer.ts";
import { createNativeBashFeature } from "../../../src/tools/built-in/bash/preview.ts";
import { renderWriteCallPreview } from "../../../src/tools/built-in/write-preview.ts";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../support/theme-colors.ts";
import { createThirdPartyToolRenderer } from "../../../src/tools/renderers.ts";
import { compactPresentation, outlinePresentation } from "../../../src/presentation.ts";
import { code, output } from "../../../src/tools/protocol/contract.ts";
import {
    disposeSyntaxHighlighting,
    configureSyntaxBracketPairColoring,
    highlightSyntaxCode,
    highlightSyntaxCodeAsync,
    settleSyntaxHighlights,
    initializeSyntaxHighlighting,
    loadSyntaxLanguageIfReady,
} from "../../../src/rendering/syntax/highlighter.ts";
import { normalizeSyntaxLanguage } from "../../../src/rendering/syntax/language.ts";
import { configureMarkdownSyntaxPatch } from "../../../src/pi/patches/markdown-syntax.ts";
import { SYNTAX_ACCENT_COLORS } from "../../../src/rendering/syntax/palette.ts";
import { loadSyntaxConfig } from "../../../src/rendering/syntax/theme-loader.ts";

function installMarkdownSyntaxPatch(): void {
    configureMarkdownSyntaxPatch(true);
}

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
const NEUTRAL_PUNCTUATION_RGB_CODE = ansiRgbCode(SYNTAX_ACCENT_COLORS.neutralForegrounds[1]);

function ansiRgbCode(hex: string): string {
    return `38;2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}`;
}

const piTheme = new Theme(
    {
        ...TEST_THEME_COLORS,
        text: "#d4d4d4",
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
        syntaxVariable: "#9cdcfe",
        toolOutput: "#d4d4d4",
        success: "#89d185",
        thinkingXhigh: "#777777",
    } satisfies Record<ThemeColor, string>,
    TEST_THEME_BACKGROUND_COLORS,
    "truecolor",
    { name: "sample-dark-test" },
);

const plainTheme = createPlainTheme();

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
    durationMs: undefined,
    outputPad: 1,
};
const bundledThemePath = join(process.cwd(), "themes", "darker-modern-theme.json");

async function renderReadyDiff(
    sections: Parameters<typeof renderGlowupDiff>[1],
    expanded: boolean,
    width: number,
): Promise<string> {
    const component = renderGlowupDiff(plainTheme, sections, expanded);
    component.render(width);
    await settleSyntaxHighlights();

    return component.render(width).join("\n");
}

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

    it("records each highlight outcome once per code and language without hiding failures", async () => {
        const events: { readonly event: string; readonly fields: DebugLogFields }[] = [];
        configureRenderDiagnostics((event, fields) => events.push({ event, fields: fields() }));
        onTestFinished(() => configureRenderDiagnostics(undefined));
        const source = "diagnostic_sample = 41 + 1";
        const aborted = new AbortController();
        aborted.abort();

        await highlightSyntaxCodeAsync(source, "python");
        highlightSyntaxCode(source, "python");
        highlightSyntaxCode(source, "python");
        highlightSyntaxCode(source, "not-a-language");
        highlightSyntaxCode(source, "not-a-language");
        await highlightSyntaxCodeAsync(source, "python", { signal: aborted.signal });

        const codeHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
        expect(
            events
                .filter((entry) => entry.event === "syntax_highlight")
                .map(({ fields }) => [fields.codeHash, fields.language, fields.outcome]),
        ).toEqual([
            [codeHash, "python", "highlighted"],
            [codeHash, "not-a-language", "unsupported-language"],
            [codeHash, "python", "cancelled"],
        ]);
    });

    it("loads syntax env config including default, custom override, and off switch", () => {
        expect(loadSyntaxConfig()).toEqual({
            enabled: true,
            themeName: "pi-glowup-darker-modern",
            themePath: bundledThemePath,
        });

        expect(loadSyntaxConfig({ PI_GLOWUP_SYNTAX_THEME: "/tmp/theme.json" })).toEqual({
            enabled: true,
            themeName: "pi-glowup-darker-modern",
            themePath: "/tmp/theme.json",
        });

        expect(loadSyntaxConfig({ PI_GLOWUP_SYNTAX: "off" })).toEqual({
            enabled: false,
            reason: "PI_GLOWUP_SYNTAX=off",
        });
    });

    it("highlights TypeScript with the VS Code theme colors", async () => {
        const lines = await highlightSyntaxCodeAsync('const value = "ok";', "typescript");

        expect(lines.join("\n")).toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(lines.join("\n")).toContain("const");
    });

    it("keeps unchanged script colors visible while native Bash arguments grow", async () => {
        const bash = createNativeBashFeature();
        let current: Component | undefined;
        const context = {
            ...renderContext,
            toolCallId: "stream-call",
            executionStarted: false,
            argsComplete: false,
            isPartial: true,
            cwd: "/workspace",
            state: {},
            lastComponent: undefined,
        };
        const source = 'title = "STREAM_COLOR_SAMPLE"\ncount = 1';
        const args = { command: `python -c '${source}'` };
        const first = bash.renderBashCall(
            args,
            piTheme,
            { ...context, args, invalidate: () => current?.invalidate() },
            () => 8,
            () => false,
            () => "auto",
            () => "trailing",
        );
        current = first;
        first.render(120);
        await bash.settled();
        first.render(120);
        await settleSyntaxHighlights();
        const colored = first.render(120);
        expect(colored[1]).toContain(STRING_RGB_CODE);
        const nextArgs = { command: `python -c '${source}\nprint(title, count)'` };

        try {
            const next = bash.renderBashCall(
                nextArgs,
                piTheme,
                {
                    ...context,
                    args: nextArgs,
                    lastComponent: first,
                    invalidate: () => current?.invalidate(),
                },
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
            );
            current = next;
            const pending = next.render(120);

            expect(pending[1]).toBe(colored[1]);
            expect(stripVTControlCharacters(pending.join("\n"))).toContain("print(title, count)");
            await bash.settled();
            const updated = next.render(120);
            expect(updated[1]).toBe(colored[1]);
            expect(stripVTControlCharacters(updated.join("\n"))).toContain("print(title, count)");
        } finally {
            await settleSyntaxHighlights();
            bash.clear();
        }
    });

    it("keeps unchanged write-preview colors visible while content grows", async () => {
        let current: Component | undefined;
        const context = {
            ...renderContext,
            toolCallId: "write-stream-call",
            executionStarted: false,
            argsComplete: false,
            isPartial: true,
            movingViewport: false,
        };
        const source = 'title = "STREAM_WRITE_COLOR_SAMPLE"\ncount = 1';
        const first = renderWriteCallPreview({ path: "stream.py", content: source }, piTheme, {
            ...context,
            invalidate: () => current?.invalidate(),
        });
        current = first;
        first.render(120);
        await settleSyntaxHighlights();
        const colored = first.render(120);
        const coloredRow = colored.find((line) => line.includes("STREAM_WRITE_COLOR_SAMPLE"));
        expect(coloredRow).toContain(STRING_RGB_CODE);

        try {
            const next = renderWriteCallPreview(
                { path: "stream.py", content: source + "\nprint(title, count)" },
                piTheme,
                {
                    ...context,
                    lastComponent: first,
                    invalidate: () => current?.invalidate(),
                },
            );
            current = next;
            const pending = next.render(120);

            expect(pending.find((line) => line.includes("STREAM_WRITE_COLOR_SAMPLE"))).toBe(
                coloredRow,
            );

            expect(stripVTControlCharacters(pending.join("\n"))).toContain("print(title, count)");
        } finally {
            await settleSyntaxHighlights();
        }
    });

    it.each([
        { kind: "code", makeNode: code },
        { kind: "output", makeNode: output },
    ])(
        "preserves explicit $kind node syntax colors in the outline presentation",
        async ({ makeNode }) => {
            const text = 'const value = "ok";';
            await highlightSyntaxCodeAsync(text, "typescript");
            const node = makeNode(text, { syntax: { language: "typescript" } });
            const compact = compactPresentation
                .renderNode(node, plainTheme, renderContext, "static")
                .render(80)
                .join("\n");
            const outline = outlinePresentation
                .renderNode(node, plainTheme, renderContext, "static")
                .render(80)
                .join("\n");

            expect(compact).toContain(`${TYPESCRIPT_KEYWORD_COLOR}const`);
            expect(outline).toContain(`${TYPESCRIPT_KEYWORD_COLOR}const`);
            expect(stripVTControlCharacters(outline).trim()).toBe(text);
        },
    );

    it.each([
        { kind: "code", makeNode: code },
        { kind: "output", makeNode: output },
    ])(
        "keeps default and explicit plain $kind nodes uncolored in the outline presentation",
        ({ makeNode }) => {
            const text = 'const value = "ok";';
            for (const node of [makeNode(text), makeNode(text, { syntax: { language: "text" } })]) {
                const outline = outlinePresentation
                    .renderNode(node, plainTheme, renderContext, "static")
                    .render(80);

                expect(outline).toEqual([`  ${text}`]);
            }
        },
    );

    it("preserves grammar state through an oversized multiline comment", async () => {
        const code = `const before = "safe";\n/* ${"x".repeat(9_000)}\nconst inside = "not code";\n*/\nconst after = 1;`;
        const lines = await highlightSyntaxCodeAsync(code, "javascript", { cache: false });
        expect(lines[0]).toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(lines[1]).toContain(ANSI_ESCAPE);
        expect(lines[2]).not.toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(lines[4]).toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(stripVTControlCharacters(lines.join("\n"))).toBe(code);
    });

    it("colors code cut inside a string like the rest of that string", async () => {
        const [cutLine] = await highlightSyntaxCodeAsync(
            'const path = "/srv/app/cache/',
            "javascript",
            {
                cache: false,
            },
        );
        const cutLines = await highlightSyntaxCodeAsync(
            'const first = 1;\nconst paths = ["/srv/app/cache/',
            "typescript",
            { cache: false },
        );

        expect(cutLine).toContain("cache/");
        expect(cutLines[1]).toContain("cache/");
        expect(cutLines[0]).toContain(TYPESCRIPT_KEYWORD_COLOR);
    });

    it("highlights accepted one-line scripts longer than 1000 characters", async () => {
        const code = `const values = [${Array.from({ length: 140 }, (_value, index) => `"value-${index}"`).join(",")}];`;

        expect(code.length).toBeGreaterThan(1_000);
        expect(code.length).toBeLessThanOrEqual(2_000);
        expect((await highlightSyntaxCodeAsync(code, "javascript")).join("\n")).toContain(
            TYPESCRIPT_KEYWORD_COLOR,
        );
    });

    it("highlights long logical lines verbatim within the block budget", async () => {
        const code = `const values = [${Array.from({ length: 230 }, (_value, index) => `"item-${index}"`).join(",")}];`;
        const highlighted = (await highlightSyntaxCodeAsync(code, "javascript")).join("\n");
        expect(highlighted).toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(stripVTControlCharacters(highlighted)).toBe(code);
        const excessive = `const value = "${"x".repeat(16_000)}";`;
        const large = (await highlightSyntaxCodeAsync(excessive, "javascript")).join("\n");
        expect(large).toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(stripVTControlCharacters(large)).toBe(excessive);
    });

    it("distinguishes Bash variables from literal quoted text and redirect operands", () => {
        const rendered = renderScriptCall(
            piTheme,
            {
                label: "Bash",
                language: "bash",
                code: `result=$?; printf '%s\\n' "literal $result"; rg word 2>/dev/null; > before.log git status`,
            },
            { state: "success", expanded: true },
        )
            .render(240)
            .join("\n");
        expect(rendered).toContain("38;2;156;220;254mresult");
        expect(rendered).toContain("38;2;156;220;254m$?");
        expect(rendered).toContain("38;2;156;220;254m$result");
        expect(rendered).toContain(`${STRING_RGB_CODE}m'%s\\n'`);
        expect(rendered).toContain(piTheme.fg("accent", "/dev/null"));
        expect(rendered).toContain(piTheme.fg("accent", "before.log"));
        expect(rendered).toContain("38;2;220;220;170mgit");
        const command = `NAME="literal $value" printf 'literal $value' "\\$value" "\${value:-fallback}" 3>log.txt 4>&1`;
        const mixed = renderScriptCall(
            piTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        )
            .render(240)
            .join("\n");
        expect(stripVTControlCharacters(mixed)).toBe(`$ ${command}`);
        expect(mixed).toContain(`${STRING_RGB_CODE}m'literal $value'`);
        expect(mixed).toContain("38;2;156;220;254m$\u007bvalue:-fallback}");
    });

    it("does not reset surrounding backgrounds after highlighted lines", async () => {
        const rendered = (await highlightSyntaxCodeAsync('const value = "ok";', "typescript")).join(
            "\n",
        );

        expect(rendered).not.toContain("\u001b[0m");
        expect(rendered).not.toContain("\u001b[49m");
        expect(rendered).not.toContain("\u001b[48;");
    });

    it("colors Python import identifiers like VS Code semantic highlighting", async () => {
        const rendered = (
            await highlightSyntaxCodeAsync(
                "import sys\nfrom collections.abc import Callable",
                "python",
            )
        ).join("\n");

        expect(rendered).toContain(`${TYPE_RGB_CODE}msys`);
        expect(rendered).toContain(`${TYPE_RGB_CODE}mcollections.abc`);
        expect(rendered).toContain(`${TYPE_RGB_CODE}mCallable`);
    });

    it("colors Python neutral identifiers as variables, constants, and calls", async () => {
        const rendered = (
            await highlightSyntaxCodeAsync(
                "if IGNORE_BREAKS:\n    handler(line)\n    value = get_terminal_size().columns",
                "python",
            )
        ).join("\n");

        expect(rendered).toContain(`${TYPE_RGB_CODE}mIGNORE_BREAKS`);
        expect(rendered).toContain(`${FUNCTION_RGB_CODE}mhandler`);
        expect(rendered).toContain(`${VARIABLE_RGB_CODE}mline`);
        expect(rendered).toContain(`${VARIABLE_RGB_CODE}mvalue`);
        expect(rendered).toContain(`${FUNCTION_RGB_CODE}mget_terminal_size`);
    });

    it("adds VS Code bracket pair colors without recoloring strings", async () => {
        const rendered = (
            await highlightSyntaxCodeAsync('const value = make([]Item, "(text)");', "typescript")
        ).join("\n");

        expect(rendered).toContain(BRACKET_PAIR_1_RGB_CODE);
        expect(rendered).toContain(BRACKET_PAIR_2_RGB_CODE);
        expect(rendered).toContain(`${STRING_RGB_CODE}m"(text)"`);
    });

    it("preserves syntax-theme bracket colors when pair coloring is disabled", async () => {
        configureSyntaxBracketPairColoring(false);
        try {
            const rendered = (
                await highlightSyntaxCodeAsync(
                    'const value = make([]Item, "(text)");',
                    "typescript",
                )
            ).join("\n");

            expect(rendered).not.toContain(BRACKET_PAIR_1_RGB_CODE);
            expect(rendered).not.toContain(BRACKET_PAIR_2_RGB_CODE);
            expect(rendered).toContain(`${NEUTRAL_PUNCTUATION_RGB_CODE}m([]`);
        } finally {
            configureSyntaxBracketPairColoring(true);
        }
    });

    it("falls back to plain lines for unknown languages", () => {
        expect(highlightSyntaxCode("hello\nworld", "not-a-real-language")).toEqual([
            "hello",
            "world",
        ]);
    });

    it("normalizes Rust and Go language aliases", () => {
        expect(normalizeSyntaxLanguage("rust")).toBe("rust");
        expect(normalizeSyntaxLanguage("rs")).toBe("rust");
        expect(normalizeSyntaxLanguage("go")).toBe("go");
        expect(normalizeSyntaxLanguage("golang")).toBe("go");
    });

    it("injects the central highlighter into Markdown code fences", async () => {
        await highlightSyntaxCodeAsync("const value = 1;", "typescript");
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

    it("highlights bash command and executable script previews", async () => {
        await highlightSyntaxCodeAsync("const value = 1;", "javascript");
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
                    "python3 manage.py validate --os sample && rsync -az config/services/sample.toml sample-host:~/config/services/sample.toml",
                    "sudo dnf install -y duf",
                ].join("\n"),
            },
            { state: "success", expanded: true },
        )
            .render(240)
            .join("\n");

        expect(rendered).toContain(ANSI_ESCAPE);
        expect(rendered).toContain("manage.py");
        expect(rendered).toContain("config/services/sample.toml");
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mmanage.py`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}msample`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mconfig/services/sample.toml`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mvalidate`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}minstall`);
    });

    it("preserves multiline TypeScript comment highlighting in script previews", async () => {
        const code = [
            "/**",
            " * Expands the collapsed paste marker currently under the editor cursor.",
            " */",
            "export function expandPasteMarkerAtCursor(): boolean {",
            "    return true;",
            "}",
        ].join("\n");
        const expectedCommentLine = (await highlightSyntaxCodeAsync(code, "typescript"))[1];
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

    it("preserves multiline TypeScript highlighting inside bash heredocs", async () => {
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
        const expectedCommentLine = (await highlightSyntaxCodeAsync(`${code}\n`, "typescript"))[1];
        const rendered = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        ).render(180);
        const renderedCommentLine = rendered.find((line) => line.includes("Expands the collapsed"));

        expect(stripVTControlCharacters(rendered[0] ?? "")).toBe("$ pkg=/tmp/node_modules");
        expect(expectedCommentLine).toBeDefined();
        expect(renderedCommentLine).toContain(expectedCommentLine);
    });

    it("highlights a file-writing TypeScript heredoc from its destination extension", async () => {
        const code = "const value: { readonly ok: boolean } = { ok: true };";
        const expected = (await highlightSyntaxCodeAsync(`${code}\n`, "typescript"))[0];
        const command = `cat > /tmp/sample.mts <<'EOF'\n${code}\nEOF\nnode /tmp/sample.mts`;
        const rendered = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        ).render(180);
        expect(expected).toBeDefined();
        expect(rendered.find((line) => line.includes("const"))).toContain(expected);
        expect(stripVTControlCharacters(rendered[0] ?? "")).toBe("$ cat > /tmp/sample.mts <<'EOF'");
    });

    it("highlights embedded Python heredocs inside bash previews as Python", async () => {
        await highlightSyntaxCodeAsync(
            "import json, sys\npath = sys.argv[1]\nprint(json.load(open(path)).get('$schema'))\n",
            "python",
        );
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

    it("highlights single-quoted inline Python inside a composed Bash pipeline", async () => {
        await highlightSyntaxCodeAsync(
            'import sys\nfor line in sys.stdin:\n    value, name = line.split()\n    print(f"{int(value):04d} {name}")\n',
            "python",
        );
        const command = [
            "printf '%s\\n' '8 read' '13 patch' | python3 -c 'import sys",
            "for line in sys.stdin:",
            "    value, name = line.split()",
            '    print(f"{int(value):04d} {name}")',
            "' | sort -nr | head -n 2",
        ].join("\n");

        const rendered = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        )
            .render(180)
            .join("\n");

        expect(stripVTControlCharacters(rendered)).toMatch(/^\$ printf/u);
        expect(rendered).toContain(`${TYPE_RGB_CODE}msys`);
        expect(rendered).not.toContain(`${STRING_RGB_CODE}mimport sys`);
        expect(rendered).toContain("| sort -nr | head -n 2");
    });

    it("highlights literal awk and jq programs inside a composed Bash pipeline", async () => {
        const jq = ".items[] | select(.enabled) | {name, total: (.prices | add)}";
        const awk = '{ n += $2 } END { printf "%d\\n", n }';
        expect(await loadSyntaxLanguageIfReady("jq")).toBe(true);
        expect(await loadSyntaxLanguageIfReady("awk")).toBe(true);
        const [jqRow] = await highlightSyntaxCodeAsync(jq, "jq");
        const [awkRow] = await highlightSyntaxCodeAsync(awk, "awk");
        const [expandingRow] = await highlightSyntaxCodeAsync(".totals.$key", "jq");
        const command = `jq -c '${jq}' a.json | awk -F, '${awk}' | jq ".totals.$key"`;

        const rendered = renderScriptCall(
            plainTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: true },
        )
            .render(200)
            .join("\n");

        expect(stripVTControlCharacters(jqRow ?? "")).toBe(jq);
        expect(jqRow).not.toBe(jq);
        expect(rendered).toContain(jqRow);
        expect(rendered).toContain(awkRow);

        // The shell expands $key before jq runs; that text is not the jq program.
        expect(rendered).not.toContain(expandingRow);
        expect(stripVTControlCharacters(rendered)).toBe(`$ ${command}`);
    });

    it("places truncated JSON omission at the cut without invalid-syntax red", () => {
        const output = JSON.stringify(
            {
                argv: ["--", "demo", "--verbose"],
                count: 5,
                kinds: { patch: 2, read: 2, write: 1 },
                median_ms: 23,
                slowest_ms: 41,
            },
            null,
            2,
        );
        const rendered = renderGlowupOutput(piTheme, output, {
            expanded: false,
            maxPreviewLines: 5,
            syntax: { language: "json" },
        }).render(160);
        const markerIndex = rendered.findIndex((line) => line.includes("lines ("));
        const argvIndex = rendered.findIndex((line) => line.includes('"argv"'));
        const slowestIndex = rendered.findIndex((line) => line.includes('"slowest_ms"'));

        expect(argvIndex).toBeGreaterThanOrEqual(0);
        expect(markerIndex).toBeGreaterThan(argvIndex);
        expect(slowestIndex).toBeGreaterThan(markerIndex);
        expect(rendered.join("\n")).not.toContain(`\u001b[${TOML_INVALID_RGB_CODE}m`);
    });

    it("highlights code output previews when a path is known", async () => {
        await highlightSyntaxCodeAsync("const value = 1;", "typescript");
        const rendered = renderGlowupOutput(plainTheme, "const value = 1;", {
            expanded: false,
            syntax: { path: "src/example.ts" },
        })
            .render(100)
            .join("\n");

        expect(rendered).toContain(TYPESCRIPT_KEYWORD_COLOR);
        expect(rendered).toContain("const");
    });

    it("preserves multiline TypeScript comment highlighting in code output previews", async () => {
        const code = [
            "/**",
            " * Expands the collapsed paste marker currently under the editor cursor.",
            " */",
            "export function expandPasteMarkerAtCursor(): boolean {",
            "    return true;",
            "}",
        ].join("\n");
        const expectedCommentLine = (await highlightSyntaxCodeAsync(code, "typescript"))[1];
        const renderedCommentLine = renderGlowupOutput(plainTheme, code, {
            expanded: false,
            maxPreviewLines: 8,
            syntax: { path: "src/example.ts" },
        })
            .render(160)
            .find((line) => line.includes("Expands the collapsed"));

        expect(expectedCommentLine).toBeDefined();
        expect(renderedCommentLine).toContain(expectedCommentLine);
    });

    it("highlights partial write previews while streaming", async () => {
        await highlightSyntaxCodeAsync("const value = 1;\n", "typescript");
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

    it("highlights third-party JSON fallback previews", async () => {
        await highlightSyntaxCodeAsync('{"ok": true}', "json");
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

    it("highlights fallback diff previews when a path is known", async () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "two-tone",
            diffLineNumberStyle: "dual",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: null,
            deletedRowBackground: null,
            addedContentBackground: null,
            deletedContentBackground: null,
            instructionPathColor: null,
            dimUnchangedDiffText: false,
        });
        const rendered = await renderReadyDiff(
            parseDiffSections(
                " 7 import pytest\n+9 def test_value():\n-9 def old_value():",
                "tests/example.py",
            ),
            false,
            120,
        );

        expect(rendered).toContain("def");
        expect(rendered).toContain("38;2");
    });

    it("uses surrounding TOML diff context for inline table braces", async () => {
        const rendered = await renderReadyDiff(
            parseDiffSections(
                [
                    " 1 [[package]]",
                    ' 2 name = "bat"',
                    " 3 targets = [",
                    ' 4     { os = "arch", id = "bat", pm = "pacman" },',
                    " 5 ]",
                ].join("\n"),
                "config/services/sample.toml",
            ),
            true,
            180,
        );

        expect(rendered).toContain(BRACKET_PAIR_2_RGB_CODE);
        expect(rendered).not.toContain(TOML_INVALID_RGB_CODE);
    });

    it("does not highlight TOML after diff ellipses as invalid", async () => {
        const rendered = await renderReadyDiff(
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
                "config/services/sample.toml",
            ),
            false,
            180,
        );

        expect(rendered).toContain(BRACKET_PAIR_2_RGB_CODE);
        expect(rendered).not.toContain(TOML_INVALID_RGB_CODE);
    });

    it("highlights an extensionless uv Python script edit as Python", async () => {
        const oldContent = "#!/usr/bin/env -S uv run --script\ndef serve():\n    return 1\n";
        const newContent = "#!/usr/bin/env -S uv run --script\ndef serve():\n    return 2\n";
        const payload = buildPierreDiffPayload({
            path: "bin/serve-model",
            oldContent,
            newContent,
            oldSizeBytes: Buffer.byteLength(oldContent, "utf8"),
            newSizeBytes: Buffer.byteLength(newContent, "utf8"),
            canBuildPierreDiff: true,
        });
        if (payload?.kind !== "renderable") {
            throw new Error("expected renderable Python diff payload");
        }

        const highlighted = await loadHighlightedDiff(payload.metadata);
        expect(payload.metadata.lang).toBe("python");
        expect(JSON.stringify(highlighted.dark.deletionLines)).toContain("#569CD6");

        const rendered = renderPierreDiff(
            payload,
            piTheme,
            { expanded: true },
            { lastComponent: undefined },
        ).render(100);
        expect(rendered.join("\n")).toContain(TYPESCRIPT_KEYWORD_RGB_CODE);
    });

    it("uses the same VS Code theme for Pierre diff highlighting", async () => {
        const payload = buildPierreDiffPayload({
            path: "example.ts",
            oldContent: "const value = call(1);\n",
            newContent: "const value = call(2);\n",
            oldSizeBytes: Buffer.byteLength("const value = call(1);\n", "utf8"),
            newSizeBytes: Buffer.byteLength("const value = call(2);\n", "utf8"),
            canBuildPierreDiff: true,
        });
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
        const rendered = component.render(100).join("\n");

        expect(rendered).toContain(TYPESCRIPT_KEYWORD_RGB_CODE);
        expect(rendered).toContain(BRACKET_PAIR_1_RGB_CODE);
        expect(rendered).not.toContain(" │ ");
    });
});
