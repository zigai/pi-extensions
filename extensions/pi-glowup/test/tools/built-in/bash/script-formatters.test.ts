import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";
import type { ScriptFormatterProfile } from "../../../../src/settings-input.ts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { configureRenderDiagnostics } from "../../../../src/diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../../src/diagnostics/logger.ts";
import { renderScriptCall } from "../../../../src/tools/built-in/bash/script-renderer.ts";
import {
    createCommandScriptFormatter,
    formatScriptInvocation,
    getScriptFormatterWorkload,
    parseScriptFormatterCommands,
    parseScriptFormatterCommandsValue,
} from "../../../../src/tools/built-in/bash/formatter.ts";

describe("script formatter settings", () => {
    it("fits Python imports, class and function bodies after compacting structural gaps", async () => {
        const code =
            "import math\n\n\nclass Sample:\n    pass\n\n\ndef read():\n    return 1\n\n\nassert read() == 1";
        const invocation = { label: "Python", language: "python", code };
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                python: {
                    kind: "command",
                    command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
                },
            }),
        );
        const formatted = await formatScriptInvocation(invocation, formatter);
        const component = renderScriptCall(
            { fg: (_token, text) => text, bold: (text) => text },
            formatted,
            {
                state: "success",
                expanded: false,
                maxCodePreviewLines: 8,
            },
        );

        const expected = [
            "$ import math",
            "  class Sample:",
            "      pass",
            "  def read():",
            "      return 1",
            "  assert read() == 1",
        ];

        const rows = (width: number) =>
            component.render(width).map((line) => stripVTControlCharacters(line));

        expect(rows(80)).toEqual(expected);
        expect(rows(24)).toEqual(expected);
        expect(rows(80)).toEqual(expected);
        expect(invocation.code).toBe(code);
    });

    it.each([
        ["triple double string", 'text = """first\n\nclass Literal:\n\nlast"""'],
        ["raw triple single string", "text = r'''first\n\nlast'''"],
        ["byte string", 'text = b"""first\n\nlast"""'],
        ["formatted string", 'text = f"""first {1}\n\nlast"""'],
        ["parenthesized content", "values = (\n    1,\n\n    2,\n)"],
        ["list content", "values = [\n    1,\n\n    2,\n]"],
        ["continued statement", "value = 1 + \\\n\n2"],
        ["suite grouping", "def read():\n    first = 1\n\n    return first"],
        ["comment grouping", "first = 1\n\n# group\n\nsecond = 2"],
        ["inline comment grouping", "first = 1  # group\n\nsecond = 2"],
        ["incomplete string", 'text = """first\n\nlast'],
    ])("retains %s blank rows while compacting structural spacing", async (_name, content) => {
        const prefix = "import math\n\nclass Sample:\n    pass\n\nassert True\n";

        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                python: {
                    kind: "command",
                    command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
                },
            }),
        );
        const formatted = await formatScriptInvocation(
            { label: "Python", language: "python", code: prefix + content },
            formatter,
        );

        expect(formatted.code).toBe(
            "import math\nclass Sample:\n    pass\nassert True\n" + content,
        );
    });

    it("compacts JavaScript objects with Oxfmt at the requested display width", async () => {
        const executable = join(
            dirname(createRequire(import.meta.url).resolve("oxfmt/package.json")),
            "bin",
            "oxfmt",
        );
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                javascript: { kind: "javascript", command: [executable] },
            }),
        );
        const invocation = {
            label: "Node",
            language: "javascript",
            code: "const entry = {\n  alpha: 1,\n  beta: 2,\n};",
        };
        const wide = await formatScriptInvocation(invocation, formatter, { targetWidth: 80 });
        expect(wide.code).toBe("const entry = { alpha: 1, beta: 2 };");
        const narrow = await formatScriptInvocation(invocation, formatter, { targetWidth: 20 });
        expect(narrow.code).toBe("const entry = {\n  alpha: 1,\n  beta: 2,\n};");
        expect(invocation.code).toBe("const entry = {\n  alpha: 1,\n  beta: 2,\n};");
    });

    it("selects the TypeScript parser for compact typed scripts", async () => {
        const executable = join(
            dirname(createRequire(import.meta.url).resolve("oxfmt/package.json")),
            "bin",
            "oxfmt",
        );
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                typescript: { kind: "typescript", command: [executable] },
            }),
        );
        const formatted = await formatScriptInvocation(
            {
                label: "TypeScript",
                language: "typescript",
                code: "const entries:number[]=[1,2,3];",
            },
            formatter,
            { targetWidth: 80 },
        );
        expect(formatted.code).toBe("const entries: number[] = [1, 2, 3];");
    });

    it("uses the TypeScript profile with the TSX parser and a separate syntax cache key", async () => {
        const executable = join(
            dirname(createRequire(import.meta.url).resolve("oxfmt/package.json")),
            "bin",
            "oxfmt",
        );
        const warnings: string[] = [];
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                typescript: { kind: "typescript", command: [executable] },
            }),
            (message) => {
                warnings.push(message);
            },
        );
        const invocation = {
            label: "TSX",
            language: "tsx",
            code: 'const view=<div title="ready">hello</div>;',
        };
        const formatted = await formatScriptInvocation(invocation, formatter);
        expect(formatted.code).toBe('const view = <div title="ready">hello</div>;');
        expect(formatter?.profileFor?.("tsx")).toEqual(formatter?.profileFor?.("typescript"));
        expect(warnings).toEqual([]);

        // The same bytes are invalid as a TypeScript type assertion; a cached
        // TSX success must not bypass the actual .ts parser.
        await expect(
            formatScriptInvocation({ ...invocation, language: "typescript" }, formatter),
        ).resolves.toEqual({ ...invocation, language: "typescript" });
        expect(warnings).toEqual(["[pi-glowup] typescript display formatter exited with status 2"]);
    });

    it("reports an unavailable configured formatter once without exposing source", async () => {
        const warnings: string[] = [];
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                javascript: { kind: "javascript", command: ["/missing/display-formatter"] },
            }),
            (message) => {
                warnings.push(message);
            },
        );
        const invocation = {
            label: "Node",
            language: "javascript",
            code: "const privateValue = 1;",
        };
        await expect(
            formatScriptInvocation(invocation, formatter, { targetWidth: 80 }),
        ).resolves.toEqual(invocation);
        await expect(
            formatScriptInvocation(invocation, formatter, { targetWidth: 40 }),
        ).resolves.toEqual(invocation);
        expect(warnings).toEqual(["[pi-glowup] javascript display formatter executable not found"]);
    });

    it("reports a formatter exit status once without exposing its input or stderr", async () => {
        const warnings: string[] = [];
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                bash: {
                    kind: "command",
                    command: [
                        process.execPath,
                        "-e",
                        "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('private formatter detail');process.exitCode=7;})",
                    ],
                },
            }),
            (message) => {
                warnings.push(message);
            },
        );
        const invocation = { label: "Bash", language: "bash", code: "echo private-input" };
        for (const targetWidth of [80, 40])
            await expect(
                formatScriptInvocation(invocation, formatter, { targetWidth }),
            ).resolves.toEqual(invocation);

        expect(warnings).toEqual(["[pi-glowup] bash display formatter exited with status 7"]);
    });

    it("records failed formatter outcomes with exit details only while diagnostics are on", async () => {
        const events: { readonly event: string; readonly fields: DebugLogFields }[] = [];
        configureRenderDiagnostics((event, fields) => events.push({ event, fields: fields() }));
        onTestFinished(() => configureRenderDiagnostics(undefined));
        const warnings: string[] = [];
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                bash: {
                    kind: "command",
                    command: [
                        process.execPath,
                        "-e",
                        "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('formatter detail');process.exitCode=7;})",
                    ],
                },
                javascript: { kind: "javascript", command: ["/missing/display-formatter"] },
            }),
            (message) => {
                warnings.push(message);
            },
        );
        const shell = { label: "Bash", language: "bash", code: "echo input" };
        const node = { label: "Node", language: "javascript", code: "const value = 1;" };

        await expect(
            formatScriptInvocation(shell, formatter, {
                targetWidth: 60,
                diagnostics: { toolCallId: "call-7", stage: "preview" },
            }),
        ).resolves.toEqual(shell);
        await formatScriptInvocation(node, formatter);
        await formatScriptInvocation({ ...node, language: "ruby" }, formatter);

        expect(events.map((entry) => entry.fields)).toEqual([
            expect.objectContaining({
                toolCallId: "call-7",
                stage: "preview",
                language: "bash",
                profileKind: "command",
                targetWidth: 60,
                outcome: "failed",
                exitCode: 7,
                stderr: "formatter detail",
            }),
            expect.objectContaining({ language: "javascript", outcome: "missing-executable" }),
            expect.objectContaining({ language: "ruby", outcome: "no-profile" }),
        ]);
        // stderr goes only to the private log, never to user-facing warnings.
        expect(warnings.join("\n")).not.toContain("formatter detail");

        configureRenderDiagnostics(undefined);
        await formatScriptInvocation({ ...shell, code: "echo other" }, formatter);
        expect(events).toHaveLength(3);
    });

    it("leaves formatter commands empty by default", () => {
        expect(parseScriptFormatterCommands(undefined).size).toBe(0);
        expect(parseScriptFormatterCommands("").size).toBe(0);
    });

    it("reports invalid formatter JSON", () => {
        const warnings: string[] = [];

        expect(
            parseScriptFormatterCommands("not json", {
                source: "PI_GLOWUP_SCRIPT_FORMATTERS",
                reportWarning: (message) => {
                    warnings.push(message);
                },
            }).size,
        ).toBe(0);

        expect(warnings).toEqual([
            "[pi-glowup] Ignoring invalid PI_GLOWUP_SCRIPT_FORMATTERS: expected JSON object",
        ]);
    });

    it("reports invalid formatter command entries", () => {
        const warnings: string[] = [];
        const commands = parseScriptFormatterCommandsValue(
            {
                python: { kind: "command", command: ["black", "-"] },
                javascript: { kind: "command", command: [] },
                typescript: { kind: "command", command: [""] },
                ruby: { kind: "command", command: ["ruby\0"] },
            },
            {
                source: "config.scriptPreview.formatters",
                reportWarning: (message) => {
                    warnings.push(message);
                },
            },
        );

        expect(commands.get("python")).toEqual({ kind: "command", command: ["black", "-"] });
        expect(commands.has("javascript")).toBe(false);
        expect(commands.has("typescript")).toBe(false);
        expect(commands.has("ruby")).toBe(false);
        expect(warnings).toEqual([
            "[pi-glowup] Ignoring invalid formatter command entries in config.scriptPreview.formatters: javascript, typescript, ruby",
        ]);
    });

    it("parses language formatter commands from JSON", () => {
        const commands = parseScriptFormatterCommands(
            JSON.stringify({
                python: { kind: "command", command: ["black", "-q", "-"] },
                javascript: { kind: "command", command: ["prettier", "--parser", "babel"] },
            }),
        );

        expect(commands.get("python")).toEqual({ kind: "command", command: ["black", "-q", "-"] });
        expect(commands.get("javascript")).toEqual({
            kind: "command",
            command: ["prettier", "--parser", "babel"],
        });
    });

    it("applies configured command formatters by language", async () => {
        const commands = parseScriptFormatterCommands(
            JSON.stringify({
                python: {
                    kind: "command",
                    command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
                },
            }),
        );
        const formatter = createCommandScriptFormatter(commands);

        await expect(
            formatScriptInvocation(
                { label: "Python", language: "python", code: "print(1)\n" },
                formatter,
            ),
        ).resolves.toEqual({ label: "Python", language: "python", code: "print(1)" });
        await expect(
            formatScriptInvocation(
                { label: "Node", language: "javascript", code: "console.log(1)" },
                formatter,
            ),
        ).resolves.toEqual({ label: "Node", language: "javascript", code: "console.log(1)" });
    });

    it("substitutes width placeholders and passes environment variables", async () => {
        const commands = parseScriptFormatterCommands(
            JSON.stringify({
                python: {
                    kind: "command",
                    command: [
                        process.execPath,
                        "-e",
                        "process.stdout.write(process.argv[1] + ':' + process.env.TUFF_LINE_LENGTH)",
                        "{width}",
                    ],
                },
            }),
        );
        const formatter = createCommandScriptFormatter(commands);

        await expect(
            formatScriptInvocation(
                { label: "Python", language: "python", code: "code" },
                formatter,
                { targetWidth: 76 },
            ),
        ).resolves.toEqual({ label: "Python", language: "python", code: "76:76" });
    });

    it("skips command formatters for oversized inputs", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-glowup-formatter-limit-"));
        const marker = join(dir, "started");
        try {
            const commands = parseScriptFormatterCommands(
                JSON.stringify({
                    python: {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "require('node:fs').writeFileSync(process.argv[1], 'started');process.stdout.write('FORMATTER_RAN')",
                            marker,
                        ],
                    },
                }),
            );
            const formatter = createCommandScriptFormatter(commands);
            const code = "print(1)\n".repeat(10_000);

            await expect(
                formatScriptInvocation({ label: "Python", language: "python", code }, formatter),
            ).resolves.toEqual({ label: "Python", language: "python", code });
            expect(existsSync(marker)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reuses successful formatting for identical language source", async () => {
        const formatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                [
                    "python",
                    {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(process.pid+':'+s))",
                        ],
                    },
                ],
            ]),
        );
        const invocation = { label: "Python", language: "python", code: "print(1)" };

        const first = await formatScriptInvocation(invocation, formatter);
        const second = await formatScriptInvocation(invocation, formatter);

        expect(second.code).toBe(first.code);
        expect(first.code).toMatch(/^\d+:print\(1\)$/u);
    });

    it("falls back when command formatters fail or return empty output", async () => {
        const invocation = { label: "Python", language: "python", code: "print(1)" };
        const failingFormatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                [
                    "python",
                    { kind: "command", command: [process.execPath, "-e", "process.exit(1)"] },
                ],
            ]),
        );
        const emptyFormatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                [
                    "python",
                    {
                        kind: "command",
                        command: [process.execPath, "-e", "process.stdin.resume()"],
                    },
                ],
            ]),
        );

        await expect(formatScriptInvocation(invocation, failingFormatter)).resolves.toEqual(
            invocation,
        );
        await expect(formatScriptInvocation(invocation, emptyFormatter)).resolves.toEqual(
            invocation,
        );
    });

    it("does not start command formatters after cancellation", async () => {
        const testDir = mkdtempSync(join(tmpdir(), "pi-glowup-formatter-test-"));
        const markerFile = join(testDir, "start.marker");
        const script = [
            `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'started');`,
            "let input = '';",
            "process.stdin.on('data', chunk => input += chunk);",
            "process.stdin.on('end', () => process.stdout.write(input + ' formatted'));",
        ].join("\n");

        const commands = new Map<string, ScriptFormatterProfile>([
            ["python", { kind: "command", command: [process.execPath, "-e", script] }],
        ]);

        const formatter = createCommandScriptFormatter(commands);
        const invocation = { label: "Python", language: "python", code: "print(1)" };
        const controller = new AbortController();
        controller.abort();

        try {
            await expect(
                formatScriptInvocation(invocation, formatter, { signal: controller.signal }),
            ).resolves.toEqual(invocation);
            expect(existsSync(markerFile)).toBe(false);
        } finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("removes cancelled formatter work while it is queued", async () => {
        const testDir = mkdtempSync(join(tmpdir(), "pi-glowup-formatter-queue-"));
        const releaseFile = join(testDir, "release.flag");
        const logFile = join(testDir, "executions.log");

        const delayedEcho = [
            "const fs = require('fs');",
            "let input = '';",
            "process.stdin.on('data', (chunk) => { input += chunk; });",
            "process.stdin.on('end', () => {",
            `  fs.appendFileSync(${JSON.stringify(logFile)}, input.trim() + '\\n');`,
            "  const check = () => {",
            `    if (fs.existsSync(${JSON.stringify(releaseFile)})) {`,
            "      process.stdout.write(input + ' formatted');",
            "    } else {",
            "      setTimeout(check, 10);",
            "    }",
            "  };",
            "  check();",
            "});",
        ].join("\n");

        const formatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                ["python", { kind: "command", command: [process.execPath, "-e", delayedEcho] }],
            ]),
        );
        const first = { label: "Python", language: "python", code: "print(1)" };
        const second = { label: "Python", language: "python", code: "print(2)" };
        const cancelled = { label: "Python", language: "python", code: "print(3)" };
        const controller = new AbortController();

        const firstResult = formatScriptInvocation(first, formatter);
        const secondResult = formatScriptInvocation(second, formatter);

        const pendingResults = [firstResult, secondResult];
        try {
            // Each distinct marker proves one live slot is occupied; startup order is irrelevant.
            await vi.waitUntil(() => {
                if (!existsSync(logFile)) return false;

                const jobs = readFileSync(logFile, "utf8").trim().split("\n");
                return jobs.includes(first.code) && jobs.includes(second.code);
            });

            const cancelledResult = formatScriptInvocation(cancelled, formatter, {
                signal: controller.signal,
            });
            pendingResults.push(cancelledResult);
            controller.abort();

            writeFileSync(releaseFile, "go");

            await expect(cancelledResult).resolves.toEqual(cancelled);
            await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
                { label: "Python", language: "python", code: "print(1) formatted" },
                { label: "Python", language: "python", code: "print(2) formatted" },
            ]);

            const executedJobs = readFileSync(logFile, "utf8").trim().split("\n").sort();
            expect(executedJobs).toEqual([first.code, second.code].sort());
        } finally {
            controller.abort();
            writeFileSync(releaseFile, "go");
            await Promise.allSettled(pendingResults);
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("keeps cancelled live children in their slots until real closure", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-glowup-formatter-close-"));
        const script = [
            "const fs = require('fs');",
            `const dir = ${JSON.stringify(dir)};`,
            "let input = '';",
            "process.stdin.on('data', chunk => input += chunk);",
            "process.stdin.on('end', () => {",
            "  if (input === 'third') {",
            "    const alive = ['first', 'second'].filter(name => {",
            "      const pid = Number(fs.readFileSync(dir + '/' + name, 'utf8'));",
            "      try { process.kill(pid, 0); return true; } catch { return false; }",
            "    });",
            "    process.stdout.write(alive.length <= 1 ? 'within limit' : 'too many live children');",
            "    return;",
            "  }",
            "  process.on('SIGTERM', () => {});",
            "  setInterval(() => {}, 100);",
            "  fs.writeFileSync(dir + '/' + input, String(process.pid));",
            "});",
        ].join("\n");
        const formatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                ["python", { kind: "command", command: [process.execPath, "-e", script] }],
            ]),
        );
        const controller = new AbortController();
        const invoke = async (code: string, signal?: AbortSignal) =>
            formatScriptInvocation(
                { label: "Python", language: "python", code },
                formatter,
                signal === undefined ? {} : { signal },
            );

        const pending = [invoke("first", controller.signal), invoke("second", controller.signal)];
        try {
            await vi.waitUntil(
                () => existsSync(join(dir, "first")) && existsSync(join(dir, "second")),
            );
            pending.push(invoke("third"));
            expect(getScriptFormatterWorkload()).toEqual({ active: 2, queued: 1 });
            controller.abort();
            await expect(Promise.all(pending.slice(0, 2))).resolves.toEqual([
                { label: "Python", language: "python", code: "first" },
                { label: "Python", language: "python", code: "second" },
            ]);
            expect(getScriptFormatterWorkload()).toEqual({ active: 2, queued: 1 });

            // Escalation must close both SIGTERM-resistant children, not merely settle promises.
            // The third child may start after the first close, while the second still owns a slot.
            const results = await Promise.all(pending);
            expect(results[2]?.code).toBe("within limit");
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);

            for (const name of ["first", "second"]) {
                const pid = Number(readFileSync(join(dir, name), "utf8"));
                expect(() => process.kill(pid, 0)).toThrow("ESRCH");
            }
        } finally {
            controller.abort();
            await Promise.allSettled(pending);
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it.each(["timeout", "overflow"])("owns cleanup after %s fallback", async (failure) => {
        const dir = mkdtempSync(join(tmpdir(), "pi-glowup-formatter-failure-"));
        const marker = join(dir, "pid");
        const script = [
            "process.on('SIGTERM', () => {});",
            "setInterval(() => {}, 100);",
            `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
            "process.stdin.resume();",
            failure === "overflow" ? "process.stdout.write('x'.repeat(1024 * 1024 + 1));" : "",
        ].join("\n");
        const warnings: string[] = [];
        const formatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                ["python", { kind: "command", command: [process.execPath, "-e", script] }],
            ]),
            (message) => {
                warnings.push(message);
            },
        );
        const controller = new AbortController();
        const invocation = { label: "Python", language: "python", code: failure };
        const pending = formatScriptInvocation(invocation, formatter, {
            signal: controller.signal,
        });
        try {
            await expect(pending).resolves.toEqual(invocation);
            expect(existsSync(marker)).toBe(true);
            expect(getScriptFormatterWorkload()).toEqual({ active: 1, queued: 0 });
            const pid = Number(readFileSync(marker, "utf8"));
            process.kill(pid, 0); // Fallback happened while the real child still existed.
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
            expect(() => process.kill(pid, 0)).toThrow("ESRCH");
            let reason = "timed out after 1000 ms";
            if (failure === "overflow") reason = "output exceeded 1048576 bytes";
            expect(warnings).toEqual([`[pi-glowup] python display formatter ${reason}`]);
        } finally {
            controller.abort();
            await pending;
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accounts repeated same-key concurrent replacements without evicting retained outputs", async () => {
        const formatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                [
                    "python",
                    {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.pid+':'+'é'.repeat(350000)))",
                        ],
                    },
                ],
            ]),
        );
        const retained: Array<{ code: string; output: string }> = [];
        for (const code of ["one", "two", "three", "four"]) {
            const invocation = { label: "Python", language: "python", code };

            // Both misses happen before the first await; each caller retains independent work.
            const results = await Promise.all([
                formatScriptInvocation(invocation, formatter),
                formatScriptInvocation(invocation, formatter),
            ]);
            expect(results[0].code).not.toBe(results[1].code);

            for (const result of results) expect(result.code).toMatch(/^\d+:é+$/u);
            const cached = await formatScriptInvocation(invocation, formatter);
            expect(results.map((result) => result.code)).toContain(cached.code);
            retained.push({ code, output: cached.code });
        }

        // Four retained values consume about 2.8 MiB, not the 5.6 MiB of eight completions.
        for (const { code, output } of retained) {
            await expect(
                formatScriptInvocation({ label: "Python", language: "python", code }, formatter),
            ).resolves.toEqual({ label: "Python", language: "python", code: output });
        }
    });

    it("reuses a formatter result completed while an identical request was queued", async () => {
        const formatter = createCommandScriptFormatter(
            new Map<string, ScriptFormatterProfile>([
                [
                    "javascript",
                    {
                        kind: "command",
                        command: [
                            process.execPath,
                            "-e",
                            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(String(process.pid)))",
                        ],
                    },
                ],
            ]),
        );
        const invocation = { label: "Node", language: "javascript", code: "console.log(1)" };
        const [first, second, queued] = await Promise.all([
            formatScriptInvocation(invocation, formatter),
            formatScriptInvocation(invocation, formatter),
            formatScriptInvocation(invocation, formatter),
        ]);

        expect(first.code).not.toBe(second.code);
        expect([first.code, second.code]).toContain(queued.code);
    });

    it("falls back to the original script when a formatter throws", async () => {
        await expect(
            formatScriptInvocation(
                { label: "Python", language: "python", code: "print(1)" },
                async () => {
                    throw new Error("formatter failed");
                },
            ),
        ).resolves.toEqual({ label: "Python", language: "python", code: "print(1)" });
    });
});

// gawk and jqfmt are not test dependencies. These stand-ins reproduce the behaviours the
// display pipeline must survive: gawk's canonical layout (tabs, added print parentheses, an
// implicit `{ print }`) and both tools' rewriting of string escapes.
describe("awk and jq display formatters", () => {
    const fakeGawk = String.raw`
const { appendFileSync, readFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
const input = readFileSync(0, "utf8");
if (!input.startsWith("BEGIN")) process.exit(1);
// gawk prints string values, not their source: \x41 becomes A.
const literals = input.match(/"(?:[^"\\]|\\.)*"/g).map((text) => text.replace(/\\x41/g, "A"));
process.stdout.write([
    "BEGIN {", "\tFS = <0>", "\tlabel = <1>", "}", "",
    "$3 >= 1000 {", "\tprint($1) > <2>", "\tn++", "}", "",
    "NR > 1 {", "\tprint", "}", "",
    "END {", "\tprint n", "}", "",
].join("\n").replace(/<(\d)>/g, (_match, index) => literals[Number(index)]));
`;

    const fakeJqfmt = String.raw`
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\n");
// gojq prints decoded strings: \u00e9 becomes é.
let source = readFileSync(0, "utf8").replace(/\\u00e9/g, "é");
if (process.env.FAKE_DROP_DEFS === "1") source = source.replace(/^def [^;]*;\s*/, "");
const objects = args.includes("-ob");
const arrays = args.includes("-ar");
const stack = [];
const indent = () => "    ".repeat(1 + stack.length);
let out = "";
for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const skipSpaces = () => { while (source[index + 1] === " ") index += 1; };
    if (char === '"') {
        const end = source.indexOf('"', index + 1);
        out += source.slice(index, end + 1);
        index = end;
    } else if (char === "|" && source[index + 1] !== "=") {
        out += "| \n" + indent();
        skipSpaces();
    } else if ((char === "{" && objects) || (char === "[" && arrays)) {
        stack.push(char);
        out += char + "\n" + indent();
        skipSpaces();
    } else if ("{[(".includes(char)) {
        stack.push("inline");
        out += char;
    } else if ((char === "}" && stack.at(-1) === "{") || (char === "]" && stack.at(-1) === "[")) {
        stack.pop();
        out = out.trimEnd() + "\n" + indent() + char;
    } else if ("}])".includes(char)) {
        stack.pop();
        out += char;
    } else if (char === "," && (stack.at(-1) === "{" || stack.at(-1) === "[")) {
        out += ",\n" + indent();
        skipSpaces();
    } else {
        out += char;
    }
}
process.stdout.write(out + "\n");
`;

    function setup(env: Record<string, string> = {}) {
        const dir = mkdtempSync(join(tmpdir(), "pi-glowup-filter-formatters-"));
        const log = join(dir, "calls.log");
        writeFileSync(log, "");
        const gawk = join(dir, "gawk.cjs");
        const jqfmt = join(dir, "jqfmt.cjs");
        writeFileSync(gawk, fakeGawk);
        writeFileSync(jqfmt, fakeJqfmt);
        const previous = { ...process.env };
        Object.assign(process.env, { FAKE_LOG: log, ...env });
        const warnings: string[] = [];
        const formatter = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                awk: { kind: "awk", command: [process.execPath, gawk] },
                jq: { kind: "jq", command: [process.execPath, jqfmt] },
            }),
            (message) => {
                warnings.push(message);
            },
        );
        if (formatter === undefined) throw new Error("formatter profiles were rejected");

        return {
            formatter,
            warnings,
            calls: () =>
                readFileSync(log, "utf8")
                    .split("\n")
                    .filter((line) => line.length > 0)
                    .map((line) => {
                        const args: unknown = JSON.parse(line);
                        if (!Array.isArray(args)) throw new Error("unexpected fake log entry");
                        return args.map(String);
                    }),
            [Symbol.dispose]() {
                process.env = previous;
                rmSync(dir, { recursive: true, force: true });
            },
        };
    }

    const awkProgram = [
        String.raw`BEGIN{FS=":"; label="caf\303\251\x41"} $3>=1000{print $1 > "/dev/stderr"; n++}`,
        "NR>1",
        "END{print n}",
    ].join("\n");

    it.each([
        [
            40,
            [
                "BEGIN {",
                '  FS = ":"',
                String.raw`  label = "caf\303\251\x41"`,
                "}",
                "$3 >= 1000 {",
                '  print $1 > "/dev/stderr"',
                "  n++",
                "}",
                "NR > 1",
                "END { print n }",
            ],
        ],
        [
            70,
            [
                String.raw`BEGIN { FS = ":"; label = "caf\303\251\x41" }`,
                '$3 >= 1000 { print $1 > "/dev/stderr"; n++ }',
                "NR > 1",
                "END { print n }",
            ],
        ],
    ])("restores gawk's awk layout to the submitted tokens at %i columns", async (width, rows) => {
        using fake = setup();
        const formatted = await fake.formatter(
            {
                label: "awk",
                language: "awk",
                code: awkProgram,
                targetWidth: width,
                firstLineOffset: 10,
            },
            {},
        );

        expect(formatted).toBe(rows.join("\n"));
        expect(fake.calls()).toEqual([["--sandbox", "-o-", "-f", "-"]]);
    });

    it("never sends a program that fits, or one that would load gawk extensions", async () => {
        using fake = setup();
        const fits = await fake.formatter(
            { label: "awk", language: "awk", code: "{ print $1 }", targetWidth: 80 },
            {},
        );
        const loads = await fake.formatter(
            {
                label: "awk",
                language: "awk",
                code: '@load "filefuncs"; BEGIN { stat("/", data); print data["type"] }',
                targetWidth: 20,
            },
            {},
        );

        expect([fits, loads]).toEqual([undefined, undefined]);
        expect(fake.calls()).toEqual([]);
    });

    const jqProgram = String.raw`.items[] | select(.name | test("^caf\u00e9")) | { name: .name, tags: [.tags[] | ascii_downcase], n: ($x | tonumber) } | "\(.name): \(.n)"`;

    it.each([
        [
            100,
            [["-op", "pipe"]],
            [
                ".items[] |",
                String.raw`  select(.name | test("^caf\u00e9")) |`,
                "  { name: .name, tags: [.tags[] | ascii_downcase], n: ($x | tonumber) } |",
                String.raw`  "\(.name): \(.n)"`,
            ],
        ],
        [
            50,
            [
                ["-op", "pipe"],
                ["-op", "pipe", "-ob"],
            ],
            [
                ".items[] |",
                String.raw`  select(.name | test("^caf\u00e9")) |`,
                "  {",
                "    name: .name,",
                "    tags: [.tags[] | ascii_downcase],",
                "    n: ($x | tonumber)",
                "  } |",
                String.raw`  "\(.name): \(.n)"`,
            ],
        ],
    ])(
        "adds jq breaks only until the program fits %i columns",
        async (targetWidth, calls, rows) => {
            using fake = setup();
            const formatted = await fake.formatter(
                { label: "jq", language: "jq", code: jqProgram, targetWidth, firstLineOffset: 8 },
                {},
            );

            expect(formatted).toBe(rows.join("\n"));
            expect(fake.calls()).toEqual(calls);
        },
    );

    it("keeps jq programs whose formatting would lose comments or definitions", async () => {
        using fake = setup({ FAKE_DROP_DEFS: "1" });
        const commented = await fake.formatter(
            {
                label: "jq",
                language: "jq",
                code: ".items[] # each item\n| select(.enabled) | .name | ascii_downcase",
                targetWidth: 20,
            },
            {},
        );
        expect(fake.calls()).toEqual([]);

        const defined = await fake.formatter(
            {
                label: "jq",
                language: "jq",
                code: 'def label: .name // "#none"; .items[] | label | ascii_downcase',
                targetWidth: 20,
            },
            {},
        );

        expect([commented, defined]).toEqual([undefined, undefined]);
        // jqfmt drops definitions, so the program is never handed to it.
        expect(fake.calls()).toEqual([]);
    });

    it("treats unparseable programs as declined and reports a missing executable once", async () => {
        using fake = setup();
        const rejected = await fake.formatter(
            {
                label: "awk",
                language: "awk",
                code: `{ print $1 } ${"x".repeat(80)}`,
                targetWidth: 40,
            },
            {},
        );
        expect(rejected).toBeUndefined();
        expect(fake.warnings).toEqual([]);

        const missing = createCommandScriptFormatter(
            parseScriptFormatterCommandsValue({
                jq: { kind: "jq", command: [join(tmpdir(), "pi-glowup-missing-jqfmt")] },
            }),
            (message) => {
                fake.warnings.push(message);
            },
        );
        for (const code of [".a | .b | .c | .d | .e", ".f | .g | .h | .i | .j"])
            await missing?.({ label: "jq", language: "jq", code, targetWidth: 10 }, {});

        expect(fake.warnings).toEqual(["[pi-glowup] jq display formatter executable not found"]);
    });
});
