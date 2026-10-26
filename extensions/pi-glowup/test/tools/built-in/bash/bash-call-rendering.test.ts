import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import { Theme } from "@earendil-works/pi-coding-agent";
import { renderBashCommandCall } from "../../../../src/tools/built-in/bash/renderer.ts";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import type { ShellOutputStyle } from "../../../../src/tools/built-in/bash/command.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import type { GlowupRenderTheme } from "../../../../src/rendering/theme.ts";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../../support/theme-colors.ts";

const theme: GlowupRenderTheme = {
    fg(_token, text) {
        return text;
    },
    bold(text) {
        return text;
    },
};

function plain(lines: readonly string[]): string[] {
    return lines.map((line) => stripVTControlCharacters(line).replace(/<\/?[A-Za-z]+>/gu, ""));
}

function render(command: string, options: { width: number; expanded?: boolean }) {
    return plain(
        renderBashCommandCall(theme, command, {
            state: "success",
            expanded: options.expanded ?? false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
        }).render(options.width),
    );
}

describe("bash command rendering", () => {
    it.each([
        "bash -c 'git status --short'",
        'bash -lc "git status --short"',
        "/bin/bash -lc 'git status --short'",
        "env MODE=demo bash -c 'git status --short'",
        "pwd && bash -c 'git status --short' && echo done",
        "bash -o pipefail -lc 'git status --short'",
        "bash -c 'bash -lc \"git status --short\"'",
    ])("highlights quoted nested Bash as code: %s", (command) => {
        const coloredTheme: GlowupRenderTheme = {
            ...theme,
            fg(token, text) {
                return `<${token}>${text}</${token}>`;
            },
        };
        const lines = renderBashCommandCall(coloredTheme, command, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "preserve",
            shellOperatorPosition: "trailing",
        }).render(2000);
        const rendered = lines.join("\n");

        expect(rendered).toContain("<syntaxFunction>git</syntaxFunction>");
        expect(rendered).toContain("<syntaxFunction>status</syntaxFunction>");
        expect(rendered).toContain("<syntaxKeyword>--short</syntaxKeyword>");
        expect(plain([rendered])[0]).toBe(`$ ${command}`);
    });

    it.each([
        String.raw`bash -c "echo \"a # b\"; git status --short"`,
        String.raw`bash -c "bash -lc \"git status --short\""`,
        String.raw`bash -c "printf '%s' '\$HOME'; git status --short"`,
        String.raw`bash -c "printf '%s' '\\'; git status --short"`,
    ])("highlights escaped nested code without changing its source: %s", (command) => {
        const colors = new Map([
            ["syntaxFunction", "\u001b[33m"],
            ["syntaxKeyword", "\u001b[34m"],
            ["syntaxString", "\u001b[32m"],
        ]);

        const coloredTheme: GlowupRenderTheme = {
            ...theme,
            fg(token, text) {
                return `${colors.get(token) ?? "\u001b[37m"}${text}\u001b[0m`;
            },
        };
        const rendered = renderBashCommandCall(coloredTheme, command, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "preserve",
            shellOperatorPosition: "trailing",
        })
            .render(2000)
            .join("\n");

        expect(rendered).toContain("\u001b[33mgit\u001b[0m");
        expect(rendered).toContain("\u001b[34m--short\u001b[0m");
        expect(stripVTControlCharacters(rendered)).toBe(`$ ${command}`);
    });

    it.each([
        'printf "%s" "git status --short"',
        'bash script.sh "git status --short"',
        'bash script.sh -c "git status --short"',
        'bash -- -c "git status --short"',
        'echo bash -c "git status --short"',
    ])("keeps ordinary quoted arguments as strings: %s", (command) => {
        const coloredTheme: GlowupRenderTheme = {
            ...theme,
            fg(token, text) {
                return `<${token}>${text}</${token}>`;
            },
        };
        const rendered = renderBashCommandCall(coloredTheme, command, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "preserve",
            shellOperatorPosition: "trailing",
        })
            .render(2000)
            .join("\n");

        expect(rendered).toContain("<syntaxString>git status --short</syntaxString>");
        expect(rendered).not.toContain("<syntaxFunction>git</syntaxFunction>");
        expect(plain([rendered])[0]).toBe(`$ ${command}`);
    });

    it("preserves multiline nested Bash and its ordinary string arguments", () => {
        const command = 'bash -c \'git status --short\nprintf "%s" "sample text"\'';

        const coloredTheme: GlowupRenderTheme = {
            ...theme,
            fg(token, text) {
                return `<${token}>${text}</${token}>`;
            },
        };
        const lines = renderBashCommandCall(coloredTheme, command, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "preserve",
            shellOperatorPosition: "trailing",
        }).render(2000);
        const rendered = lines.join("\n");

        expect(rendered).toContain("<syntaxFunction>git</syntaxFunction>");
        expect(rendered).toContain("<syntaxFunction>printf</syntaxFunction>");
        expect(rendered).toContain("<syntaxString>sample text</syntaxString>");
        expect(plain(lines)).toEqual([
            "$ bash -c 'git status --short",
            '  printf "%s" "sample text"\'',
        ]);
    });

    it.each(["success", "error"] as const)(
        "right-aligns the finished duration on the prompt row (%s)",
        (state) => {
            const rows = renderBashCommandCall(theme, "first; second", {
                state,
                expanded: false,
                maxCodePreviewLines: 8,
                showPrologueOmission: false,
                shellLayout: "always",
                shellOperatorPosition: "trailing",
                durationMs: 90_500,
            }).render(40);

            expect(plain(rows)).toEqual([`$ first;${" ".repeat(25)}1m 30s `, "  second"]);
        },
    );

    it("leaves the duration slot empty while the command runs", () => {
        const rows = renderBashCommandCall(theme, "sleep 5", {
            state: "running",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
            durationMs: 1200,
        }).render(40);

        expect(plain(rows)).toEqual(["$ sleep 5"]);
    });

    it("wraps a long first statement before the duration instead of overflowing", () => {
        const rows = renderBashCommandCall(theme, "echo alpha beta gamma delta epsilon", {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
            durationMs: 4270,
        }).render(30);

        expect(rows.every((row) => visibleWidth(row) <= 30)).toBe(true);
        expect(plain(rows)[0]).toMatch(/^\$ echo .* 4\.27s $/u);
        expect(plain(rows).join(" ")).toContain("epsilon");
    });

    it("preserves short composed commands on one line", () => {
        expect(render("one && two", { width: 80 })).toEqual(["$ one && two"]);
    });

    it("supports always-on structural Bash layout", () => {
        const rendered = renderBashCommandCall(theme, "one | two && three", {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "always",
            shellOperatorPosition: "trailing",
        }).render(80);

        expect(plain(rendered)).toEqual(["$ one | two &&", "  three"]);
    });

    it("keeps leading operators selectable", () => {
        const rendered = renderBashCommandCall(theme, "one && two", {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "always",
            shellOperatorPosition: "leading",
        }).render(80);

        expect(plain(rendered)).toEqual(["$ one", "  && two"]);
    });

    it.each(["auto", "always"] as const)("retains branch comments in %s layout", (shellLayout) => {
        const command = "if check; then first; else # the else branch\nsecond; fi";
        const rows = renderBashCommandCall(theme, command, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout,
            shellOperatorPosition: "trailing",
        }).render(120);
        expect(plain(rows)).toEqual([
            "$ if check; then",
            "    first;",
            "  else # the else branch",
            "  second;",
            "  fi",
        ]);
    });

    it("keeps pipelines and fallbacks on their step line when they fit", () => {
        const command =
            `pwd && opencode debug --help | head -80 ` +
            `&& ls -l /tmp/opencode || true && pnpm --version`;
        const rendered = render(command, { width: 100 }).join("\n");

        expect(rendered.split("\n")).toEqual([
            "$ pwd &&",
            "  opencode debug --help | head -80 &&",
            "  ls -l /tmp/opencode || true &&",
            "  pnpm --version",
        ]);
    });

    it("allows long pipeline steps to wrap within their own row", () => {
        const command =
            `cat records.json | python -c "import sys,json; print(len(json.load(sys.stdin)))" ` +
            `&& git status --short`;
        const rendered = render(command, { width: 54 }).join("\n");

        expect(rendered).toContain("$ cat records.json | python -c");
        expect(rendered).toContain("\n  git status --short");
        expect(rendered).not.toContain("• Python");
    });

    it("structures compound shell without adding hierarchy labels", () => {
        const command = `for file in *.json; do python -c "print('x')" "$file" | jq -r .; done`;
        const rendered = render(command, { width: 54 }).join("\n");

        expect(rendered).toContain("$ for file in *.json; do");
        expect(rendered).toContain(`\n    python -c "print('x')" "$file" | jq -r .;`);
        expect(rendered).toContain("\n  done");
        expect(rendered).not.toContain("Pipeline");
        expect(rendered).not.toContain("Shell");
    });

    it("keeps later operations visible when the first operation is huge", () => {
        const command = `git add ${Array.from({ length: 80 }, (_value, index) => `src/file-${index}.ts`).join(" ")} && git commit -m "finish work" && git status --short`;
        const rendered = render(command, { width: 44 }).join("\n");

        expect(rendered).toContain("git add");
        expect(rendered).toContain("git commit -m");
        expect(rendered).toContain("git status --short");
        expect(rendered).toContain("…");
    });

    it("recomputes automatic layout after width changes", () => {
        const component = renderBashCommandCall(theme, "alpha && beta", {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
        });

        expect(component.render(100)).toHaveLength(1);
        expect(component.render(16).join("\n")).toContain("alpha &&");
        expect(component.render(16).join("\n")).toContain("beta");
        expect(component.render(100)).toHaveLength(1);
    });

    it("keeps compound shell structurally separated at wide widths", () => {
        const command =
            `for item in alpha beta gamma delta; do if test "\${#item}" -gt 4; ` +
            `then printf '%s\\n' "$item"; else printf '%s\\n' short; fi; done | sort ` +
            `&& case "$(uname -s)" in Linux) echo linux;; *) echo other;; esac`;
        const rendered = render(command, { width: 312, expanded: true });

        expect(rendered[0]).toBe("$ for item in alpha beta gamma delta; do");
        expect(rendered.join("\n")).toContain("\n    if test");
        expect(rendered.join("\n")).toContain("\n  case");
    });

    it("leaves code-writing heredocs as Bash without special body labels", () => {
        const command = `cat > check.py <<'PY'\nimport json\nprint(json)\nPY`;
        const rendered = render(command, { width: 80 }).join("\n");

        expect(rendered).toContain("$ cat > check.py <<'PY'");
        expect(rendered).toContain("\n  import json");
        expect(rendered).not.toContain("• Python");
    });

    it("keeps a composed Node heredoc containing Python examples classified as Bash", () => {
        const command = [
            `rg -n "this\\.source" src/tools/built-in/bash/command.ts || true`,
            `node --import tsx --input-type=module <<'NODE'`,
            `const examples = [`,
            '`cd project && python -c "import sys; print(sys.argv)" -- --help`,',
            "`node -e \"console.log('ok')\" 2>/dev/null || true`,",
            `];`,
            `console.log(examples);`,
            `NODE`,
        ].join("\n");
        const rendered = render(command, { width: 120 }).join("\n");

        expect(rendered).toMatch(/^\$ rg -n/u);
        expect(rendered).toContain("node --import tsx --input-type=module");
        expect(rendered).not.toContain("• Python");
    });

    it("reveals nine fitting terminal rows but keeps taller script content capped", () => {
        const command = `python -c '${["x=1", "x=2", "x=3", "x=4", "x=5", "x=6", "x=7", "print(12345678)"].join("\n")}'`;
        const component = renderBashCommandCall(theme, command, {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
        });
        const fitting = component.render(16);
        expect(fitting).toHaveLength(10);
        expect(fitting.at(-1)).toContain("78)");
        expect(fitting.join("\n")).not.toContain("…");
        const taller = component.render(10);
        expect(taller.join("\n")).toContain("…");
        expect(taller.join("\n")).not.toContain("78)");
        expect(taller.every((line) => visibleWidth(line) <= 10)).toBe(true);
        expect(component.render(16)).toEqual(fitting);
    });

    it("puts a standalone interpreter's launcher on the prompt row and its source below", () => {
        expect(render(`python -c "import os; print(os.getcwd())"`, { width: 80 })).toEqual([
            "$ python -c",
            "  import os; print(os.getcwd())",
        ]);
    });

    it("keeps wrapper words and trailing argv on the prompt row", () => {
        const command =
            "uv run --offline --no-project python -c 'import sys\nprint(sys.argv)' -- demo --verbose";

        expect(render(command, { width: 100 })).toEqual([
            "$ uv run --offline --no-project python -c … -- demo --verbose",
            "  import sys",
            "  print(sys.argv)",
        ]);
    });

    it("right-aligns the duration on the launcher row", () => {
        const rows = renderBashCommandCall(theme, `python3 - <<'PY'\nprint(1)\nPY`, {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
            durationMs: 310,
        }).render(40);

        expect(plain(rows)).toEqual([`$ python3 - <<'PY'${" ".repeat(16)}0.31s `, "  print(1)"]);
    });

    it("keeps every collapsed row within the terminal width", () => {
        const rendered = render(
            `if check; then cat records.json | python -c "print('a very long embedded source value')"; else git status --short; fi`,
            { width: 32 },
        );
        expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    });

    it("highlights embedded heredocs accurately across preview truncation boundaries", () => {
        const command = [
            "node --input-type=module <<'JS'",
            "import assert from 'node:assert/strict';",
            "import { buildSystemPrompt } from './prompt.js';",
            "const a = 1;",
            "const b = 2;",
            "const c = 3;",
            "const d = 4;",
            "const e = 5;",
            "const f = 6;",
            "JS",
            "git diff --check",
            "git diff -- src/prompt.js",
        ].join("\n");
        const collapsed = renderBashCommandCall(theme, command, {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 6,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
        })
            .render(80)
            .join("\n");

        expect(stripVTControlCharacters(collapsed)).toContain("$ node --input-type=module <<'JS'");
        expect(collapsed).toContain("import assert from 'node:assert/strict';");
        expect(collapsed).toMatch(/… \+6 lines/u);
        expect(collapsed).not.toContain("git diff --check");

        const expanded = renderBashCommandCall(theme, command, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 6,
            showPrologueOmission: false,
            shellLayout: "auto",
            shellOperatorPosition: "trailing",
        })
            .render(80)
            .join("\n");

        expect(expanded).toContain("git diff --check");
        expect(expanded).not.toMatch(/… \+6 lines/u);
    });
});

