import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    createCommandScriptFormatter,
    formatScriptInvocation,
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
        const markerFile = join(
            mkdtempSync(join(tmpdir(), "pi-glowup-formatter-test-")),
            "start.marker",
        );
        const script = `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'started'); process.stdin.pipe(process.stdout);`;
        const commands = new Map([["python", [process.execPath, "-e", script]]]);
        const formatter = createCommandScriptFormatter(commands);
        const invocation = { label: "Python", language: "python", code: "print(1)" };
        const controller = new AbortController();
        controller.abort();

        await expect(
            formatScriptInvocation(invocation, formatter, { signal: controller.signal }),
        ).resolves.toEqual(invocation);
        expect(existsSync(markerFile)).toBe(false);
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

        await vi.waitUntil(() => {
            if (!existsSync(logFile)) return false;
            const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
            return lines.length >= 2;
        });

        const cancelledResult = formatScriptInvocation(cancelled, formatter, {
            signal: controller.signal,
        });
        controller.abort();

        writeFileSync(releaseFile, "go");

        await expect(cancelledResult).resolves.toEqual(cancelled);
        await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
            { label: "Python", language: "python", code: "print(1) formatted" },
            { label: "Python", language: "python", code: "print(2) formatted" },
        ]);

        const executedJobs = readFileSync(logFile, "utf8").trim().split("\n");
        expect(executedJobs).toEqual(["print(1)", "print(2)"]);
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
