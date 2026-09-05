import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    createCommandScriptFormatter,
    formatScriptInvocation,
    getScriptFormatterWorkload,
    parseScriptFormatterCommands,
    parseScriptFormatterCommandsValue,
} from "../src/script-preview/formatters.ts";

describe("script formatter settings", () => {
    it("leaves formatter commands empty by default", () => {
        expect(parseScriptFormatterCommands(undefined).size).toBe(0);
        expect(parseScriptFormatterCommands("").size).toBe(0);
    });

    it("reports invalid formatter JSON", () => {
        const warnings: string[] = [];

        expect(
            parseScriptFormatterCommands("not json", {
                source: "PI_GLOWUP_SCRIPT_FORMATTERS",
                reportWarning: (message) => warnings.push(message),
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
                python: ["black", "-"],
                javascript: [],
                typescript: [""],
                ruby: ["ruby\0"],
            },
            {
                source: "config.scriptPreview.formatters",
                reportWarning: (message) => warnings.push(message),
            },
        );

        expect(commands.get("python")).toEqual(["black", "-"]);
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
                python: ["black", "-q", "-"],
                javascript: ["prettier", "--parser", "babel"],
            }),
        );

        expect(commands.get("python")).toEqual(["black", "-q", "-"]);
        expect(commands.get("javascript")).toEqual(["prettier", "--parser", "babel"]);
    });

    it("applies configured command formatters by language", async () => {
        const commands = parseScriptFormatterCommands(
            JSON.stringify({
                python: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
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

    it("skips command formatters for oversized inputs", async () => {
        const commands = parseScriptFormatterCommands(
            JSON.stringify({
                python: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
            }),
        );
        const formatter = createCommandScriptFormatter(commands);
        const code = "print(1)\n".repeat(10_000);

        await expect(
            formatScriptInvocation({ label: "Python", language: "python", code }, formatter),
        ).resolves.toEqual({ label: "Python", language: "python", code });
    });

    it("reuses successful formatting for identical language source", async () => {
        const formatter = createCommandScriptFormatter(
            new Map([
                [
                    "python",
                    [
                        process.execPath,
                        "-e",
                        "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(process.pid+':'+s))",
                    ],
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
            new Map([["python", [process.execPath, "-e", "process.exit(1)"]]]),
        );
        const emptyFormatter = createCommandScriptFormatter(
            new Map([["python", [process.execPath, "-e", "process.stdin.resume()"]]]),
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
        const commands = new Map([["python", [process.execPath, "-e", script]]]);
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
            new Map([["python", [process.execPath, "-e", delayedEcho]]]),
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
            new Map([["python", [process.execPath, "-e", script]]]),
        );
        const controller = new AbortController();
        const invoke = (code: string, signal?: AbortSignal) =>
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
                expect(() => process.kill(pid, 0)).toThrow();
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
        const formatter = createCommandScriptFormatter(
            new Map([["python", [process.execPath, "-e", script]]]),
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
            expect(() => process.kill(pid, 0)).toThrow();
        } finally {
            controller.abort();
            await pending;
            await vi.waitUntil(() => getScriptFormatterWorkload().active === 0);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accounts repeated same-key concurrent replacements without evicting retained outputs", async () => {
        const formatter = createCommandScriptFormatter(
            new Map([
                [
                    "python",
                    [
                        process.execPath,
                        "-e",
                        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(process.pid+':'+'é'.repeat(350000)))",
                    ],
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
            expect(results[0]?.code).not.toBe(results[1]?.code);
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
