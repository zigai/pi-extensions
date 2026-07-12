import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
    collapseHome,
    configureRenderingAppearance,
    configureToolCallIndicator,
    formatGrepAction,
    formatReadAction,
    highlightShell,
    isInstructionFilePath,
    isPartialInstructionFilePath,
    makeComponent,
    parseDiffSections,
    parseScriptInvocation,
    renderCodexCall,
    renderCodexDiff,
    renderCodexOutput,
    renderMutationCall,
    renderScriptCall,
    type CodexRenderTheme,
} from "../src/rendering/core.ts";

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

    it("applies configured instruction and diff colors", () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "full-row",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: "#123456",
            deletedRowBackground: "#654321",
            instructionPathColor: "#AABBCC",
            dimUnchangedDiffText: false,
        });
        try {
            const read = formatReadAction(plainTheme, { path: "src/AGENTS.md" });
            const diff = renderCodexDiff(
                plainTheme,
                [{ lines: ["+1 added", "-2 deleted"], added: 1, removed: 1 }],
                true,
            ).render(40);

            expect(read).toContain("\u001b[38;2;170;187;204m");
            expect(diff[0]).toContain("\u001b[48;2;18;52;86m");
            expect(diff[1]).toContain("\u001b[48;2;101;67;33m");
        } finally {
            configureRenderingAppearance({
                diffBackgroundStyle: "changed-spans",
                narrowDiffLayout: "paired",
                sideBySideLayout: "content-aware",
                addedRowBackground: null,
                deletedRowBackground: null,
                instructionPathColor: null,
                dimUnchangedDiffText: false,
            });
        }
    });

    it("does not flash the ordinary path accent while instruction paths stream", () => {
        expect(isPartialInstructionFilePath("/home/me/.pi/agent/skills/typescript")).toBe(true);
        expect(
            isPartialInstructionFilePath(
                "/home/me/.pi/agent/npm/node_modules/pi-autoresearch/skills/autoresearch-create",
            ),
        ).toBe(true);
        expect(isPartialInstructionFilePath("src/AGENTS.")).toBe(true);
        expect(isPartialInstructionFilePath("src/rendering")).toBe(false);

        expect(
            formatReadAction(
                tokenTheme,
                { path: "/home/me/.pi/agent/skills/typescript" },
                { isPartial: true },
            ),
        ).toContain(
            "<customMessageLabel>/home/me/.pi/agent/skills/typescript</customMessageLabel>",
        );
        expect(
            formatReadAction(tokenTheme, { path: "/home/me/.pi/agent/sk" }, { isPartial: true }),
        ).toContain("<muted>/home/me/.pi/agent/sk</muted>");
        expect(
            formatReadAction(tokenTheme, { path: "src/rendering" }, { isPartial: true }),
        ).toContain("<muted>src/rendering</muted>");
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

    it("does not cache oversized rendered component lines", () => {
        let renderCount = 0;
        const component = makeComponent(() => {
            renderCount += 1;
            return Array.from({ length: 301 }, (_value, index) => `line ${index + 1}`);
        });

        expect(component.render(80).length).toBe(301);
        expect(component.render(80).length).toBe(301);
        expect(renderCount).toBe(2);
    });

    it("renders an incomplete streaming tool call without crashing", () => {
        const component = renderCodexCall(plainTheme, {
            state: "running",
            statusText: "Run",
        });

        expect(component.render(12)).toEqual(["• Run "]);
    });

    it("renders tool indicators in bold consistently by default", () => {
        const styledTheme: CodexRenderTheme = {
            ...tokenTheme,
            bold(text: string): string {
                return `<bold>${text}</bold>`;
            },
        };

        expect(
            renderCodexCall(styledTheme, {
                state: "success",
                statusText: "Bash",
            }).render(80)[0],
        ).toContain("<success><bold>•</bold></success>");
        expect(
            renderCodexCall(styledTheme, {
                state: "error",
                statusText: "Bash",
            }).render(80)[0],
        ).toContain("<toolDiffRemoved><bold>•</bold></toolDiffRemoved>");
        expect(
            renderCodexCall(styledTheme, {
                state: "running",
                statusText: "Bash",
            }).render(80)[0],
        ).toContain("<muted><bold>•</bold></muted>");
        expect(
            renderCodexCall(styledTheme, {
                state: "muted",
                statusText: "Explore",
            }).render(80)[0],
        ).toContain("<dim><bold>•</bold></dim>");
    });

    it("uses the configured tool indicator symbol and weight", () => {
        const styledTheme: CodexRenderTheme = {
            ...tokenTheme,
            bold(text: string): string {
                return `<bold>${text}</bold>`;
            },
        };

        configureToolCallIndicator({ symbol: "*", bold: false });
        try {
            const rendered = renderCodexCall(styledTheme, {
                state: "success",
                statusText: "Bash",
            }).render(80)[0];

            expect(rendered).toContain("<success>*</success>");
            expect(rendered).not.toContain("<success><bold>*</bold></success>");
        } finally {
            configureToolCallIndicator({ symbol: "•", bold: true });
        }
    });

    it("pads mutation labels only when a label column width is provided", () => {
        const summary = { label: "Wrote", path: "src/example.ts", added: 1, removed: 0 };

        expect(renderMutationCall(plainTheme, summary).render(80)[0]).toContain(
            "Wrote src/example.ts (+1)",
        );
        expect(
            renderMutationCall(plainTheme, summary, { labelColumnWidth: 7 }).render(80)[0],
        ).toContain("Wrote   src/example.ts (+1)");
    });

    it("renders mutation state and aligned statistics", () => {
        const styledTheme: CodexRenderTheme = {
            ...tokenTheme,
            bold(text: string): string {
                return `<bold>${text}</bold>`;
            },
        };
        const rendered = renderMutationCall(
            styledTheme,
            { label: "Wrote", path: "file.ts", added: 3, removed: 12 },
            { state: "success", statDigitWidth: 2 },
        ).render(300)[0];

        expect(rendered).toContain("<success><bold>•</bold></success>");
        expect(rendered).toContain("+ 3");
        expect(rendered).toContain("-12");
    });

    it("collapses home paths only at a path boundary", () => {
        const previousHome = process.env.HOME;
        process.env.HOME = "/home/user";
        try {
            expect(collapseHome("/home/user/file.ts")).toBe("~/file.ts");
            expect(collapseHome("/home/user2/file.ts")).toBe("/home/user2/file.ts");
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
        }
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
            "    three",
            "    nine",
            "    ten",
            "    … +5 lines (hint)",
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
            "    line 2",
            "    line 20",
            "    Command exited with code 2",
            "    … +17 lines (hint)",
        ]);
    });

    it("does not render carriage-return progress updates as blank tail rows", () => {
        const component = renderCodexOutput(
            plainTheme,
            [
                "WARNING Disk /var/lib/libvirt/images/vm.qcow2 is already in use.",
                ...Array.from({ length: 12 }, (_value, index) => `setup line ${index + 1}`),
                "\rCreating domain...                                      |      00:00",
            ].join("\n"),
            {
                expanded: false,
                maxPreviewLines: 5,
                omittedHint: "hint",
            },
        );

        const lines = component.render(100);

        expect(lines).toContain(
            "    Creating domain...                                      |      00:00",
        );
        expect(lines).not.toContain("    ");
    });

    it("drops bash status separator blanks before command exit lines", () => {
        const component = renderCodexOutput(
            plainTheme,
            "python3: can't open file '/home/zigai/Projects/pi-codex-look/packages.py': [Errno 2] No such file or directory\n\n\nCommand exited with code 2",
            {
                expanded: false,
                maxPreviewLines: 5,
            },
        );

        expect(component.render(140)).toEqual([
            "  └ python3: can't open file '/home/zigai/Projects/pi-codex-look/packages.py': [Errno 2] No such file or directory",
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
        expect(rendered).toContain("… +1997 lines (hint)");
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
        expect(rendered).toContain("… +1996 lines (hint)");
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

    it("uses one truncation marker when one raw line wraps many rows", () => {
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

        expect(lines.length).toBeLessThanOrEqual(6);
        expectLinesWithinWidth(lines, 80);
        expect(rendered).toContain("rollout.jsonl:648");
        expect(rendered).toContain("… preview truncated (hint)");
        expect(rendered).toContain("done");
        expect(rendered).not.toContain("rows (hint)");
    });

    it("does not add a row marker to an already truncated output preview", () => {
        const long = "wrapped ".repeat(40);
        const component = renderCodexOutput(
            plainTheme,
            [
                `first ${long}`,
                `second ${long}`,
                ...Array.from({ length: 95 }, (_value, index) => `middle ${index + 1}`),
                `penultimate ${long}`,
                "last",
            ].join("\n"),
            {
                expanded: false,
                maxPreviewLines: 5,
                omittedHint: "hint",
            },
        );

        const rendered = component.render(80).join("\n");

        expect(rendered.match(/… \+94 lines \(hint\)/gu)).toHaveLength(1);
        expect(rendered).toContain("first wrapped");
        expect(rendered).toContain("last");
        expect(rendered).not.toContain("rows (hint)");
    });

    it("strips shell wrappers before command highlighting", () => {
        expect(highlightShell(plainTheme, "bash -lc 'npm run check'")).toBe("npm run check");
    });

    it("renders bash previews with lightweight syntax without red or accent floods", () => {
        const command =
            'set -euo pipefail\nsource /tmp/pi-tweaks-live-tui-demo.zLtsoL/env.sh\n# Ensure a clean input before demo 1.\ntmux send-keys -t "$target" C-u\nfind . -maxdepth 3 -name package.json | head -80';
        const rendered = renderScriptCall(
            tokenTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "success", expanded: false },
        )
            .render(220)
            .join("\n");

        expect(rendered).toContain("<syntaxFunction>set</syntaxFunction>");
        expect(rendered).toContain("<syntaxFunction>find</syntaxFunction>");
        expect(rendered).toContain("<toolTitle>pipefail</toolTitle>");
        expect(rendered).toContain(
            "<toolTitle>/tmp/pi-tweaks-live-tui-demo.zLtsoL/env.sh</toolTitle>",
        );
        expect(rendered).toContain("<dim># Ensure a clean input before demo 1.</dim>");
        expect(rendered).toContain('<syntaxString>"$target"</syntaxString>');
        expect(rendered).not.toContain("<syntaxFunction></syntaxFunction>");
        expect(rendered).toContain("<syntaxKeyword>-maxdepth</syntaxKeyword>");
        expect(rendered).toContain("<syntaxKeyword>-name</syntaxKeyword>");
        expect(rendered).toContain("<syntaxKeyword>-80</syntaxKeyword>");
        expect(rendered).toContain("<toolTitle>3</toolTitle>");
        expect(rendered).toContain("<toolTitle>package.json</toolTitle>");
        expect(rendered).not.toContain("<accent>");
        expect(rendered).not.toContain("<toolOutput></toolOutput>");
        expect(rendered).not.toContain("<toolDiffRemoved>-maxdepth</toolDiffRemoved>");
        expect(rendered).not.toContain("<toolDiffRemoved>-name</toolDiffRemoved>");
    });

    it("classifies shell subcommands, full flags, and string operands", () => {
        const command =
            "python3 packages.py validate --os fedora && rsync -az Packages/manifests/vps.toml vps.01:~/Projects/config/Packages/manifests/vps.toml";
        const rendered = renderScriptCall(
            tokenTheme,
            { label: "Bash", language: "bash", code: command },
            { state: "error", expanded: false },
        )
            .render(240)
            .join("\n");

        expect(rendered).toContain("<syntaxFunction>python3</syntaxFunction>");
        expect(rendered).toContain("<toolTitle>packages.py</toolTitle>");
        expect(rendered).toContain("<syntaxFunction>validate</syntaxFunction>");
        expect(rendered).toContain("<syntaxKeyword>--os</syntaxKeyword>");
        expect(rendered).toContain("<toolTitle>fedora</toolTitle>");
        expect(rendered).toContain("<syntaxFunction>rsync</syntaxFunction>");
        expect(rendered).toContain("<syntaxKeyword>-az</syntaxKeyword>");
        expect(rendered).toContain("<toolTitle>Packages/manifests/vps.toml</toolTitle>");
        expect(rendered).toContain(
            "<toolTitle>vps.01:~/Projects/config/Packages/manifests/vps.toml</toolTitle>",
        );
        expect(rendered).not.toContain("<dim>--</dim>");
        expect(rendered).not.toContain("<dim>-</dim><syntaxOperator>az</syntaxOperator>");
        expect(rendered).not.toContain("<toolOutput>fedora</toolOutput>");
        expect(rendered).not.toContain("<syntaxString>fedora</syntaxString>");
        expect(rendered).not.toContain("<toolDiffRemoved>os</toolDiffRemoved>");
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

    it("does not treat space-indented heredoc markers as ordinary closing delimiters", () => {
        expect(parseScriptInvocation("python - <<'PY'\nprint('hi')\n  PY")).toEqual({
            label: "Python",
            language: "python",
            code: "print('hi')\n  PY",
        });
    });

    it("treats only leading tabs as stripped heredoc delimiter indentation", () => {
        expect(parseScriptInvocation("python - <<-'PY'\nprint('hi')\n\tPY")).toEqual({
            label: "Python",
            language: "python",
            code: "print('hi')",
        });
        expect(parseScriptInvocation("python - <<-'PY'\nprint('hi')\n  PY")).toEqual({
            label: "Python",
            language: "python",
            code: "print('hi')\n  PY",
        });
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

    it("renders single-line script previews inline by default", () => {
        const component = renderScriptCall(
            plainTheme,
            { label: "Python", language: "python", code: "print('hi')" },
            { state: "success", expanded: false },
        );

        const lines = component.render(100);

        expect(lines[0]).toContain("• Python print('hi')");
        expect(lines.length).toBe(1);
    });

    it("renders multiline script previews with block headers by default", () => {
        const scripts = [
            { label: "Bash", language: "bash", code: "sleep 300\necho done" },
            { label: "Python", language: "python", code: "print('hi')\nprint('bye')" },
        ];

        for (const script of scripts) {
            const component = renderScriptCall(plainTheme, script, {
                state: "success",
                expanded: false,
            });

            const lines = component.render(100);

            expect(lines[0]).toBe(`• ${script.label}`);
            expect(lines[1]).toContain(`  │ ${script.code.split("\n")[0]}`);
        }
    });

    it("renders non-bash multiline script previews with block headers", () => {
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

    it("keeps single-line bash script previews inline by default", () => {
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

    it("does not truncate four-line collapsed script previews", () => {
        const component = renderScriptCall(
            plainTheme,
            {
                label: "Bash",
                language: "bash",
                code: ["line 1", "line 2", "line 3", "line 4"].join("\n"),
            },
            { state: "success", expanded: false, maxCodePreviewLines: 4 },
        );

        const rendered = component.render(100).join("\n");

        expect(rendered).toContain("line 1");
        expect(rendered).toContain("line 4");
        expect(rendered).not.toContain("…");
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
        expect(rendered).toContain("print(5)");
        expect(rendered).toContain("… +1995 lines (truncated)");
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

        expect(rendered).toContain("… +7 lines (truncated)");
        expect(rendered).not.toContain("to expand");
    });

    it("keeps Python imports when the complete short script fits", () => {
        const invocation = parseScriptInvocation(
            "python - <<'PY'\nimport ast\nfrom pathlib import Path\n\nprint(Path('.'))\nPY",
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

        expect(collapsed).toContain("import ast");
        expect(collapsed).toContain("pathlib");
        expect(collapsed).toContain("print");
    });

    it("keeps Node imports when the complete short script fits", () => {
        const invocation = parseScriptInvocation(
            "node - <<'NODE'\nimport path from 'node:path';\nconst fs = require('node:fs');\nconsole.log(path.basename(fs.realpathSync('.')));\nNODE",
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

        expect(collapsed).toContain("import path");
        expect(collapsed).toContain("require('node:fs')");
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

    it("keeps fallback blank changed rows without adding padding rows", () => {
        const sections = parseDiffSections(
            "+1 from pathlib import Path\n+2 \n+3 def greet():",
            "file.py",
        );
        const lines = renderCodexDiff(plainTheme, sections, false).render(80);
        const blankAddition = lines.find((line) => line.trimEnd() === "    2 +");

        expect(blankAddition).toBeDefined();
        expect(lines).not.toContain("");
        expect(lines[lines.findIndex((line) => line.trimEnd() === "    2 +") + 1]?.trimEnd()).toBe(
            "    3 +def greet():",
        );
    });

    it("paints only changed spans while preserving unchanged syntax", () => {
        const backgroundTheme: CodexRenderTheme = {
            ...plainTheme,
            bg(token, text) {
                return `${token === "toolSuccessBg" ? "\u001b[42m" : "\u001b[41m"}${text}\u001b[49m`;
            },
        };
        const sections = parseDiffSections(
            "-1 const limit = args.limit ?? 2000;\n+1 const limit = args.limit ?? 4000;",
            "file.ts",
        );
        const rendered = renderCodexDiff(backgroundTheme, sections, true).render(80).join("\n");

        expect(rendered).toContain("\u001b[41m2000\u001b[49m");
        expect(rendered).toContain("\u001b[42m4000\u001b[49m");
        expect(rendered).not.toContain("\u001b[41m    1 -");
        expect(rendered).not.toContain("\u001b[42m    1 +");
        expect(rendered).toContain("const limit = args.limit ??");
    });

    it("omits a replacement side with no changed content", () => {
        const lines = renderCodexDiff(
            plainTheme,
            [
                {
                    path: "apps/coordinator/src/scheduler.ts",
                    lines: [
                        '-377         const tag = Reflect.get(failure, "_tag");',
                        '+377         const tag: unknown = Reflect.get(failure, "_tag");',
                    ],
                    added: 1,
                    removed: 1,
                },
            ],
            true,
        )
            .render(100)
            .map((line) => line.trimEnd());

        expect(lines).toEqual([
            '    377 +        const tag: unknown = Reflect.get(failure, "_tag");',
        ]);
    });

    it("keeps full-row diff backgrounds as an option", () => {
        configureRenderingAppearance({
            diffBackgroundStyle: "full-row",
            narrowDiffLayout: "paired",
            sideBySideLayout: "content-aware",
            addedRowBackground: null,
            deletedRowBackground: null,
            instructionPathColor: null,
            dimUnchangedDiffText: false,
        });
        try {
            const backgroundTheme: CodexRenderTheme = {
                ...plainTheme,
                bg(token, text) {
                    return `${token === "toolSuccessBg" ? "\u001b[42m" : "\u001b[41m"}${text}\u001b[49m`;
                },
            };
            const sections = parseDiffSections("-1 old\n 1 unchanged\n+2 new", "file.ts");
            const renderedLines = renderCodexDiff(backgroundTheme, sections, true).render(80);
            const rendered = renderedLines.join("\n");

            expect(rendered).toContain("\u001b[42m    2 +new");
            expect(rendered).toContain("\u001b[41m    1 -old");
            expect(rendered).toContain("    1  unchanged");
            expect(rendered).not.toContain("\u001b[42m    1  unchanged");
            expect(rendered).not.toContain("\u001b[41m    1  unchanged");
            expect(
                renderedLines
                    .filter((line) => line.includes("\u001b[4"))
                    .every((line) => visibleWidth(line) === 79),
            ).toBe(true);
        } finally {
            configureRenderingAppearance({
                diffBackgroundStyle: "changed-spans",
                narrowDiffLayout: "paired",
                sideBySideLayout: "content-aware",
                addedRowBackground: null,
                deletedRowBackground: null,
                instructionPathColor: null,
                dimUnchangedDiffText: false,
            });
        }
    });

    it("renders partial diff omission metadata without a code gutter", () => {
        const lines = renderCodexDiff(
            plainTheme,
            [
                {
                    path: "file.ts",
                    lines: ["  … +12 earlier patch lines", "+13 export const value = 13;"],
                    added: 13,
                    removed: 0,
                },
            ],
            true,
        ).render(100);

        expect(lines[0]).toBe("    … +12 earlier patch lines");
        expect(lines[1]).toContain("13 +export const value = 13;");
    });

    it("dims fallback diff line numbers for inserted and deleted rows", () => {
        const sections = parseDiffSections("-1 old\n+2 new", "file.ts");
        const rendered = renderCodexDiff(tokenTheme, sections, true).render(120).join("\n");

        expect(rendered).toContain("<dim>1 </dim><toolDiffRemoved>-</toolDiffRemoved>");
        expect(rendered).toContain("<dim>2 </dim><toolDiffAdded>+</toolDiffAdded>");
    });

    it("right-aligns fallback diff line numbers by the widest line number", () => {
        const sections = parseDiffSections("-8 old\n+9 new\n+10 ten", "file.ts");
        const lines = renderCodexDiff(plainTheme, sections, true)
            .render(120)
            .map((line) => line.trimEnd());

        expect(lines).toEqual(["     8 -old", "     9 +new", "    10 +ten"]);
    });

    it("fills the terminal edge without exceeding the provided width", () => {
        const sections = parseDiffSections(
            "-1 old text that wraps\n+1 new text that wraps",
            "file.ts",
        );
        const component = renderCodexDiff(plainTheme, sections, true);

        const width = 14;
        const lines = component.render(width);

        expect(lines.length).toBeGreaterThan(1);
        expectLinesWithinWidth(lines, width);
    });

    it("keeps compact diff previews clear of the terminal's final cell", () => {
        const width = 78;
        const lines = renderCodexDiff(
            plainTheme,
            [
                {
                    path: "narrow-render-probe.go",
                    lines: [
                        '+13         IndentedRuntimeContext: RuntimeContext{CWD: "/tmp/long-runtime-context-for-tmux-narrow-rendering", ParentArgs: []string{"--reportqueue", "--verbose"}, Env: map[string]string{"service": "reportqueue"}},',
                    ],
                    added: 1,
                    removed: 0,
                },
            ],
            false,
            { maxWrappedRows: 1 },
        ).render(width);

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("…");
        expect(visibleWidth(lines[0] ?? "")).toBeLessThan(width);
    });

    it("preserves every character when diff content wraps", () => {
        const content = "abcdefghijklmnopqrstuvwxyz".repeat(4);
        const lines = renderCodexDiff(
            plainTheme,
            [{ lines: [`+1 ${content}`], added: 1, removed: 0 }],
            true,
        ).render(20);
        const reconstructed = lines
            .map((line, index) => {
                if (index === 0) {
                    return line.slice(line.indexOf("+") + 1).trimEnd();
                }
                return line.trim();
            })
            .join("");

        expect(reconstructed).toBe(content);
        expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
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
        expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
    });

    it("keeps the head and tail of collapsed diffs with an expansion hint", () => {
        const sections = parseDiffSections(
            Array.from(
                { length: 40 },
                (_value, index) => `+${index + 1} added line ${index + 1}`,
            ).join("\n"),
            "file.ts",
        );
        const lines = renderCodexDiff(plainTheme, sections, false).render(120);
        const rendered = lines.join("\n");

        expect(rendered).toContain("added line 1");
        expect(rendered).toContain("added line 40");
        expect(rendered).not.toContain("added line 20");
        expect(rendered).toContain("… +34 lines (to expand)");
        expect(lines.at(-1)).toContain("… +34 lines (to expand)");
    });

    it("prioritizes changed rows when context dominates a collapsed diff", () => {
        const section = {
            path: "file.ts",
            lines: [
                " 1 context one",
                " 2 context two",
                " 3 context three",
                "-4 old value",
                "+4 new value",
                " 5 context four",
                " 6 context five",
                " 7 context six",
            ],
            added: 1,
            removed: 1,
        };
        const rendered = renderCodexDiff(plainTheme, [section], false, {
            collapsedLineBudget: 4,
        })
            .render(120)
            .join("\n");

        expect(rendered).toContain("-old value");
        expect(rendered).toContain("+new value");
        expect(rendered).toContain("to expand");
    });
});
