import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
    formatGrepAction,
    formatReadAction,
    highlightShell,
    isInstructionFilePath,
    makeComponent,
    parseDiffSections,
    parseScriptInvocation,
    renderCodexCall,
    renderCodexDiff,
    renderCodexOutput,
    renderScriptCall,
    type CodexRenderTheme,
} from "../src/rendering.ts";

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

const tokenTheme: CodexRenderTheme = {
    fg(token: string, text: string): string {
        return `<${token}>${text}</${token}>`;
    },
    bg(_token: string, text: string): string {
        return text;
    },
    bold(text: string): string {
        return text;
    },
};

function expectLinesWithinWidth(lines: ReadonlyArray<string>, width: number): void {
    for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
}

describe("Codex rendering helpers", () => {
    it("formats compact read and grep calls", () => {
        expect(formatReadAction(plainTheme, { path: "/tmp/example.ts", offset: 4, limit: 3 })).toBe(
            "Read /tmp/example.ts:4-6",
        );
        expect(
            formatGrepAction(plainTheme, {
                pattern: "needle",
                path: "src",
                glob: "*.ts",
                limit: 5,
            }),
        ).toBe("Search needle in src (*.ts) limit 5");
    });

    it("colors instruction read paths purple", () => {
        expect(isInstructionFilePath("/home/me/.pi/agent/skills/typescript/SKILL.md")).toBe(true);
        expect(
            isInstructionFilePath(
                "/home/me/.pi/agent/npm/node_modules/pi-autoresearch/skills/autoresearch-create/SKILL.md",
            ),
        ).toBe(true);
        expect(isInstructionFilePath("src/AGENTS.md")).toBe(true);
        expect(isInstructionFilePath("src/rendering.ts")).toBe(false);

        expect(
            formatReadAction(tokenTheme, { path: "/home/me/.pi/agent/skills/typescript/SKILL.md" }),
        ).toBe(
            "<toolTitle>Read</toolTitle> <customMessageLabel>/home/me/.pi/agent/skills/typescript/SKILL.md</customMessageLabel>",
        );
        expect(formatReadAction(tokenTheme, { path: "src/AGENTS.md", offset: 1, limit: 2 })).toBe(
            "<toolTitle>Read</toolTitle> <customMessageLabel>src/AGENTS.md</customMessageLabel><muted>:1-2</muted>",
        );
        expect(formatReadAction(tokenTheme, { path: "src/rendering.ts" })).toBe(
            "<toolTitle>Read</toolTitle> <accent>src/rendering.ts</accent>",
        );
    });

    it("parses built-in Pi diff strings into sections", () => {
        const sections = parseDiffSections(" 1 before\n-2 old\n+2 new", "src/file.ts");

        expect(sections).toEqual([
            {
                path: "src/file.ts",
                lines: [" 1 before", "-2 old", "+2 new"],
                added: 1,
                removed: 1,
            },
        ]);
    });

    it("caches rendered component lines until invalidated", () => {
        let renderCount = 0;
        const component = makeComponent((width) => {
            renderCount += 1;
            return [`width ${width}`];
        });

        expect(component.render(80)).toEqual(["width 80"]);
        expect(component.render(80)).toEqual(["width 80"]);
        expect(renderCount).toBe(1);

        component.invalidate();
        expect(component.render(80)).toEqual(["width 80"]);
        expect(renderCount).toBe(2);
    });

    it("renders an incomplete streaming tool call without crashing", () => {
        const component = renderCodexCall(plainTheme, {
            state: "running",
            statusText: "Run",
        });

        expect(component.render(12)).toEqual(["• Run "]);
    });

    it("marks collapsed call previews as truncated instead of expandable", () => {
        const component = renderCodexCall(plainTheme, {
            state: "success",
            statusText: "Called",
            body: Array.from({ length: 8 }, (_value, index) => `line ${index + 1}`).join("\n"),
            maxRenderedLines: 3,
        });

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("… +5 lines (truncated)");
        expect(rendered).not.toContain("to expand");
    });

    it("wraps single-line collapsed call previews without truncating them", () => {
        const component = renderCodexCall(plainTheme, {
            state: "success",
            statusText: "Bash",
            body: "npm run format -- alpha beta gamma delta epsilon zeta eta theta",
            maxRenderedLines: 3,
        });

        const lines = component.render(28);
        const rendered = lines.join("\n");

        expect(lines.length).toBeGreaterThan(3);
        expectLinesWithinWidth(lines, 28);
        expect(rendered).toContain("theta");
        expect(rendered).not.toContain("…");
    });

    it("collapses output to a Codex-sized head and tail preview", () => {
        const component = renderCodexOutput(
            plainTheme,
            ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"].join(
                "\n",
            ),
            {
                expanded: false,
                maxPreviewLines: 5,
                omittedHint: "hint",
            },
        );

        expect(component.render(80)).toEqual([
            "  └ one",
            "    two",
            "    … +6 lines (hint)",
            "    nine",
            "    ten",
        ]);
    });

    it("skips hidden collapsed output without building hidden preview lines", () => {
        const component = renderCodexOutput(plainTheme, "line\n".repeat(100_000), {
            expanded: false,
            mode: "hidden",
            noOutputLabel: null,
        });

        expect(component.render(80)).toEqual([]);
    });

    it("trims trailing blank output lines", () => {
        const component = renderCodexOutput(plainTheme, "done\n\n\n", {
            expanded: true,
            maxPreviewLines: 5,
        });

        expect(component.render(80)).toEqual(["  └ done"]);
    });

    it("starts prefixed output with content after leading blank lines", () => {
        const component = renderCodexOutput(
            plainTheme,
            "\n> pi-codex-look@0.1.0 typecheck\n> tsc --noEmit\n",
            {
                expanded: true,
                maxPreviewLines: 5,
            },
        );

        expect(component.render(80)).toEqual([
            "  └ > pi-codex-look@0.1.0 typecheck",
            "    > tsc --noEmit",
        ]);
    });

    it("keeps collapsed output compact when the raw tail is blank", () => {
        const component = renderCodexOutput(
            plainTheme,
            [
                "start",
                ...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`),
                "Command exited with code 2",
                "",
                "",
                "",
            ].join("\n"),
            {
                expanded: false,
                maxPreviewLines: 5,
                omittedHint: "hint",
            },
        );

        expect(component.render(80)).toEqual([
            "  └ start",
            "    line 1",
            "    … +18 lines (hint)",
            "    line 20",
            "    Command exited with code 2",
        ]);
    });

    it("wraps long output lines in compact and expanded views", () => {
        const longLine =
            "oxfmt . packages/pi-ui-tweaks/src/index.ts packages/pi-ui-tweaks/test/index.test.ts packages/pi-ui-tweaks/README.md";

        for (const expanded of [false, true]) {
            const component = renderCodexOutput(plainTheme, [longLine, "done"].join("\n"), {
                expanded,
                maxPreviewLines: 5,
            });

            const lines = component.render(44);
            const rendered = lines.join("\n");

            expect(lines.length).toBeGreaterThan(2);
            expectLinesWithinWidth(lines, 44);
            expect(rendered).toContain("README.md");
            expect(rendered).not.toContain("…");
            expect(lines[lines.length - 1]).toBe("    done");
        }
    });

    it("keeps collapsed output compact without rendering middle lines", () => {
        const component = renderCodexOutput(
            plainTheme,
            [
                "start",
                ...Array.from({ length: 2_000 }, (_value, index) => `middle ${index + 1}`),
                "end",
            ].join("\n"),
            {
                expanded: false,
                maxPreviewLines: 5,
                omittedHint: "hint",
            },
        );

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("start");
        expect(rendered).toContain("middle 1");
        expect(rendered).toContain("… +1998 lines (hint)");
        expect(rendered).toContain("middle 2000");
        expect(rendered).toContain("end");
        expect(rendered).not.toContain("middle 1000");
    });

    it("keeps collapsed output compact across huge internal blank runs", () => {
        const component = renderCodexOutput(plainTheme, `start${"\n".repeat(2_000)}end`, {
            expanded: false,
            maxPreviewLines: 5,
            omittedHint: "hint",
        });

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("start");
        expect(rendered).toContain("… +1997 lines (hint)");
        expect(rendered).toContain("end");
    });

    it("keeps hidden collapsed output previews hidden without treating output as empty", () => {
        const component = renderCodexOutput(plainTheme, "secret\noutput", {
            expanded: false,
            mode: "hidden",
            maxPreviewLines: 5,
        });

        expect(component.render(100)).toEqual([]);
    });

    it("keeps collapsed output compact when one raw line wraps many rows", () => {
        const hugeLine = `rollout.jsonl:648:${JSON.stringify({
            timestamp: "2026-05-03T12:52:02.179Z",
            payload: {
                command: "cat > /tmp/game.ts <<'EOF'\\n" + "const value = 1;\\n".repeat(200),
            },
        })}`;
        const component = renderCodexOutput(plainTheme, [hugeLine, "done"].join("\n"), {
            expanded: false,
            maxPreviewLines: 5,
            omittedHint: "hint",
        });

        const lines = component.render(80);
        const rendered = lines.join("\n");

        expect(lines.length).toBeLessThanOrEqual(5);
        expectLinesWithinWidth(lines, 80);
        expect(rendered).toContain("rollout.jsonl:648");
        expect(rendered).toContain("… +");
        expect(rendered).toContain("rows (hint)");
    });

    it("strips shell wrappers before command highlighting", () => {
        expect(highlightShell(plainTheme, "bash -lc 'npm run check'")).toBe("npm run check");
    });

    it("parses partial heredoc scripts before the closing marker arrives", () => {
        expect(parseScriptInvocation("python - <<'PY'\nprint('hi')")).toEqual({
            label: "Python",
            language: "python",
            code: "print('hi')",
        });
    });

    it("parses heredoc scripts with trailing command args after the marker", () => {
        expect(
            parseScriptInvocation(
                "python - <<'PY' \"$target\"\nimport sys\nprint(sys.argv[1])\nPY",
            ),
        ).toEqual({
            label: "Python",
            language: "python",
            code: "import sys\nprint(sys.argv[1])",
        });
    });

    it("does not parse heredocs with chained commands after the marker", () => {
        expect(
            parseScriptInvocation("python - <<'PY' && rm -f tmp/demo.py\nprint('hi')\nPY"),
        ).toBeUndefined();
    });

    it("rejects partial heredocs once a closing marker line appears before trailing shell", () => {
        expect(
            parseScriptInvocation(
                [
                    "python - <<'PY'",
                    ...Array.from({ length: 1_000 }, (_value, index) => `print(${index})`),
                    "PY",
                    "rm -f tmp/demo.py",
                ].join("\n"),
            ),
        ).toBeUndefined();
    });

    it("does not parse completed heredocs with trailing shell commands as executable blocks", () => {
        expect(
            parseScriptInvocation("python - <<'PY'\nprint('hi')\nPY\nrm -f tmp/demo.py"),
        ).toBeUndefined();
    });

    it("parses node eval scripts as executable language blocks", () => {
        expect(
            parseScriptInvocation(
                `node -e "console.log(require.resolve('@earendil-works/pi-coding-agent'))"`,
            ),
        ).toEqual({
            label: "Node",
            language: "javascript",
            code: "console.log(require.resolve('@earendil-works/pi-coding-agent'))",
        });
    });

    it("parses shell-wrapped node eval scripts as executable language blocks", () => {
        expect(parseScriptInvocation(`bash -lc 'node --eval="console.log(1)"'`)).toEqual({
            label: "Node",
            language: "javascript",
            code: "console.log(1)",
        });
    });

    it("does not render flag-like node arguments as inline script code", () => {
        expect(
            parseScriptInvocation(`node -e -N "$59:@99.%141" 120x35 cursor=0,22`),
        ).toBeUndefined();
    });

    it("parses python command scripts as executable language blocks", () => {
        expect(parseScriptInvocation(`python -c "print('hi')"`)).toEqual({
            label: "Python",
            language: "python",
            code: "print('hi')",
        });
    });

    it("does not parse inline scripts with trailing shell commands as executable blocks", () => {
        expect(
            parseScriptInvocation(`python -c "print('hi')" && rm -f tmp/demo.py`),
        ).toBeUndefined();
    });

    it("renders heredoc scripts as executable language blocks", () => {
        const invocation = parseScriptInvocation("python - <<'PY'\nprint('hi')\nPY");

        expect(invocation).toEqual({
            label: "Python",
            language: "python",
            code: "print('hi')",
        });
        if (!invocation) {
            throw new Error("expected script invocation");
        }

        const component = renderScriptCall(plainTheme, invocation, {
            state: "success",
            expanded: false,
        });
        const text = component.render(80).join("\n");

        expect(text).toContain("Python");
        expect(text).toContain("print");
        expect(text).not.toContain("<<'PY'");
    });

    it("renders script previews inline by default when the first line fits", () => {
        const component = renderScriptCall(
            plainTheme,
            { label: "Python", language: "python", code: "print('hi')\nprint('bye')" },
            { state: "success", expanded: false },
        );

        const lines = component.render(100);

        expect(lines[0]).toContain("• Python print('hi')");
        expect(lines[1]).toContain("  │ print('bye')");
    });

    it("renders non-bash script previews with block headers when the first line does not fit", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Python",
                language: "python",
                code: "root=Path.home()/'.pi/agent/debug-runs/live-session-with-a-long-name'\nrows=[]",
            },
            { state: "success", expanded: false },
        );

        const lines = component.render(48);

        expect(lines[0]).toBe("• Python");
        expect(lines[1]).toContain("  │ root=Path.home()");
        expect(lines.some((line) => line.includes("  │ rows=[]"))).toBe(true);
    });

    it("renders long non-bash auto script previews as blocks", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Python",
                language: "python",
                code: [
                    "p=Path('Home/.local/share/browser-bookmarks/helium/Bookmarks.json')",
                    "data=json.loads(p.read_text())",
                    "for key in ['version','checksum']:",
                    "    print(key, data.get(key))",
                    "print(data.keys())",
                ].join("\n"),
            },
            { state: "success", expanded: false },
        );

        const lines = component.render(120);

        expect(lines[0]).toBe("• Python");
        expect(lines[1]).toContain("  │ p=Path");
        expect(lines[1]).not.toContain("• Python p=Path");
    });

    it("keeps bash script previews inline by default", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Bash",
                language: "bash",
                code: "printf 'config: '; if [ -f \"$HOME/.pi/agent/pi-debug/config.json\" ]; then echo ok; fi",
            },
            { state: "success", expanded: false },
        );

        const lines = component.render(48);

        expect(lines[0]).toContain("• Bash printf");
        expect(lines[1]).toContain("  │   ");
        expect(lines[1]).not.toContain("↳");
    });

    it("renders inline script previews when configured", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Node",
                language: "javascript",
                code: "const first = 1;\nconsole.log(first);",
            },
            { state: "success", expanded: false, headerLayout: "inline" },
        );

        const lines = component.render(100);

        expect(lines[0]).toContain("• Node const first = 1;");
        expect(lines[1]).toContain("  │ console.log(first);");
    });

    it("indents wrapped script preview continuations without a glyph marker", () => {
        const code =
            "markers = {'pyproject.toml','setup.py','setup.cfg','requirements.txt','Pipfile','poetry.lock','uv.lock','tox.ini'}";
        const component = renderScriptCall(
            plainTheme,
            { label: "Python", language: "python", code },
            { state: "success", expanded: false },
        );

        const lines = component.render(48);

        expectLinesWithinWidth(lines, 48);
        expect(lines.some((line) => line.includes("markers ="))).toBe(true);
        expect(lines.some((line) => line.includes("│ ↳"))).toBe(false);
        expect(lines.some((line) => line.includes("│   {'pyproject"))).toBe(true);
        expect(lines.some((line) => line.includes("│ {'pyproject"))).toBe(false);
    });

    it("renders already-formatted script previews without render-time formatting", () => {
        const component = renderScriptCall(
            plainTheme,
            { label: "Python", language: "python", code: "print(2)" },
            { state: "success", expanded: false },
        );

        const rendered = component.render(80).join("\n");

        expect(rendered).toContain("print(2)");
        expect(rendered).not.toContain("print(1)");
    });

    it("renders script output with an arrow prefix", () => {
        const component = renderCodexOutput(
            plainTheme,
            "import index ms 470 function\ninit syntax ms 152",
            {
                expanded: false,
                prefixFirst: "  → ",
                prefixRest: "    ",
            },
        );

        expect(component.render(100)).toEqual([
            "  → import index ms 470 function",
            "    init syntax ms 152",
        ]);
    });

    it("hides leading import blocks in collapsed previews", () => {
        const invocation = parseScriptInvocation(
            "python - <<'PY'\nfrom __future__ import annotations\nimport ast\nfrom pathlib import Path\n\nroot = Path('.')\nprint(root)\nprint(ast)\nprint('done')\nPY",
        );
        if (!invocation) {
            throw new Error("expected script invocation");
        }

        const collapsed = renderScriptCall(plainTheme, invocation, {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 5,
        })
            .render(120)
            .join("\n");
        const expanded = renderScriptCall(plainTheme, invocation, {
            state: "success",
            expanded: true,
            maxCodePreviewLines: 5,
        })
            .render(120)
            .join("\n");

        expect(collapsed).toContain("root");
        expect(collapsed).not.toContain("pathlib");
        expect(expanded).toContain("pathlib");
    });

    it("keeps huge collapsed script previews compact", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Python",
                language: "python",
                code: Array.from({ length: 2_000 }, (_value, index) => `print(${index + 1})`).join(
                    "\n",
                ),
            },
            { state: "success", expanded: false, maxCodePreviewLines: 5 },
        );

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("print(1)");
        expect(rendered).toContain("print(4)");
        expect(rendered).toContain("… +1996 lines (truncated)");
        expect(rendered).not.toContain("print(1000)");
    });

    it("marks collapsed script call previews as truncated instead of expandable", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Python",
                language: "python",
                code: Array.from({ length: 12 }, (_value, index) => `print(${index + 1})`).join(
                    "\n",
                ),
            },
            { state: "success", expanded: false, maxCodePreviewLines: 5 },
        );

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("… +8 lines (truncated)");
        expect(rendered).not.toContain("to expand");
    });

    it("hides leading imports in collapsed previews when the remaining script fits", () => {
        const invocation = parseScriptInvocation(
            "python - <<'PY'\nimport ast\nfrom pathlib import Path\n\nprint(Path('.'))\nPY",
        );
        if (!invocation) {
            throw new Error("expected script invocation");
        }

        const collapsed = renderScriptCall(plainTheme, invocation, {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
        })
            .render(120)
            .join("\n");

        expect(collapsed).not.toContain("import ast");
        expect(collapsed).not.toContain("pathlib");
        expect(collapsed).toContain("print");
    });

    it("keeps output renderer lines within the supplied width", () => {
        const component = renderCodexOutput(plainTheme, "alpha beta gamma delta epsilon", {
            expanded: true,
            dimContent: false,
        });

        const lines = component.render(12);

        expect(lines.length).toBeGreaterThan(1);
        expectLinesWithinWidth(lines, 12);
    });

    it("hides fallback diff edge ellipses but keeps middle ellipses", () => {
        const sections = parseDiffSections(
            "   ...\n+10 first\n   ...\n+90 second\n   ...",
            "file.ts",
        );

        expect(sections[0]?.lines).toEqual(["+10 first", "   ...", "+90 second"]);
    });

    it("fills fallback diff added blank lines with the insertion background", () => {
        const sections = parseDiffSections(
            "+1 from pathlib import Path\n+2 \n+3 def greet():",
            "file.py",
        );
        const lines = renderCodexDiff(plainTheme, sections, false).render(80);
        const blankAddition = lines.find((line) => line.trimEnd() === "    2 +");

        expect(blankAddition).toBeDefined();
        expect(visibleWidth(blankAddition ?? "")).toBe(79);
        expect(lines).not.toContain("");
        expect(lines[lines.findIndex((line) => line.trimEnd() === "    2 +") + 1]?.trimEnd()).toBe(
            "    3 +def greet():",
        );
    });

    it("dims fallback diff line numbers for inserted and deleted rows", () => {
        const sections = parseDiffSections("-1 old\n+2 new", "file.ts");
        const rendered = renderCodexDiff(tokenTheme, sections, true).render(120).join("\n");

        expect(rendered).toContain("<dim>1 </dim><toolDiffRemoved>-</toolDiffRemoved>");
        expect(rendered).toContain("<dim>2 </dim><toolDiffAdded>+</toolDiffAdded>");
    });

    it("keeps diff renderer lines short of the terminal edge", () => {
        const sections = parseDiffSections(
            "-1 old text that wraps\n+1 new text that wraps",
            "file.ts",
        );
        const component = renderCodexDiff(plainTheme, sections, true);

        const width = 14;
        const lines = component.render(width);

        expect(lines.length).toBeGreaterThan(1);
        expectLinesWithinWidth(lines, width);
        expect(lines.every((line) => visibleWidth(line) < width)).toBe(true);
    });

    it("caps wrapped diff rows in collapsed previews", () => {
        const sections = parseDiffSections(
            `-1 ${"x".repeat(1_000)}\n+1 ${"y".repeat(1_000)}`,
            "file.ts",
        );
        const component = renderCodexDiff(plainTheme, sections, false);

        const lines = component.render(20);

        expect(lines.length).toBeLessThanOrEqual(8);
        expectLinesWithinWidth(lines, 20);
        expect(lines.every((line) => visibleWidth(line) < 20)).toBe(true);
    });
});
