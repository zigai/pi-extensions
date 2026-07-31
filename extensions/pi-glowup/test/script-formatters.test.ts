import { describe, expect, it } from "vitest";
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
        const commands = new Map([
            ["python", [process.execPath, "-e", "process.stdin.pipe(process.stdout)"]],
        ]);
        const formatter = createCommandScriptFormatter(commands);
        const invocation = { label: "Python", language: "python", code: "print(1)" };
        const controller = new AbortController();
        controller.abort();

        await expect(
            formatScriptInvocation(invocation, formatter, { signal: controller.signal }),
        ).resolves.toEqual(invocation);
    });

    it("removes cancelled formatter work while it is queued", async () => {
        const delayedEcho = [
            "let input = '';",
            "process.stdin.on('data', (chunk) => { input += chunk; });",
            "process.stdin.on('end', () => setTimeout(() => process.stdout.write(input), 100));",
        ].join("");
        const formatter = createCommandScriptFormatter(
            new Map([["python", [process.execPath, "-e", delayedEcho]]]),
        );
        const first = { label: "Python", language: "python", code: "print(1)" };
        const second = { label: "Python", language: "python", code: "print(2)" };
        const cancelled = { label: "Python", language: "python", code: "print(3)" };
        const controller = new AbortController();

        const firstResult = formatScriptInvocation(first, formatter);
        const secondResult = formatScriptInvocation(second, formatter);
        const cancelledResult = formatScriptInvocation(cancelled, formatter, {
            signal: controller.signal,
        });
        controller.abort();

        await expect(cancelledResult).resolves.toEqual(cancelled);
        await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([first, second]);
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
