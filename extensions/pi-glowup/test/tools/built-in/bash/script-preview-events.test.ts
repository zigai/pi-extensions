import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Theme } from "@earendil-works/pi-coding-agent";
import { format, type FormatConfig } from "oxfmt";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../../support/theme-colors.ts";
import {
    createCommandScriptFormatter,
    getScriptFormatterWorkload,
    parseScriptFormatterCommandsValue,
    type ScriptBlockFormatter,
    type ScriptBlockFormatterInput,
    type ScriptBlockFormatterOptions,
} from "../../../../src/tools/built-in/bash/formatter.ts";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import {
    rememberRawScriptPreview,
    scheduleFormattedScriptPreview,
} from "../../../../src/tools/built-in/bash/format-preview.ts";
import type { ScriptInvocation } from "../../../../src/tools/built-in/bash/invocation.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";

class RecordingPreviewSink {
    readonly previews = new Map<string, ScriptInvocation>();

    get(toolCallId: string): ScriptInvocation | undefined {
        return this.previews.get(toolCallId);
    }

    set(toolCallId: string, preview: ScriptInvocation): void {
        this.previews.set(toolCallId, preview);
    }
}

describe("script preview events", () => {
    it("holds formatted decoration until completion and expands to original source", async () => {
        const bash = createNativeBashFeature();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const code =
            'import fs from "node:fs";\n\nconst entry = {\n  alpha: 1,\n  beta: 2,\n};\n\nconsole.log(entry);';
        const command = `node -e '${code}'`;
        const executable = join(
            dirname(createRequire(import.meta.url).resolve("oxfmt/package.json")),
            "bin",
            "oxfmt",
        );
        const backend = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                javascript: { kind: "javascript", command: [executable], imports: "omit" },
            }),
        );
        if (backend === undefined) throw new Error("Expected a configured formatter");

        let formatterCompleted = false;
        const formatter: ScriptBlockFormatter = Object.assign(
            async (input: ScriptBlockFormatterInput, options?: ScriptBlockFormatterOptions) => {
                const output = await backend(input, options);
                if (output !== undefined && options?.signal?.aborted !== true)
                    formatterCompleted = true;

                return output;
            },
            { profileFor: (language: string) => backend.profileFor?.(language) },
        );
        let context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "display-call",
            cwd: "/work",
            lastComponent: undefined,
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: true,
            expanded: false,
            showImages: false,
            isError: false,
            durationMs: undefined,
            outputPad: 1,
            invalidate: () => {},
        };
        const render = (expanded = false) =>
            stripVTControlCharacters(
                bash
                    .renderBashCall(
                        { command },
                        theme,
                        { ...context, expanded },
                        () => "block",
                        () => 30,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                    )
                    .render(120)
                    .join("\n"),
            );
        try {
            bash.schedule({
                toolCallId: context.toolCallId,
                command,
                formatter,
                signal: undefined,
                isCurrent: () => true,
                invalidate: context.invalidate,
            });

            render();
            await vi.waitUntil(
                () => formatterCompleted && getScriptFormatterWorkload().active === 0,
            );
            expect(render()).toContain('│ import fs from "node:fs";');
            expect(render()).toContain("│ const entry = {\n");
            const result = { content: [{ type: "text" as const, text: "SAFE_RESULT" }] };
            context = { ...context, isPartial: false };
            bash.renderBashResult(
                result,
                { expanded: false, isPartial: false },
                theme,
                context,
                () => "block",
            );
            await vi.waitUntil(() => render().includes("const entry = { alpha: 1, beta: 2 };"));
            expect(render()).not.toContain("import fs");
            expect(render(true)).toContain('│ import fs from "node:fs";');
            expect(render(true)).toContain("│ const entry = {\n");
            expect(context.args).toEqual({ command });
        } finally {
            bash.clear();
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
        }
    });

    it("formats for the rendered content width and restores a single line after widening", async () => {
        const bash = createNativeBashFeature();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const code =
            'console.log(["a moderately long sample value", "another moderately long sample value"]);';
        const command = `node -e '${code}'`;
        const formatter: ScriptBlockFormatter = async (input, options) => {
            const formatOptions: FormatConfig = {};
            if (options?.targetWidth !== undefined) {
                formatOptions.printWidth = options.targetWidth;
            }

            const formatted = await format("script.js", input.code, formatOptions);
            return formatted.code;
        };

        let finishInvalidation = () => {};

        const context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "width-call",
            cwd: "/work",
            lastComponent: undefined,
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: true,
            showImages: false,
            isError: false,
            durationMs: undefined,
            outputPad: 1,
            invalidate: () => finishInvalidation(),
        };
        const render = (width: number) =>
            stripVTControlCharacters(
                bash
                    .renderBashCall(
                        { command },
                        theme,
                        context,
                        () => "auto",
                        () => 8,
                        () => false,
                        () => "auto",
                        () => "trailing",
                    )
                    .render(width)
                    .join("\n"),
            );
        bash.schedule({
            toolCallId: "width-call",
            command,
            formatter,
            signal: undefined,
            isCurrent: () => true,
            invalidate: context.invalidate,
        });
        const narrowed = new Promise<void>((resolve) => {
            finishInvalidation = resolve;
        });
        render(44);
        await narrowed;
        expect(render(44)).toContain("│ console.log([\n");
        expect(render(44)).toContain('│   "a moderately long sample value",');
        const widened = new Promise<void>((resolve) => {
            finishInvalidation = resolve;
        });
        render(100);
        await widened;
        expect(render(100)).toContain(code);
        expect(render(100)).not.toContain("│ console.log([\n");
        bash.clear();
    });

    it("runs one formatter per finalized command", async () => {
        const bash = createNativeBashFeature();
        const pending: Array<(code: string) => void> = [];
        const formatter: ScriptBlockFormatter = async () =>
            new Promise((resolve) => {
                pending.push(resolve);
            });
        const options = {
            toolCallId: "node-call",
            formatter,
            signal: undefined,
            isCurrent: () => true,
            invalidate: () => {},
        };

        bash.schedule({ ...options, command: `node -e 'console.log(1)'` });
        bash.schedule({ ...options, command: `node -e 'console.log(1)'` });
        expect(pending).toHaveLength(1);

        bash.schedule({ ...options, command: `node -e 'console.log(3)'` });
        expect(pending).toHaveLength(2);

        pending[0]?.("console.log(2)");
        pending[1]?.("console.log(4)");
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
    });

    it("replaces the preflight preview with the final bash command", () => {
        const sink = new RecordingPreviewSink();

        rememberRawScriptPreview(sink, "call-1", "python - <<'PY'\nprint('preflight')\nPY");
        rememberRawScriptPreview(sink, "call-1", "python - <<'PY'\nprint('actual')\nPY");

        expect(sink.previews.get("call-1")).toEqual({
            label: "Python",
            language: "python",
            code: "print('actual')",
        });
    });

    it("schedules formatter work without waiting for it", async () => {
        const sink = new RecordingPreviewSink();
        let invalidations = 0;
        let resolveFormatter: ((value: string | undefined) => void) | undefined;
        const formatter: ScriptBlockFormatter = async () =>
            new Promise((resolve) => {
                resolveFormatter = resolve;
            });

        scheduleFormattedScriptPreview({
            sink,
            toolCallId: "call-1",
            command: "python - <<'PY'\nprint(1)\nPY",
            formatter,
            invalidate: () => {
                invalidations += 1;
            },
        });

        expect(sink.previews.size).toBe(0);
        resolveFormatter?.("print(2)");
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        expect(sink.previews.get("call-1")?.code).toBe("print(2)");
        expect(invalidations).toBe(1);
    });

    it("does not commit formatter output after its session is replaced", async () => {
        const sink = new RecordingPreviewSink();
        let current = true;
        let resolveFormatter: ((value: string | undefined) => void) | undefined;
        const formatter: ScriptBlockFormatter = async () =>
            new Promise((resolve) => {
                resolveFormatter = resolve;
            });

        scheduleFormattedScriptPreview({
            sink,
            toolCallId: "stale-call",
            command: "python - <<'PY'\nprint(1)\nPY",
            formatter,
            isCurrent: () => current,
        });
        current = false;
        resolveFormatter?.("print(2)");
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        expect(sink.previews.has("stale-call")).toBe(false);
    });

    it("does not format interpreter source inside composed Bash calls", async () => {
        const sink = new RecordingPreviewSink();
        let formatterCalls = 0;
        const formatter: ScriptBlockFormatter = async () => {
            formatterCalls += 1;
            return "print('formatted')";
        };

        scheduleFormattedScriptPreview({
            sink,
            toolCallId: "mixed-call",
            command: `cd app && python -c "print('raw')" && just test`,
            formatter,
        });
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });

        expect(sink.previews.size).toBe(0);
        expect(formatterCalls).toBe(0);
    });
});
