import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { renderBashCommandCall } from "../src/rendering/bash-call.ts";
import type { GlowupRenderTheme } from "../src/rendering/core.ts";

const theme: GlowupRenderTheme = {
    fg(_token, text) {
        return text;
    },
    bold(text) {
        return text;
    },
};

function render(command: string, options: { width: number; expanded?: boolean }) {
    return renderBashCommandCall(theme, command, {
        state: "success",
        expanded: options.expanded ?? false,
        maxCodePreviewLines: 8,
        showPrologueOmission: false,
        headerLayout: "auto",
        shellLayout: "auto",
    }).render(options.width);
}

describe("bash command rendering", () => {
    it("preserves short composed commands on one line", () => {
        expect(render("one && two", { width: 80 })).toEqual(["• Bash one && two"]);
    });

    it("supports always-on structural Bash layout", () => {
        const rendered = renderBashCommandCall(theme, "one | two && three", {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            headerLayout: "auto",
            shellLayout: "always",
        })
            .render(80)
            .join("\n");

        expect(rendered).toContain("│ one | two");
        expect(rendered).toContain("│ && three");
        expect(rendered).not.toContain("│ | two");
    });

    it("keeps pipelines and fallbacks on their step line when they fit", () => {
        const command =
            `pwd && opencode debug --help | head -80 ` +
            `&& ls -l /tmp/opencode || true && pnpm --version`;
        const rendered = render(command, { width: 100 }).join("\n");

        expect(rendered).toContain("│ && opencode debug --help | head -80");
        expect(rendered).toContain("│ && ls -l /tmp/opencode || true");
        expect(rendered).toContain("│ && pnpm --version");
        expect(rendered).not.toContain("│ | head -80");
        expect(rendered).not.toContain("│ || true");
    });

    it("allows long pipeline steps to wrap within their own row", () => {
        const command =
            `cat records.json | python -c "import sys,json; print(len(json.load(sys.stdin)))" ` +
            `&& git status --short`;
        const rendered = render(command, { width: 54 }).join("\n");

        expect(rendered).toContain("│ cat records.json | python -c");
        expect(rendered).toContain("│ && git status --short");
        expect(rendered).not.toContain("• Python");
    });

    it("structures compound shell without adding hierarchy labels", () => {
        const command = `for file in *.json; do python -c "print('x')" "$file" | jq -r .; done`;
        const rendered = render(command, { width: 54 }).join("\n");

        expect(rendered).toContain("│ for file in *.json; do");
        expect(rendered).toContain(`│   python -c "print('x')" "$file" | jq -r .;`);
        expect(rendered).toContain("│ done");
        expect(rendered).not.toContain("Pipeline");
        expect(rendered).not.toContain("Shell");
    });

    it("keeps later operations visible when the first operation is huge", () => {
        const command = `git add ${Array.from({ length: 80 }, (_value, index) => `src/file-${index}.ts`).join(" ")} && git commit -m "finish work" && git status --short`;
        const rendered = render(command, { width: 44 }).join("\n");

        expect(rendered).toContain("git add");
        expect(rendered).toContain("&& git commit -m");
        expect(rendered).toContain("&& git status --short");
        expect(rendered).toContain("…");
    });

    it("recomputes automatic layout after width changes", () => {
        const component = renderBashCommandCall(theme, "alpha && beta", {
            state: "success",
            expanded: false,
            maxCodePreviewLines: 8,
            showPrologueOmission: false,
            headerLayout: "auto",
            shellLayout: "auto",
        });

        expect(component.render(100)).toHaveLength(1);
        expect(component.render(16).join("\n")).toContain("&& beta");
        expect(component.render(100)).toHaveLength(1);
    });

    it("keeps compound shell structurally separated at wide widths", () => {
        const command =
            `for item in alpha beta gamma delta; do if test "${"${#item}"}" -gt 4; ` +
            `then printf '%s\\n' "$item"; else printf '%s\\n' short; fi; done | sort ` +
            `&& case "$(uname -s)" in Linux) echo linux;; *) echo other;; esac`;
        const rendered = render(command, { width: 312, expanded: true });

        expect(rendered[0]).toBe("• Bash");
        expect(rendered.join("\n")).toContain("│ for item in alpha beta gamma delta; do");
        expect(rendered.join("\n")).toContain("│   if test");
        expect(rendered.join("\n")).toContain("│ && case");
    });

    it("leaves code-writing heredocs as Bash without special body labels", () => {
        const command = `cat > check.py <<'PY'\nimport json\nprint(json)\nPY`;
        const rendered = render(command, { width: 80 }).join("\n");

        expect(rendered).toContain("• Bash");
        expect(rendered).toContain("│ import json");
        expect(rendered).not.toContain("• Python");
    });

    it("keeps a composed Node heredoc containing Python examples classified as Bash", () => {
        const command = [
            `rg -n "this\\.source" src/script-preview/bash-analysis.ts || true`,
            `node --import tsx --input-type=module <<'NODE'`,
            `const examples = [`,
            '`cd project && python -c "import sys; print(sys.argv)" -- --help`,',
            "`node -e \"console.log('ok')\" 2>/dev/null || true`,",
            `];`,
            `console.log(examples);`,
            `NODE`,
        ].join("\n");
        const rendered = render(command, { width: 120 }).join("\n");

        expect(rendered).toContain("• Bash");
        expect(rendered).toContain("node --import tsx --input-type=module");
        expect(rendered).not.toContain("• Python");
    });

    it("renders clean standalone interpreter calls as language previews", () => {
        const rendered = render(`python -c "import os; print(os.getcwd())"`, {
            width: 80,
        }).join("\n");

        expect(rendered).toContain("• Python");
        expect(rendered).not.toContain("python -c");
    });

    it("renders wrapped Python with trailing argv as a Python preview", () => {
        const command =
            "uv run --offline --no-project python -c 'import sys\nprint(sys.argv)' -- demo --verbose";
        const rendered = render(command, { width: 100 }).join("\n");

        expect(rendered).toContain("• Python");
        expect(rendered).toContain("import sys");
        expect(rendered).not.toContain("uv run");
    });

    it("keeps every collapsed row within the terminal width", () => {
        const rendered = render(
            `if check; then cat records.json | python -c "print('a very long embedded source value')"; else git status --short; fi`,
            { width: 32 },
        );
        expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    });
});
