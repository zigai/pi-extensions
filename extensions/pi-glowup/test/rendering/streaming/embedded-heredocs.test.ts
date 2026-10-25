import { format } from "oxfmt";
import { afterEach, expect, it, vi } from "vitest";
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { createNativeBashFeature } from "../../../src/tools/built-in/bash/preview.ts";
import type { BuiltInRenderContext } from "../../../src/tools/built-in/context.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../support/theme-colors.ts";
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../src/rendering/streaming/code-stream.ts";
import {
    parseScriptFormatterCommandsValue,
    type ScriptBlockFormatter,
    type ScriptBlockFormatterInput,
} from "../../../src/tools/built-in/bash/formatter.ts";
import { heredocScriptInterpreter } from "../../../src/tools/built-in/bash/invocation.ts";

const stores: CodeStreamStore[] = [];
afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.dispose()));
});

function setup(shellProfile = true) {
    const subject = createCodeStreamStore();
    stores.push(subject);
    const inputs: ScriptBlockFormatterInput[] = [];
    const profiles = parseScriptFormatterCommandsValue({
        python: { kind: "command", command: ["unused-python-printer"] },
        javascript: { kind: "command", command: ["unused-js-printer"] },
        typescript: { kind: "command", command: ["unused-ts-printer"] },
        ...(shellProfile && { bash: { kind: "command", command: ["unused-shell-printer"] } }),
    });
    const formatter: ScriptBlockFormatter = Object.assign(
        async (input: ScriptBlockFormatterInput) => {
            inputs.push(input);

            if (!profiles.has(input.language)) return undefined;

            if (input.language === "python")
                // The real Tuff path is covered by the isolated Termtrace fixture.
                // This printer makes language dispatch and literal masking observable
                // without requiring a globally installed Python formatter in CI.
                return input.code
                    .replace(/;/gu, "\n")
                    .replace(/\b([a-zA-Z_]\w*)\s*=\s*(?!=)/gu, "$1 = ");

            if (input.language === "javascript" || input.language === "typescript") {
                const result = await format("embedded.ts", input.code, {
                    tabWidth: 2,
                    printWidth: input.targetWidth ?? 80,
                });
                expect(result.errors).toEqual([]);
                return result.code;
            }

            return input.code;
        },
        { profileFor: (language: string) => profiles.get(language) },
    );

    return { subject, formatter, inputs };
}

it.each(["statement", "block"] as const)(
    "formats both Python heredocs in place in %s mode, preserving shell and Rust literals",
    async (mode) => {
        const { subject, formatter, inputs } = setup();
        const rust = "pub fn sample() { let x = 1; let y = 2; }\n";
        const source = `python3 - <<'PY'\na=1;b=2\npayload='''${rust}'''\nprint(payload)\nPY\npython3 - <<'PY'\nc=3;print(c)\nPY\nprintf DONE\n`;
        const input = Object.freeze({
            key: "two-heredocs",
            source,
            language: "bash",
            mode,
            complete: true,
            formatter,
        });
        subject.get(input);
        await subject.settled();
        const display = subject.get(input);
        expect(display).toContain("a = 1\nb = 2\n");
        expect(display).toContain("c = 3\nprint(c)\n");
        expect(display).toContain(rust);
        expect(display).toContain("python3 - <<'PY'");
        expect(display).toContain("\nPY\npython3 - <<'PY'");
        expect(display).toContain("\nPY\nprintf DONE");
        expect(display).not.toContain("__glowup_");
        expect(inputs.filter((entry) => entry.language === "python")).toHaveLength(2);
        expect(
            inputs
                .filter((entry) => entry.language === "python")
                .every((entry) => !entry.code.includes(rust)),
        ).toBe(true);

        expect(input.source).toBe(source);
    },
);

it.each(["example.js", "example.mjs", "example.ts", "example.mts", "example.py"])(
    "formats a file-writing cat heredoc using the %s extension",
    async (path) => {
        const { subject, formatter } = setup(false);
        let body = "const entry={alpha:1,beta:2};console.log(entry);";
        if (path.endsWith(".py")) body = "a=1;b=2;print(a+b)";

        const source = `cat > ${path} <<'EOF'\n${body}\nEOF\nprintf DONE`;
        const input = {
            key: "file-heredoc",
            source,
            language: "bash",
            mode: "statement" as const,
            complete: true,
            formatter,
        };
        subject.get(input);
        await subject.settled();
        const display = subject.get(input);
        expect(display).toContain(`cat > ${path} <<'EOF'`);
        expect(display).toContain("\nEOF\nprintf DONE");

        if (path.endsWith(".py")) expect(display).toContain("a = 1\nb = 2\nprint(a+b)");
        else expect(display).toContain("const entry = { alpha: 1, beta: 2 };\nconsole.log(entry);");
    },
);

