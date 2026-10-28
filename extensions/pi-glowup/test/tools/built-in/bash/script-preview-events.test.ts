import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Type from "typebox";
import { Value } from "typebox/value";
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
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../../src/rendering/streaming/code-stream.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../../src/rendering/syntax/highlighter.ts";
import { createStreamingPresentation } from "../../../../src/rendering/streaming/content-presentation.ts";
import type { CodePreview } from "../../../../src/rendering/streaming/presentation.ts";
import {
    presentGlowupContent,
    registerGlowupStreamingPolicy,
} from "../../../../src/tools/protocol/streaming.ts";
import { configureRenderDiagnostics } from "../../../../src/diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../../src/diagnostics/logger.ts";

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
    // Expanded completed scripts must retain their full source even when only another
    // language has a formatter. Collapsed previews remain short, and completion must
    // retire the live preview rather than sending finished calls through it again.
    it.each([
        { interpreter: "ruby", language: "ruby", mode: "block" as const },
        { interpreter: "perl", language: "perl", mode: "statement" as const },
    ])(
        "preserves the expanded $language tail after $mode completion without a profile",
        async ({ interpreter, language, mode }) => {
            const profiles = parseScriptFormatterCommandsValue({
                javascript: { kind: "command", command: ["unused"] },
            });
            const formatter = Object.assign(
                vi.fn<ScriptBlockFormatter>(async () => undefined),
                {
                    profileFor: (name: string) => profiles.get(name),
                },
            );
            const bash = createNativeBashFeature(() => formatter);
            const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
            const code = `${"# padding\n".repeat(8000)}print("TAIL_SENTINEL");`;
            const command = `${interpreter} -e '${code}'`;
            const store = createCodeStreamStore();
            const streamCode = vi.fn<CodePreview>((input) =>
                store.get({ ...input, mode, formatter }),
            );
            const context: BuiltInRenderContext = {
                args: { command },
                toolCallId: `unprofiled-${language}-${mode}`,
                cwd: "/work",
                lastComponent: undefined,
                state: {},
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
                expanded: false,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            };
            const render = (current: BuiltInRenderContext) =>
                bash.renderBashCall(
                    { command },
                    theme,
                    current,
                    () => 8,
                    () => false,
                    () => "preserve",
                    () => "trailing",
                    streamCode,
                );
            try {
                expect(Buffer.byteLength(code, "utf8")).toBeGreaterThan(64 * 1024);
                expect(formatter.profileFor?.(language)).toBeUndefined();
                const live = render(context);
                expect(live.render(80).length).toBeLessThan(12);
                const signal = streamCode.mock.calls[0]?.[0].signal;
                expect(signal?.aborted).toBe(false);
                const requests = streamCode.mock.calls.length;
                const completedContext = { ...context, argsComplete: true, lastComponent: live };
                const collapsed = render(completedContext);
                expect(collapsed.render(80).length).toBeLessThan(12);
                expect(signal?.aborted).toBe(true);
                expect(formatter).toHaveBeenCalled();
                expect(
                    formatter.mock.calls.every(
                        ([input, options]) =>
                            input.code === code && options?.diagnostics?.stage === "block",
                    ),
                ).toBe(true);
                const expanded = render({
                    ...completedContext,
                    expanded: true,
                    lastComponent: collapsed,
                });
                const rows = expanded.render(80).map(stripVTControlCharacters);
                expect(rows.filter((row) => row.trim() === "# padding")).toHaveLength(8000);
                expect(rows.join("\n")).toContain("TAIL_SENTINEL");
                expect(rows.join("\n")).not.toContain("preview truncated");
                expect(streamCode).toHaveBeenCalledTimes(requests);
                expect(context.args).toEqual({ command });
            } finally {
                bash.clear();
                await store.dispose();
            }
        },
    );

    // Completion must retire only its live owner: no extra statements, stale
    // invalidations, late rejection warnings or resurrection by retained components.
    it.each(["resolve", "reject", "clear"])(
        "retires live statement work before %s",
        async (ending) => {
            const events = recordRenderEvents();
            const store = createCodeStreamStore();
            let finishLive = (_value: string | undefined) => {};
            let rejectLive = (_error: Error) => {};
            const live = new Promise<string | undefined>((resolve, reject) => {
                finishLive = resolve;
                rejectLive = reject;
            });
            const attempts: Array<{
                code: string;
                stage: string | undefined;
                signal: AbortSignal | undefined;
            }> = [];
            const profiles = parseScriptFormatterCommandsValue({
                javascript: { kind: "command", command: ["unused"] },
            });
            const formatter: ScriptBlockFormatter = Object.assign(
                async (
                    input: ScriptBlockFormatterInput,
                    options: ScriptBlockFormatterOptions = {},
                ) => {
                    attempts.push({
                        code: input.code,
                        stage: options.diagnostics?.stage,
                        signal: options.signal,
                    });

                    if (
                        options.diagnostics?.stage === "statement" &&
                        input.code === "const first=1;"
                    )
                        return live;

                    return input.code.replaceAll("=", " = ");
                },
                { profileFor: (language: string) => profiles.get(language) },
            );
            const policy = registerGlowupStreamingPolicy(
                createStreamingPresentation(() => ({
                    prose: "token",
                    code: "statement",
                    streams: store,
                    formatter,
                })),
            );
            const bash = createNativeBashFeature(() => formatter);
            const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
            let obsoleteInvalidations = 0;
            let streamRequests = 0;
            const code = "const first=1;const second=2;";
            const command = `node -e '${code}'`;
            const context: BuiltInRenderContext = {
                args: { command },
                toolCallId: "retiring-call",
                cwd: "/work",
                lastComponent: undefined,
                state: {},
                executionStarted: false,
                argsComplete: false,
                isPartial: true,
                expanded: false,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            };
            const render = (current: BuiltInRenderContext, source = command) =>
                bash.renderBashCall(
                    { command: source },
                    theme,
                    current,
                    () => 8,
                    () => false,
                    () => "preserve",
                    () => "trailing",
                    (input) => {
                        streamRequests += 1;

                        return presentGlowupContent({
                            ...input,
                            kind: "code",
                            invalidate: () => {
                                if (input.toolCallId === "retiring-call")
                                    obsoleteInvalidations += 1;

                                input.invalidate?.();
                            },
                        });
                    },
                );
            try {
                const oldComponent = render(context);
                oldComponent.render(80);
                await vi.waitUntil(() =>
                    attempts.some((attempt) => attempt.code === "const first=1;"),
                );
                const other = render(
                    { ...context, toolCallId: "other-call" },
                    "node -e 'const other=3;'",
                );
                other.render(80);
                await vi.waitUntil(() =>
                    attempts.some((attempt) => attempt.code === "const other=3;"),
                );
                const obsoleteBefore = obsoleteInvalidations;
                let completed: ReturnType<typeof render> | undefined;
                if (ending === "clear") bash.clear();
                else {
                    completed = render({
                        ...context,
                        argsComplete: true,
                        lastComponent: oldComponent,
                    });
                    completed.render(80);
                }

                const first = attempts.find((attempt) => attempt.code === "const first=1;");
                expect(first?.signal?.aborted).toBe(true);

                if (ending !== "clear")
                    expect(
                        attempts.find((attempt) => attempt.code === "const other=3;")?.signal
                            ?.aborted,
                    ).toBe(false);

                const requestsBefore = streamRequests;
                oldComponent.invalidate();
                oldComponent.render(80);
                expect(streamRequests).toBe(requestsBefore);

                if (ending === "reject") rejectLive(new Error("Obsolete formatter rejected"));
                else finishLive("const first = 1;");

                await store.settled();

                if (completed !== undefined) {
                    await vi.waitUntil(() => {
                        completed = render({
                            ...context,
                            argsComplete: true,
                            lastComponent: completed,
                        });
                        return stripVTControlCharacters(completed.render(80).join("\n")).includes(
                            "const second = 2;",
                        );
                    });
                    expect(
                        attempts.some(
                            (attempt) => attempt.stage === "block" && attempt.code === code,
                        ),
                    ).toBe(true);
                }

                expect(
                    attempts.filter(
                        (attempt) =>
                            attempt.stage === "statement" && attempt.code === "const second=2;",
                    ),
                ).toEqual([]);

                expect(obsoleteInvalidations).toBe(obsoleteBefore);
                expect(store.ready("tool:retiring-call:script:javascript")).toBe(false);
                expect(
                    events.filter(
                        (entry) =>
                            entry.event === "render_error" &&
                            entry.fields.toolCallId === "retiring-call",
                    ),
                ).toEqual([]);
            } finally {
                finishLive(undefined);
                bash.clear();
                policy.dispose();
                await store.dispose();
            }
        },
    );

    it("publishes compact Python only after readiness and completion and expands original gaps", async () => {
        const bash = createNativeBashFeature();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const code =
            'import math\n\n\nclass Sample:\n    text = """first\n\nlast"""\n\n\nassert Sample.text';
        const command = `python -c '${code}'`;
        const backend = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                python: {
                    kind: "command",
                    command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
                },
            }),
        );
        if (backend === undefined) throw new Error("Expected a configured formatter");

        let release = () => {};
        const ready = new Promise<void>((resolve) => {
            release = resolve;
        });
        const formatter: ScriptBlockFormatter = Object.assign(
            async (input: ScriptBlockFormatterInput, options?: ScriptBlockFormatterOptions) => {
                await ready;
                return backend(input, options);
            },
            { profileFor: (language: string) => backend.profileFor?.(language) },
        );
        let context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "python-display",
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
        const render = (expanded = false, width = 80) =>
            stripVTControlCharacters(
                bash
                    .renderBashCall(
                        { command },
                        theme,
                        { ...context, expanded },
                        () => 30,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                    )
                    .render(width)
                    .join("\n"),
            );

        const raw = "  import math\n  \n  \n  class Sample:";
        try {
            bash.schedule({
                toolCallId: context.toolCallId,
                command,
                formatter,
                signal: undefined,
                isCurrent: () => true,
                invalidate: context.invalidate,
            });

            expect(render()).toContain(raw);
            context = { ...context, isPartial: false };
            bash.renderBashResult(
                { content: [{ type: "text", text: "SAFE_RESULT" }] },
                { expanded: false, isPartial: false },
                theme,
                context,
                () => "terminal",
            );

            expect(render()).toContain(raw);
            release();
            await vi.waitUntil(() => render().includes("  import math\n  class Sample:"));
            expect(render()).toContain(
                '      text = """first\n  \n  last"""\n  assert Sample.text',
            );

            expect(render(true)).toContain(raw);
            expect(render(false, 24)).toContain("  assert Sample.text");
            expect(render()).toContain("  import math\n  class Sample:");
            expect(context.args).toEqual({ command });
        } finally {
            release();
            bash.clear();
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
        }
    });

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
            expect(render()).toContain('  import fs from "node:fs";');
            expect(render()).toContain("  const entry = {\n");
            const result = { content: [{ type: "text" as const, text: "SAFE_RESULT" }] };
            context = { ...context, isPartial: false };
            bash.renderBashResult(
                result,
                { expanded: false, isPartial: false },
                theme,
                context,
                () => "terminal",
            );
            await vi.waitUntil(() => render().includes("const entry = { alpha: 1, beta: 2 };"));
            expect(render()).not.toContain("import fs");
            expect(render(true)).toContain('  import fs from "node:fs";');
            expect(render(true)).toContain("  const entry = {\n");
            expect(context.args).toEqual({ command });
        } finally {
            bash.clear();
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
        }
    });

    it("retains whole-shell display profiles after finalizing a Bash identity", async () => {
        const bash = createNativeBashFeature();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const command = "echo original; printf done";

        const profiles = parseScriptFormatterCommandsValue({
            bash: { kind: "bash", command: ["shfmt"] },
        });
        const formatter: ScriptBlockFormatter = Object.assign(
            async () => "echo formatted\nprintf done",
            { profileFor: (language: string) => profiles.get(language) },
        );
        const context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "bash-display",
            cwd: "/work",
            lastComponent: undefined,
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
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
                        () => 8,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                    )
                    .render(80)
                    .join("\n"),
            );

        try {
            bash.schedule({
                toolCallId: context.toolCallId,
                command,
                formatter,
                completed: true,
                signal: undefined,
                isCurrent: () => true,
                invalidate: context.invalidate,
            });
            await vi.waitUntil(() => render().includes("$ echo formatted\n"));
            expect(render()).toContain("\n  printf done");
            expect(render(true)).toContain(command);
            expect(context.args).toEqual({ command });
        } finally {
            bash.clear();
        }
    });

    it("formats for the rendered content width and restores a single line after widening", async () => {
        const bash = createNativeBashFeature();
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const code =
            'console.log(["a moderately long sample value", "another moderately long sample value"]);';
        const command = `node -e '${code}'`;
        const widths: Array<number | undefined> = [];
        const signals: AbortSignal[] = [];
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const formatter: ScriptBlockFormatter = async (input, options) => {
            widths.push(options?.targetWidth);

            if (options?.signal !== undefined) signals.push(options.signal);
            if (widths.length === 1) await gate;

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
        render(60);
        render(44);
        expect(signals[0]?.aborted).toBe(false);
        release();
        await narrowed;
        expect(widths).toHaveLength(2);
        expect(signals.every((signal) => !signal.aborted)).toBe(true);
        expect(render(44)).toContain("  console.log([\n");
        expect(render(44)).toContain('    "a moderately long sample value",');
        const widened = new Promise<void>((resolve) => {
            finishInvalidation = resolve;
        });
        render(100);
        await widened;
        expect(render(100)).toContain(code);
        expect(render(100)).not.toContain("  console.log([\n");
        bash.clear();
    });

    it("identifies the changed tool call when restoring formatted previews", async () => {
        const bash = createNativeBashFeature();
        const changed: string[] = [];
        const formatter: ScriptBlockFormatter = async () => "print('reviewed')";
        try {
            await bash.restore({
                calls: [
                    { toolCallId: "first", command: "python -c 'print(1)'" },
                    { toolCallId: "second", command: "python -c 'print(2)'" },
                ],
                formatter,
                signal: new AbortController().signal,
                isCurrent: () => true,
                invalidate: (toolCallId) => {
                    changed.push(toolCallId);
                },
            });
            expect(changed).toEqual(["first", "second"]);
        } finally {
            bash.clear();
        }
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
            launcher: "python - <<'PY'",
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

type RecordedRenderEvent = { readonly event: string; readonly fields: DebugLogFields };

function recordRenderEvents(): RecordedRenderEvent[] {
    const events: RecordedRenderEvent[] = [];
    configureRenderDiagnostics((event, fields) => events.push({ event, fields: fields() }));
    onTestFinished(() => configureRenderDiagnostics(undefined));

    return events;
}

const renderedEventSchema = Type.Object({
    toolCallId: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    language: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    codeHash: Type.String(),
    outputHash: Type.Optional(Type.String()),
    outcome: Type.String(),
});

const segmentSchema = Type.Object({
    language: Type.String(),
    origin: Type.String(),
    start: Type.Optional(Type.Number()),
    end: Type.Optional(Type.Number()),
    codeHash: Type.String(),
    formattable: Type.Boolean(),
    formatted: Type.Optional(Type.Boolean()),
    skipReason: Type.Optional(Type.String()),
    displayHash: Type.Optional(Type.String()),
});

const statementEventSchema = Type.Object({
    toolCallId: Type.Optional(Type.String()),
    stage: Type.Optional(Type.String()),
    codeHash: Type.String(),
    segmentHash: Type.Optional(Type.String()),
});

const analysisSchema = Type.Object({
    toolCallId: Type.String(),
    path: Type.String(),
    segments: Type.Array(segmentSchema),
    inlineSkipReason: Type.Optional(Type.String()),
});

function eventsNamed(events: readonly RecordedRenderEvent[], name: string) {
    return events
        .filter((entry) => entry.event === name)
        .map((entry) => Value.Parse(renderedEventSchema, entry.fields));
}

function analysisFor(events: readonly RecordedRenderEvent[], toolCallId: string) {
    const analyses = events
        .filter((entry) => entry.event === "script_analysis")
        .map((entry) => Value.Parse(analysisSchema, entry.fields))
        .filter((analysis) => analysis.toolCallId === toolCallId);
    expect(analyses).toHaveLength(1);
    const [analysis] = analyses;
    if (analysis === undefined) throw new Error(`Missing analysis for ${toolCallId}`);
    return analysis;
}

function sha16(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

describe("script render diagnostics", () => {
    const stores: CodeStreamStore[] = [];
    const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

    beforeAll(async () => {
        await disposeSyntaxHighlighting();
        await initializeSyntaxHighlighting(process.env, {
            preloadLanguages: ["bash", "python", "javascript", "awk", "jq"],
        });
    });

    afterAll(async () => {
        await Promise.all(stores.splice(0).map(async (store) => store.dispose()));
        await disposeSyntaxHighlighting();
    });

    // Splits `a=1;b=2` statements so the heredoc body observably changes.
    const splitStatements =
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.replace(/;/g,'\\n')))";

    // Breaks jq pipes onto continuation rows like jqfmt's `-op pipe`.
    const breakPipes =
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.replace(/ [|] /g,' |\\n    ')))";

    function setup() {
        const store = createCodeStreamStore();
        stores.push(store);
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                python: { kind: "command", command: [process.execPath, "-e", splitStatements] },
                javascript: { kind: "command", command: [process.execPath, "-e", splitStatements] },
                jq: { kind: "jq", command: [process.execPath, "-e", breakPipes, "--"] },
                awk: { kind: "awk", command: [process.execPath, "-e", "process.exit(1)"] },
            }),
        );
        if (formatter === undefined) throw new Error("Expected a configured formatter");

        const bash = createNativeBashFeature(
            () => formatter,
            async (input, backend, options) => store.formatEmbedded(input, backend, options),
        );
        onTestFinished(() => bash.clear());

        const show = async (toolCallId: string, command: string): Promise<() => void> => {
            bash.schedule({
                toolCallId,
                command,
                formatter,
                signal: undefined,
                completed: true,
                isCurrent: () => true,
                invalidate: () => {},
            });
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
            await store.settled();

            const context: BuiltInRenderContext = {
                args: { command },
                toolCallId,
                cwd: "/work",
                lastComponent: undefined,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: false,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            };
            const render = () =>
                bash
                    .renderBashCall(
                        { command },
                        theme,
                        context,
                        () => 30,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                    )
                    .render(120);
            render();
            await settleSyntaxHighlights();
            render();

            return () => {
                render();
            };
        };

        const showStreamed = async (toolCallId: string, command: string): Promise<void> => {
            const context: BuiltInRenderContext = {
                args: { command },
                toolCallId,
                cwd: "/work",
                lastComponent: undefined,
                state: {},
                executionStarted: true,
                argsComplete: true,
                isPartial: false,
                expanded: false,
                showImages: false,
                isError: false,
                durationMs: undefined,
                outputPad: 1,
                invalidate: () => {},
            };
            const render = () =>
                bash
                    .renderBashCall(
                        { command },
                        theme,
                        context,
                        () => 30,
                        () => false,
                        () => "preserve",
                        () => "trailing",
                        (input) => store.get({ ...input, mode: "statement", formatter }),
                    )
                    .render(120);
            render();
            await store.settled();
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
            render();
        };

        return { show, showStreamed };
    }

    it("joins extracted heredoc and inline programs to their format and highlight events", async () => {
        const events = recordRenderEvents();
        const { show } = setup();
        const heredocCommand =
            "python3 - <<'PY'\na=1;b=2\nprint(a + b)\nPY\nnode -e 'console.log(1)'\necho done";
        const inlineCommand = `cd /tmp && node -e 'console.log("inline")'`;

        await show("heredoc-call", heredocCommand);
        await show("inline-call", inlineCommand);

        await vi.waitUntil(() => events.some((entry) => entry.event === "script_analysis"));
        const heredocAnalysis = analysisFor(events, "heredoc-call");
        expect(heredocAnalysis.path).toBe("shell");

        // Glowup does not recognize inline programs in commands that open a heredoc.
        expect(heredocAnalysis.inlineSkipReason).toBe("heredoc-present");
        const [heredoc] = heredocAnalysis.segments;
        expect(heredocAnalysis.segments).toHaveLength(1);
        expect(heredoc).toMatchObject({
            language: "python",
            origin: "heredoc",
            formattable: true,
            formatted: true,
        });

        if (heredoc?.start === undefined || heredoc.end === undefined)
            throw new Error("Expected heredoc offsets");

        expect(sha16(heredocCommand.slice(heredoc.start, heredoc.end))).toBe(heredoc.codeHash);

        const heredocFormat = eventsNamed(events, "script_format").find(
            (event) => event.codeHash === heredoc.codeHash,
        );
        expect(heredocFormat).toMatchObject({
            toolCallId: "heredoc-call",
            stage: "embedded-heredoc",
            language: "python",
            outcome: "formatted",
        });

        // The preview highlights the formatted body, so its hash is the formatter output.
        expect(eventsNamed(events, "syntax_highlight")).toContainEqual(
            expect.objectContaining({
                language: "python",
                codeHash: heredocFormat?.outputHash,
                outcome: "highlighted",
            }),
        );

        const inlineAnalysis = analysisFor(events, "inline-call");
        const [inline] = inlineAnalysis.segments;
        expect(inlineAnalysis.segments).toHaveLength(1);
        expect(inline).toMatchObject({
            language: "javascript",
            origin: "inline",
            formattable: false,
            codeHash: sha16('console.log("inline")'),
        });

        if (inline?.start === undefined || inline.end === undefined)
            throw new Error("Expected inline offsets");

        expect(inlineCommand.slice(inline.start, inline.end)).toBe('console.log("inline")');
        expect(eventsNamed(events, "syntax_highlight")).toContainEqual(
            expect.objectContaining({
                language: "javascript",
                codeHash: inline.codeHash,
                outcome: "highlighted",
            }),
        );
    });

    it("explains rejected heredocs without invoking the formatter on them", async () => {
        const events = recordRenderEvents();
        const { show } = setup();
        const invalid = "def broken(:\n    pass\n";
        const command = [
            "python3 - <<'PY'",
            invalid + "PY",
            "python3 - <<PY",
            "print('$HOME')",
            "PY",
            "cat <<'EOF'",
            "plain data",
            "EOF",
            "echo done",
        ].join("\n");

        await show("rejected-call", command);

        await vi.waitUntil(() => events.some((entry) => entry.event === "script_analysis"));
        const analysis = analysisFor(events, "rejected-call");
        expect(
            analysis.segments.map(({ language, formattable, skipReason }) => ({
                language,
                formattable,
                skipReason,
            })),
        ).toEqual([
            { language: "python", formattable: false, skipReason: "malformed" },
            { language: "python", formattable: false, skipReason: "unquoted-expansion" },
            { language: "text", formattable: false, skipReason: "data-heredoc" },
        ]);

        expect(analysis.segments[0]?.codeHash).toBe(sha16(invalid));

        const rejected = new Set(analysis.segments.map((segment) => segment.codeHash));
        expect(
            eventsNamed(events, "script_format").filter((event) => rejected.has(event.codeHash)),
        ).toEqual([]);
    });

    it("joins inline awk and jq programs to their embedded-filter format and highlight events", async () => {
        const events = recordRenderEvents();
        const { show } = setup();
        const jq =
            '.items[] | select(.enabled and .visible and .archived == false) | {name: .name, owner: .owner.login, team: .owner.team} | .name | ascii_downcase | ltrimstr("tmp-") | rtrimstr("-old")';
        const awk = "{print $1}";
        const command = `jq -r '${jq}' data.json &&\n    awk '${awk}' names.txt`;

        const render = await show("filter-call", command);

        await vi.waitUntil(() => events.some((entry) => entry.event === "script_analysis"));
        const analysis = analysisFor(events, "filter-call");
        const [jqSegment, awkSegment] = analysis.segments;
        expect(analysis.segments).toHaveLength(2);
        expect(jqSegment).toMatchObject({
            language: "jq",
            origin: "inline",
            codeHash: sha16(jq),
            formattable: true,
            formatted: true,
        });

        expect(awkSegment).toMatchObject({
            language: "awk",
            origin: "inline",
            codeHash: sha16(awk),
            formattable: false,
            skipReason: "fits-width",
        });

        for (const segment of analysis.segments) {
            if (segment.start === undefined || segment.end === undefined)
                throw new Error("Expected filter offsets");

            expect(sha16(command.slice(segment.start, segment.end))).toBe(segment.codeHash);
        }

        const formats = eventsNamed(events, "script_format");
        const jqFormat = formats.find((event) => event.codeHash === jqSegment?.codeHash);
        expect(jqFormat).toMatchObject({
            toolCallId: "filter-call",
            stage: "embedded-filter",
            language: "jq",
            outcome: "formatted",
        });

        // The program starts its row, so the displayed text is exactly the formatter output.
        expect(jqSegment?.displayHash).toBe(jqFormat?.outputHash);
        expect(formats.filter((event) => event.codeHash === awkSegment?.codeHash)).toEqual([]);

        // The formatted preview may publish after the first render; highlighting follows it.
        await vi.waitUntil(async () => {
            render();
            await settleSyntaxHighlights();

            return eventsNamed(events, "syntax_highlight").some(
                (event) => event.codeHash === jqFormat?.outputHash,
            );
        });
        const highlights = eventsNamed(events, "syntax_highlight");
        expect(highlights).toContainEqual(
            expect.objectContaining({ language: "jq", codeHash: jqFormat?.outputHash }),
        );

        expect(highlights).toContainEqual(
            expect.objectContaining({ language: "awk", codeHash: awkSegment?.codeHash }),
        );
    });

    it("keeps a commented jq program as submitted and records why it was not formatted", async () => {
        const events = recordRenderEvents();
        const { show } = setup();
        const jq =
            '.items[] # visible entries only\n| select(.enabled and .visible and .archived == false) | {name: .name, owner: .owner.login, team: .owner.team} | .name | ascii_downcase | ltrimstr("tmp-")';
        const command = `jq -r '${jq}' data.json`;

        await show("commented-call", command);

        await vi.waitUntil(() => events.some((entry) => entry.event === "script_analysis"));
        const analysis = analysisFor(events, "commented-call");
        expect(analysis.segments).toEqual([
            expect.objectContaining({
                language: "jq",
                codeHash: sha16(jq),
                formattable: false,
                skipReason: "comment",
            }),
        ]);

        expect(analysis.segments[0]?.formatted).toBeUndefined();
        expect(analysis.segments[0]?.displayHash).toBeUndefined();
        expect(
            eventsNamed(events, "script_format").filter((event) => event.language === "jq"),
        ).toEqual([]);

        expect(eventsNamed(events, "syntax_highlight")).toContainEqual(
            expect.objectContaining({ language: "jq", codeHash: sha16(jq) }),
        );
    });

    it("records completed embedded decisions even with statement streaming enabled", async () => {
        const events = recordRenderEvents();
        const { showStreamed } = setup();
        const commented = ".items[] # visible only\n| .name";
        const plain = ".items[] | .name";
        const command = `jq '${commented}' a.json && jq "${plain}" b.json && jq '${plain}' c.json`;

        await showStreamed("streamed-filters", command);

        await vi.waitUntil(() => events.some((entry) => entry.event === "script_analysis"));
        expect(
            analysisFor(events, "streamed-filters").segments.map(
                ({ language, codeHash, formattable, skipReason }) => ({
                    language,
                    codeHash,
                    formattable,
                    skipReason,
                }),
            ),
        ).toEqual([
            {
                language: "jq",
                codeHash: sha16(commented),
                formattable: false,
                skipReason: "fits-width",
            },
            {
                language: "jq",
                codeHash: sha16(plain),
                formattable: false,
                skipReason: "double-quoted",
            },
            {
                language: "jq",
                codeHash: sha16(plain),
                formattable: false,
                skipReason: "fits-width",
            },
        ]);
    });

    it("joins completed embedded formatting to analysis with streaming configured", async () => {
        const events = recordRenderEvents();
        const { showStreamed } = setup();
        const heredoc = "python3 - <<'PY'\na=1;b=2\nprint(a+b)\nPY\necho done";
        const jq =
            '.items[] | select(.enabled and .visible and .archived == false) | {name: .name, owner: .owner.login, team: .owner.team} | .name | ascii_downcase | ltrimstr("tmp-") | rtrimstr("-old")';
        await showStreamed("complete-heredoc", heredoc);
        await showStreamed("complete-filter", `jq '${jq}' data.json`);

        for (const toolCallId of ["complete-heredoc", "complete-filter"]) {
            await vi.waitUntil(() =>
                events.some(
                    (entry) =>
                        entry.event === "script_analysis" && entry.fields.toolCallId === toolCallId,
                ),
            );
            const analysis = analysisFor(events, toolCallId);
            expect(analysis.segments).toHaveLength(1);
            const [segment] = analysis.segments;
            expect(segment).toMatchObject({ formattable: true, formatted: true });
            const formats = events
                .filter((entry) => entry.event === "script_format")
                .map((entry) => Value.Parse(statementEventSchema, entry.fields));
            let stage = "embedded-filter";
            if (toolCallId === "complete-heredoc") stage = "embedded-heredoc";

            expect(formats).toContainEqual(
                expect.objectContaining({
                    toolCallId,
                    segmentHash: segment?.codeHash,
                    stage,
                }),
            );

            expect(
                formats.filter(
                    (event) => event.toolCallId === toolCallId && event.stage === "statement",
                ),
            ).toEqual([]);
        }
    });

    it("attributes completed format events to the tool call and its segment", async () => {
        const events = recordRenderEvents();
        const { showStreamed } = setup();
        const code = "a = 1;b = 2\nprint(a + b)";
        const command = `python3 -c '${code}'`;

        await showStreamed("statement-call", command);

        await vi.waitUntil(() =>
            eventsNamed(events, "script_format").some((event) => event.stage === "block"),
        );
        const [segment] = analysisFor(events, "statement-call").segments;
        expect(segment).toMatchObject({ language: "python", origin: "standalone" });

        const statements = events
            .filter((entry) => entry.event === "script_format")
            .map((entry) => Value.Parse(statementEventSchema, entry.fields))
            .filter((event) => event.stage === "block");
        expect(statements.length).toBeGreaterThan(0);
        expect(
            eventsNamed(events, "script_format").every((event) => event.stage !== "statement"),
        ).toBe(true);

        expect(new Set(statements.map((event) => event.codeHash))).toEqual(
            new Set([segment?.codeHash]),
        );

        for (const event of statements)
            expect(event).toMatchObject({
                toolCallId: "statement-call",
                segmentHash: segment?.codeHash,
            });

        expect(statements.map((event) => event.codeHash)).toContain(segment?.codeHash);
    });
});