describe("bash result rendering", () => {
    const resultTheme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

    function renderResult(
        command: string,
        output: string,
        style: ShellOutputStyle,
        width = 40,
    ): string[] {
        const context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "bash-result",
            cwd: "/work",
            lastComponent: undefined,
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: false,
            showImages: false,
            isError: false,
            durationMs: 1000,
            outputPad: 1,
            invalidate: () => {},
        };

        return plain(
            createNativeBashFeature()
                .renderBashResult(
                    { content: [{ type: "text", text: output }] },
                    { expanded: false, isPartial: false },
                    resultTheme,
                    context,
                    () => style,
                )
                .render(width),
        );
    }

    it("starts terminal-style shell output at the left edge without a marker", () => {
        expect(renderResult("ls", "alpha\n  beta", "terminal")).toEqual(["alpha", "  beta"]);
        expect(renderResult("true", "", "terminal")).toEqual(["(no output)"]);
    });

    it("keeps every gutter-style row behind the gutter, including wrapped and omission rows", () => {
        const output = ["x".repeat(50), "two", "three", "four", "five", "six", "seven"].join("\n");
        const rows = renderResult("ls", output, "gutter");

        expect(rows.length).toBeGreaterThan(2);
        expect(rows.every((row) => row.startsWith("│ "))).toBe(true);
        expect(rows.some((row) => row.includes("…"))).toBe(true);
        expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
    });

    it("uses the shell output style for interpreter script calls", () => {
        expect(renderResult(`python -c "print('hi')"`, "hi", "terminal")).toEqual(["hi"]);
        expect(renderResult(`python -c "print('hi')"`, "hi", "gutter")).toEqual(["│ hi"]);
    });
});