it.each([
    "cat <<'PY'\na=1;b=2\nPY",
    "cat > data.txt <<'PY'\na=1;b=2\nPY",
    "python3 script.py <<'PY'\na=1;b=2\nPY",
    "python3 -c 'print(1)' <<'PY'\na=1;b=2\nPY",
    "python3 -m json.tool <<'PY'\na=1;b=2\nPY",
    "node -e 'console.log(1)' <<'PY'\na=1;b=2\nPY",
    "python3 - 3<<'PY'\na=1;b=2\nPY",
    "python3 - <<'PY' <input\na=1;b=2\nPY",
    "python3 - <<PY\na='$HOME';b=2\nPY",
])("does not mistake a data or expanded heredoc for source: %s", async (source) => {
    const { subject, formatter, inputs } = setup();
    const input = {
        key: "data-heredoc",
        source,
        language: "bash",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    subject.get(input);
    await subject.settled();
    expect(subject.get(input)).toBe(source);
    expect(inputs.every((entry) => entry.language === "bash")).toBe(true);
});

it("holds incomplete heredoc source, then formats it once its real terminator arrives", async () => {
    const { subject, formatter, inputs } = setup();
    const input = {
        key: "partial-heredoc",
        source: "echo START\npython3 - <<'PY'\na=1;",
        language: "bash",
        mode: "statement" as const,
        complete: false,
        formatter,
    };
    subject.get(input);
    await subject.settled();
    expect(subject.get(input)).toBe("echo START");
    expect(inputs.every((entry) => entry.language === "bash")).toBe(true);
    const final = { ...input, source: input.source + "b=2\nPY\necho DONE", complete: true };
    subject.get(final);
    await subject.settled();
    expect(subject.get(final)).toBe("echo START\npython3 - <<'PY'\na = 1\nb = 2\nPY\necho DONE");
});

it("retains a body if formatting would create a premature delimiter line", async () => {
    const { subject, formatter } = setup();
    const source = "python3 - <<'PY'\nPY=1;PY;print(PY)\nPY\nprintf DONE";
    const input = {
        key: "delimiter-collision",
        source,
        language: "bash",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    subject.get(input);
    await subject.settled();
    expect(subject.get(input)).toBe(source);
});

it.each([
    ["env MODE=test uv run --offline python3 -u -", "python"],
    ["node --input-type=module -", "javascript"],
    ["cat > /tmp/a.mts", "typescript"],
    ["cat > '/tmp/a file.py'", "python"],
    ["cat > /tmp/a.tsx", "tsx"],
])("identifies stdin/file source ownership for %s", (command, language) => {
    expect(heredocScriptInterpreter(command)?.language).toBe(language);
});

it.each([true, false])(
    "formats token-mode embedded source only after completion, including expansion (Bash profile: %s)",
    async (shellProfile) => {
        const { subject, formatter } = setup(shellProfile);
        const feature = createNativeBashFeature(
            () => formatter,
            async (input, backend, options) => subject.formatEmbedded(input, backend, options),
        );
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const command = "python3 - <<'PY'\na=1;b=2\nPY\nprintf DONE";
        const context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "token-embedded",
            cwd: "/work",
            state: {},
            lastComponent: undefined,
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
        const render = (expanded: boolean, width = 100) =>
            stripVTControlCharacters(
                feature
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
        try {
            feature.schedule({
                toolCallId: context.toolCallId,
                command,
                formatter,
                signal: undefined,
                isCurrent: () => true,
                invalidate: context.invalidate,
            });

            render(false);
            await subject.settled();
            expect(render(false)).toContain("a=1;b=2");
            expect(render(true)).toContain("a=1;b=2");
            feature.renderBashResult(
                { content: [] },
                { expanded: false, isPartial: false },
                theme,
                context,
                () => "terminal",
            );
            await vi.waitUntil(() => render(false).includes("a = 1"));

            for (const width of [100, 40, 120]) {
                const expanded = render(true, width);
                expect(expanded).toContain("a = 1\n  b = 2");
                expect(expanded).toContain("python3 - <<'PY'");
                expect(expanded).toContain("printf DONE");
            }

            expect(context.args).toEqual({ command });
        } finally {
            feature.clear();
        }
    },
);

it("formats a Node stdin heredoc without hiding either surrounding shell command", async () => {
    const { subject, formatter } = setup();
    const source =
        "printf BEFORE\nnode --input-type=module <<'JS'\nconst value={n:1};console.log(value);\nJS\nprintf AFTER";
    const input = {
        key: "node-heredoc",
        source,
        language: "bash",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    subject.get(input);
    await subject.settled();
    expect(subject.get(input)).toBe(
        "printf BEFORE\nnode --input-type=module <<'JS'\nconst value = { n: 1 };\nconsole.log(value);\nJS\nprintf AFTER",
    );
});

it("uses the shell's tab-stripped source for <<- without changing its original delimiter row", async () => {
    const { subject, formatter } = setup();
    const source = "python3 - <<-'PY'\n\ta=1;b=2\n\tPY\nprintf DONE";
    const input = {
        key: "tab-heredoc",
        source,
        language: "bash",
        mode: "statement" as const,
        complete: true,
        formatter,
    };
    subject.get(input);
    await subject.settled();
    expect(subject.get(input)).toBe("python3 - <<-'PY'\na = 1\nb = 2\n\tPY\nprintf DONE");
});

it("cancels session-owned embedded formatting even when a backend ignores its abort signal", async () => {
    const { subject } = setup();
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    let release = (_value: string) => {};
    const formatter: ScriptBlockFormatter = async () => {
        entered();

        return new Promise<string>((resolve) => {
            release = resolve;
        });
    };

    const code = "python3 - <<'PY'\na=1;b=2\nPY\nprintf DONE";
    const pending = subject.formatEmbedded({ label: "Bash", language: "bash", code }, formatter);
    await started;
    subject.clear();
    await expect(pending).resolves.toBe(code);
    release("a = 1\nb = 2\n");
    await subject.settled();
});
