import { describe, expect, it } from "vitest";
import {
    createCommandScriptFormatter,
    formatScriptInvocation,
    parseScriptFormatterCommands,
    parseScriptFormatterCommandsValue,
} from "../src/script-formatters.ts";

describe("script formatter settings", () => {
    it("leaves formatter commands empty by default", () => {
        expect(parseScriptFormatterCommands(undefined).size).toBe(0);
        expect(parseScriptFormatterCommands("").size).toBe(0);
    });

    it("reports invalid formatter JSON", () => {
        const warnings: string[] = [];

        expect(
            parseScriptFormatterCommands("not json", {
                source: "PI_CODEX_LOOK_SCRIPT_FORMATTERS",
                reportWarning: (message) => warnings.push(message),
            }).size,
        ).toBe(0);

        expect(warnings).toEqual([
            "[pi-codex-look] Ignoring invalid PI_CODEX_LOOK_SCRIPT_FORMATTERS: expected JSON object",
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
            "[pi-codex-look] Ignoring invalid formatter command entries in config.scriptPreview.formatters: javascript, typescript, ruby",
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
