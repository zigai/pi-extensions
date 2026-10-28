import { describe, expect, it, onTestFinished } from "vitest";
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

async function render(
    command: string,
    streamCode: CodePreview,
    options: {
        layout?: ShellLayout;
        operators?: ShellOperatorPosition;
        expanded?: boolean;
        argsComplete?: boolean;
    } = {},
) {
    const feature = createNativeBashFeature();
    onTestFinished(() => feature.clear());
    const component = feature.renderBashCall(
        { command },
        theme,
        { ...context(command, options.expanded), argsComplete: options.argsComplete ?? true },
        () => 8,
        () => false,
        () => options.layout ?? "auto",
        () => options.operators ?? "trailing",
        streamCode,
    );
    await feature.settled();

    return component;
}

function rows(component: Awaited<ReturnType<typeof render>>, width = 160) {
    return component.render(width).map((line) => stripVTControlCharacters(line));
}

describe("streaming Bash layout", () => {
    it.each([false, true])("splits semicolon statements with expansion %s", async (expanded) => {
        const command = "cat AGENTS.md; cat package.json; rg -n stream extensions | head -100";
        expect(rows(await render(command, ({ source }) => source, { expanded }))).toEqual([
            "$ cat AGENTS.md;",
            "  cat package.json;",
            "  rg -n stream extensions | head -100",
        ]);
    });

    it("applies preserve, always, and operator positioning to streamed snapshots", async () => {
        const command = "first && second; third";
        expect(rows(await render(command, ({ source }) => source, { layout: "preserve" }))).toEqual(
            [`$ ${command}`],
        );

        expect(
            rows(
                await render("first && second", ({ source }) => source, {
                    layout: "always",
                    operators: "leading",
                }),
            ),
        ).toEqual(["$ first", "  && second"]);
    });

    it("recomputes automatic layout on resize", async () => {
        const component = await render("alpha && beta", ({ source }) => source);
        expect(rows(component, 100)).toEqual(["$ alpha && beta"]);
        expect(rows(component, 14)).toEqual(["$ alpha &&", "  beta"]);
        expect(rows(component, 100)).toEqual(["$ alpha && beta"]);
    });

    it("lays out only published statements, leaving an unfinished tail hidden", async () => {
        const store = createCodeStreamStore();
        const command = "first; second; echo 'UNFINISHED";
        const streamCode: CodePreview = (input) => store.get({ ...input, mode: "statement" });
        const component = await render(command, streamCode, { argsComplete: false });
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

    it("retains quoted separators and heredoc body text", async () => {
        const command = "echo 'literal; && value'; cat <<'DATA'\nbody; literal\nDATA\nlast; final";
        expect(rows(await render(command, ({ source }) => source, { expanded: true }))).toEqual([
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
        const component = await render(command, streamCode, { expanded: true });
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

    it("does not multiply extraction redraws for the same host", async () => {
        const feature = createNativeBashFeature();
        const command = "echo ready";
        let invalidations = 0;
        const renderContext = {
            ...context(command),
            invalidate: () => {
                invalidations++;
            },
        };
        try {
            let previous: ReturnType<typeof feature.renderBashCall> | undefined;
            for (let i = 0; i < 3; i++)
                previous = feature.renderBashCall(
                    { command },
                    theme,
                    { ...renderContext, lastComponent: previous },
                    () => 8,
                    () => false,
                    () => "preserve",
                    () => "trailing",
                );

            await feature.settled();
            expect(invalidations).toBeLessThanOrEqual(2);
        } finally {
            feature.clear();
        }
    });

    it("waits for extraction and does not reuse an unrelated child language", async () => {
        const feature = createNativeBashFeature();
        const languages: Array<string | undefined> = [];
        const stream: CodePreview = ({ source, language }) => {
            languages.push(language);
            return source;
        };

        const firstCommand = `node -e 'const value = 1'`;
        const nextCommand = `python -c 'print(2)'`;
        try {
            const first = feature.renderBashCall(
                { command: firstCommand },
                theme,
                { ...context(firstCommand), argsComplete: false, isPartial: true },
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
                stream,
            );
            expect(rows(first)).toEqual([]);
            expect(languages).toEqual([]);
            await feature.settled();
            expect(rows(first).join("\n")).toContain("const value = 1");
            expect(languages).toEqual(["javascript"]);
            const next = feature.renderBashCall(
                { command: nextCommand },
                theme,
                {
                    ...context(nextCommand),
                    argsComplete: false,
                    isPartial: true,
                    lastComponent: first,
                },
                () => 8,
                () => false,
                () => "preserve",
                () => "trailing",
                stream,
            );
            expect(rows(next)).toEqual([]);
            expect(languages).toEqual(["javascript"]);
            await feature.settled();
            expect(rows(next).join("\n")).toContain("print(2)");
            expect(languages).toEqual(["javascript", "python"]);
        } finally {
            feature.clear();
        }
    });

    it("reclassifies an unfinished standalone heredoc when extraction completes", async () => {
        const feature = createNativeBashFeature();
        const command = `python - <<'PY'\nprint(1)`;
        const component = feature.renderBashCall(
            { command },
            theme,
            { ...context(command), argsComplete: false },
            () => 8,
            () => false,
            () => "preserve",
            () => "trailing",
            ({ source, language }) => {
                if (language === "python") return source.replace("print", "PRINT");
                return source;
            },
        );
        try {
            rows(component);
            await feature.settled();
            component.invalidate();
            expect(rows(component).join("\n")).toContain("PRINT(1)");
        } finally {
            feature.clear();
        }
    });

    it("keeps standalone interpreter previews in their own language", async () => {
        const feature = createNativeBashFeature();
        const command = `python -c "print('hello')"`;
        const show = (lastComponent?: Awaited<ReturnType<typeof render>>) =>
            feature.renderBashCall(
                { command },
                theme,
                { ...context(command), lastComponent },
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
                ({ source }) => source,
            );
        try {
            const initial = show();
            rows(initial);
            await feature.settled();
            expect(rows(show(initial))).toEqual(["$ python -c", "  print('hello')"]);
        } finally {
            feature.clear();
        }
    });
});
