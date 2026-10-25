import { describe, expect, it } from "vitest";
import { Theme } from "@earendil-works/pi-coding-agent";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../../support/theme-colors.ts";
import { stripVTControlCharacters } from "node:util";
import { bindExtensionDiagnostics } from "@zigai/pi-extension-internals";
import type { ScriptBlockFormatter } from "../../../../src/tools/built-in/bash/formatter.ts";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import type {
    ShellLayout,
    ShellOperatorPosition,
} from "../../../../src/tools/built-in/bash/command.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import type { CodePreview } from "../../../../src/rendering/streaming/presentation.ts";
import { createCodeStreamStore } from "../../../../src/rendering/streaming/code-stream.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

function context(command: string, expanded = false): BuiltInRenderContext {
    return {
        args: { command },
        toolCallId: "streaming-bash-layout",
        cwd: "/work",
        lastComponent: undefined,
        state: {},
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: false,
        durationMs: undefined,
        outputPad: 1,
        invalidate: () => {},
    };
}

function render(
    command: string,
    streamCode: CodePreview,
    options: {
        layout?: ShellLayout;
        operators?: ShellOperatorPosition;
        expanded?: boolean;
        argsComplete?: boolean;
    } = {},
) {
    return createNativeBashFeature().renderBashCall(
        { command },
        theme,
        { ...context(command, options.expanded), argsComplete: options.argsComplete ?? true },
        () => 8,
        () => false,
        () => options.layout ?? "auto",
        () => options.operators ?? "trailing",
        streamCode,
    );
}

function rows(component: ReturnType<typeof render>, width = 160) {
    return component.render(width).map((line) => stripVTControlCharacters(line));
}

describe("streaming Bash layout", () => {
    it.each([false, true])("splits semicolon statements with expansion %s", (expanded) => {
        const command = "cat AGENTS.md; cat package.json; rg -n stream extensions | head -100";
        expect(rows(render(command, ({ source }) => source, { expanded }))).toEqual([
            "$ cat AGENTS.md;",
            "  cat package.json;",
            "  rg -n stream extensions | head -100",
        ]);
    });

    it("applies preserve, always, and operator positioning to streamed snapshots", () => {
        const command = "first && second; third";
        expect(rows(render(command, ({ source }) => source, { layout: "preserve" }))).toEqual([
            `$ ${command}`,
        ]);
        expect(
            rows(
                render("first && second", ({ source }) => source, {
                    layout: "always",
                    operators: "leading",
                }),
            ),
        ).toEqual(["$ first", "  && second"]);
    });

    it("recomputes automatic layout on resize", () => {
        const component = render("alpha && beta", ({ source }) => source);
        expect(rows(component, 100)).toEqual(["$ alpha && beta"]);
        expect(rows(component, 14)).toEqual(["$ alpha &&", "  beta"]);
        expect(rows(component, 100)).toEqual(["$ alpha && beta"]);
    });

    it("lays out only published statements, leaving an unfinished tail hidden", async () => {
        const store = createCodeStreamStore();
        const command = "first; second; echo 'UNFINISHED";
        const streamCode: CodePreview = (input) => store.get({ ...input, mode: "statement" });
        const component = render(command, streamCode, { argsComplete: false });
        try {
            rows(component);
            await store.settled();
            component.invalidate();
            const published = rows(component);
            expect(published).toEqual(["$ first;", "  second"]);
            expect(published.join("\n")).not.toContain("UNFINISHED");
        } finally {
            await store.dispose();
        }
    });

    it("retains quoted separators and heredoc body text", () => {
        const command = "echo 'literal; && value'; cat <<'DATA'\nbody; literal\nDATA\nlast; final";
        expect(rows(render(command, ({ source }) => source, { expanded: true }))).toEqual([
            "$ echo 'literal; && value';",
            "  cat <<'DATA'",
            "  body; literal",
            "  DATA",
            "  last;",
            "  final",
        ]);
    });

    it("keeps mixed commands in Bash and sends only the Python heredoc body to its formatter", async () => {
        const store = createCodeStreamStore();
        const warnings: string[] = [];
        const diagnostics = bindExtensionDiagnostics({
            hasUI: true,
            ui: { notify: (message) => warnings.push(message) },
        });
        const languages: string[] = [];
        const pythonInputs: string[] = [];
        const formatter: ScriptBlockFormatter = async (input) => {
            languages.push(input.language);
            if (input.language === "python") pythonInputs.push(input.code);
            return input.code;
        };
        const streamCode: CodePreview = (input) =>
            store.get({ ...input, mode: "statement", formatter });
        const command = [
            "bun run inspect.ts > /tmp/result.json; python - <<'PY'",
            "import json,xml.etree.ElementTree as E",
            "data=json.load(open('/tmp/result.json'))",
            "print(data)",
            "PY",
        ].join("\n");
        const component = render(command, streamCode, { expanded: true });
        try {
            rows(component);
            await store.settled();
            component.invalidate();
            const published = rows(component).join("\n");
            expect(published).toContain("$ bun run inspect.ts");
            expect(published).toContain("python - <<'PY'");
            expect(published).toContain("import json,xml.etree.ElementTree as E");
            expect(languages.length).toBeGreaterThan(0);
            expect(
                languages.every((language) => language === "bash" || language === "python"),
            ).toBe(true);
            expect(pythonInputs).toEqual([
                "import json,xml.etree.ElementTree as E\ndata=json.load(open('/tmp/result.json'))\nprint(data)\n",
            ]);
            expect(warnings).toEqual([]);
        } finally {
            await store.dispose();
            diagnostics.dispose();
        }
    });

    it("keeps standalone interpreter previews in their own language", () => {
        expect(rows(render(`python -c "print('hello')"`, ({ source }) => source))).toEqual([
            "$ python -c",
            "  print('hello')",
        ]);
    });
});
