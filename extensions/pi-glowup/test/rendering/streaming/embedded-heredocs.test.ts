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
import { extractEmbeddedPrograms } from "../../../src/tools/built-in/bash/embedded-programs.ts";
import { shellWords } from "../../../src/tools/built-in/bash/shell-words.ts";

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

it("preserves Unicode, CRLF, and tab-stripped heredoc boundaries while formatting", async () => {
    const { subject, formatter } = setup();
    const source = `printf '😀'\r\npython - <<-'PY'\r\n\ta=1;b=2\r\n\tPY\r\nprintf done`;
    const display = await subject.formatEmbedded(
        { label: "Bash", language: "bash", code: source },
        formatter,
    );
    expect(display).toBe(`printf '😀'\r\npython - <<-'PY'\r\na = 1\nb = 2\r\n\tPY\r\nprintf done`);
    const program = extractEmbeddedPrograms(display)[0];
    expect(program?.code).toBe("a = 1\nb = 2\r\n");
});

it("formats inline source while retaining unrelated heredoc input and shell operations", async () => {
    const { subject, formatter } = setup();
    const source = `python -c 'a=1;b=2' <<'DATA'\ninput\nDATA\nprintf end`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(`python -c 'a = 1\nb = 2' <<'DATA'\ninput\nDATA\nprintf end`);
});

it("does not format split-string or sed programs without a supported encoder or backend", async () => {
    const { subject, formatter, inputs } = setup();
    const source = `env -S 'python -c "a=1"'; sed -e 's/a/b/' input`;
    expect(extractEmbeddedPrograms(source).map(({ language }) => language)).toEqual([
        "python",
        "sed",
    ]);

    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);

    expect(inputs).toEqual([]);
});

it("does not send sed programs to an unprofiled formatter", async () => {
    const { subject } = setup();
    let calls = 0;
    const formatter: ScriptBlockFormatter = async () => {
        calls++;
        return "changed";
    };

    const source = `sed -e 's/a/b/' input`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);
    expect(calls).toBe(0);
});

it("formats combined interpreter flags inside an SSH command after Unicode text", async () => {
    const { subject, formatter } = setup();
    const source = `printf '😀'; ssh host 'python -Ic "a=1;b=2"'`;
    const display = await subject.formatEmbedded(
        { label: "Bash", language: "bash", code: source },
        formatter,
    );
    const extracted = extractEmbeddedPrograms(display);
    expect(extracted.map(({ language, code }) => ({ language, code }))).toEqual([
        { language: "bash", code: `python -Ic 'a = 1\nb = 2'` },
        { language: "python", code: "a = 1\nb = 2" },
    ]);

    for (const program of extracted) expect(display.slice(program.start, program.end)).not.toBe("");
});

it.each([String.raw`python -c $'a=1;#\xFF'`, String.raw`python -c $'a=1;#\377'`])(
    "preserves non-UTF-8 ANSI-C byte escapes without formatting: %s",
    async (source) => {
        const { subject, formatter, inputs } = setup();
        expect(
            await subject.formatEmbedded(
                { label: "Bash", language: "bash", code: source },
                formatter,
            ),
        ).toBe(source);

        expect(inputs).toEqual([]);
    },
);

it("formats an inline program without formatting its stdin data", async () => {
    const { subject, formatter } = setup();
    const source = `node -e 'console.log(1)' <<'DATA'\nnot source\nDATA`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(`node -e 'console.log(1);' <<'DATA'\nnot source\nDATA`);
});

it("re-escapes literal dollar signs when formatting an unquoted heredoc", async () => {
    const { subject, formatter } = setup();
    const source = "python - <<END\na='\\$HOME';b=2\nEND";
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe("python - <<END\na = '\\$HOME'\nb = 2\nEND");
});

it("formats literal double-quoted source without expanding its new shell characters", async () => {
    const { subject, formatter } = setup();
    const source = `python -c "a=1;b=2"`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(`python -c 'a = 1\nb = 2'`);
});

it.each(["bash -c", "ssh host"])(
    "re-encodes nested shell words after formatting embedded source: %s",
    async (launcher) => {
        const { subject, formatter } = setup();
        const source = `${launcher} ` + String.raw`'python -c '\''a=1;b=2'\'''`;
        const display = await subject.formatEmbedded(
            { label: "Bash", language: "bash", code: source },
            formatter,
        );
        const programs = extractEmbeddedPrograms(display);
        expect(programs.map(({ language, code }) => ({ language, code }))).toEqual([
            { language: "bash", code: `python -c 'a = 1\nb = 2'` },
            { language: "python", code: "a = 1\nb = 2" },
        ]);
    },
);

it("formats nested programs in a Bash heredoc without requiring a Bash formatter", async () => {
    const { subject, formatter } = setup(false);
    const source = `bash <<'SH'\npython -c 'a=1;b=2'\nSH`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(`bash <<'SH'\npython -c 'a = 1\nb = 2'\nSH`);
});

it("rejects a formatter result that cannot be represented in a shell argument", async () => {
    const subject = createCodeStreamStore();
    stores.push(subject);
    const source = `python -c 'x=1'`;
    const formatter: ScriptBlockFormatter = async () => "a\0b";
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);
});

it("allows an escaped formatter result that is not the raw heredoc terminator", async () => {
    const subject = createCodeStreamStore();
    stores.push(subject);
    const source = "bash <<$END\ntrue\n$END";

    const formatter: ScriptBlockFormatter = async ({ language }) => {
        if (language === "bash") return "$END";
        return undefined;
    };
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe("bash <<$END\n\\$END\n$END");
});

it("rejects nested formatting that creates the enclosing heredoc terminator", async () => {
    const subject = createCodeStreamStore();
    stores.push(subject);
    const source = `bash <<'END'\npython -c 'x=1'\nEND`;
    const formatter: ScriptBlockFormatter = async ({ language }) => {
        if (language === "python") return "first\nEND\nlast";
        return undefined;
    };
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);
});

it("does not format nested programs in an unfinished Bash heredoc", async () => {
    const { subject, formatter, inputs } = setup();
    const source = `bash <<'SH'\npython -c 'a=1;b=2'`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);

    expect(inputs).toEqual([]);
});

it("does not format an unfinished heredoc body", async () => {
    const { subject, formatter, inputs } = setup();
    const source = `python - <<'PY'\na=1;b=2`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);

    expect(inputs).toEqual([]);
});

it("preserves dynamic source without sending it to an embedded formatter", async () => {
    const { subject, formatter, inputs } = setup();
    const source = `python -c "$program"`;
    expect(
        await subject.formatEmbedded({ label: "Bash", language: "bash", code: source }, formatter),
    ).toBe(source);

    expect(inputs).toEqual([]);
});

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
    "python3 -m json.tool <<'PY'\na=1;b=2\nPY",
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
    const source = `${command} <<'END'\nexample\nEND`;
    expect(extractEmbeddedPrograms(source).map((program) => program.language)).toEqual([language]);
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

// Inline awk/jq programs are formatted in place like source heredocs: only the literal program
// word changes, continuation rows hang from the row's indentation, and the shell stays valid.
function filterSetup() {
    const subject = createCodeStreamStore();
    stores.push(subject);
    const inputs: ScriptBlockFormatterInput[] = [];
    const profiles = parseScriptFormatterCommandsValue({
        awk: { kind: "awk" },
        jq: { kind: "jq" },
    });
    const formatter: ScriptBlockFormatter = Object.assign(
        async (input: ScriptBlockFormatterInput) => {
            inputs.push(input);

            if (input.language === "jq") return input.code.split(" | ").join(" |\n  ");

            if (input.language === "awk")
                return input.code
                    .replace(/\{ /gu, "{\n  ")
                    .replace(/; /gu, "\n  ")
                    .replace(/ \}/gu, "\n}");

            return undefined;
        },
        { profileFor: (language: string) => profiles.get(language) },
    );

    return { subject, formatter, inputs };
}

function programWords(command: string): string[] {
    return shellWords(command)
        .filter((word) => word.text.startsWith("'"))
        .map((word) => word.text.slice(1, -1));
}

it("formats awk and jq programs in place without touching option values", async () => {
    const { subject, formatter, inputs } = filterSetup();
    const code = [
        "if [ -f data.json ]; then",
        "  jq -r --arg tag 'a | b' '.items[] | select(.tags | index($tag)) | .name' data.json",
        "fi",
        "awk -F ':' '{ total += $3; count++ } END { print total / count }' /etc/passwd | tee out.txt",
    ].join("\n");

    const display = await subject.formatEmbedded(
        { label: "Bash", language: "bash", code, targetWidth: 40 },
        formatter,
    );

    expect(display).toBe(
        [
            "if [ -f data.json ]; then",
            "  jq -r --arg tag 'a | b' '.items[] |",
            "    select(.tags |",
            "    index($tag)) |",
            "    .name' data.json",
            "fi",
            "awk -F ':' '{",
            "  total += $3",
            "  count++",
            "} END {",
            "  print total / count",
            "}' /etc/passwd | tee out.txt",
        ].join("\n"),
    );

    // The display is still one valid command with the same option values.
    expect(programWords(display).slice(0, 1)).toEqual(["a | b"]);
    expect(programWords(display)).toContain(":");
    expect(
        inputs.map(({ language, code, targetWidth, firstLineOffset }) => ({
            language,
            code,
            targetWidth,
            firstLineOffset,
        })),
    ).toEqual([
        {
            language: "jq",
            code: ".items[] | select(.tags | index($tag)) | .name",
            targetWidth: 38,
            firstLineOffset: 25,
        },
        {
            language: "awk",
            code: "{ total += $3; count++ } END { print total / count }",
            targetWidth: 40,
            firstLineOffset: 12,
        },
    ]);
});

it.each([
    "awk -f summarize.awk -v limit=10 access.log | sort | head -n 20 | tee summary.txt",
    'jq -r ".items[] | select(.name == \\"$NAME\\") | .id" data.json | xargs -n1 echo',
    "jq -rf filter.jq data.json | awk 'NF' | sort -u | tee filtered-output.txt",
    "printf '%s\\n' '{ print $1 } | jq .a | awk' | wc -l",
])("never sends file programs, data, or expanding programs: %s", async (code) => {
    const { subject, formatter, inputs } = filterSetup();
    const display = await subject.formatEmbedded(
        { label: "Bash", language: "bash", code, targetWidth: 20 },
        formatter,
    );

    expect(display).toBe(code);
    expect(inputs.filter((input) => input.code !== "NF")).toEqual([]);
});

it("keeps programs that fit and re-lays out others when the width changes", async () => {
    const { subject, formatter, inputs } = filterSetup();
    const code = "curl -s https://example.test/items | jq '.items[] | .name | ascii_downcase'";

    const wide = await subject.formatEmbedded(
        { label: "Bash", language: "bash", code, targetWidth: 120 },
        formatter,
    );
    expect(wide).toBe(code);
    expect(inputs).toEqual([]);

    const narrow = await subject.formatEmbedded(
        { label: "Bash", language: "bash", code, targetWidth: 60 },
        formatter,
    );
    expect(narrow).toBe(
        "curl -s https://example.test/items | jq '.items[] |\n  .name |\n  ascii_downcase'",
    );

    expect(inputs.map((input) => input.targetWidth)).toEqual([60]);
});

it("shows formatted awk programs collapsed and expanded, like source heredocs", async () => {
    const { subject, formatter } = filterSetup();
    const feature = createNativeBashFeature(
        () => formatter,
        async (input, backend, options) => subject.formatEmbedded(input, backend, options),
    );
    const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
    const command = `awk -F, '{ sum += $2; rows++ } END { print sum / rows }' ${"measurements/".repeat(4)}data.csv`;
    const context: BuiltInRenderContext = {
        args: { command },
        toolCallId: "awk-embedded",
        cwd: "/work",
        state: {},
        lastComponent: undefined,
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
    const render = (expanded: boolean, width = 50) =>
        stripVTControlCharacters(
            feature
                .renderBashCall(
                    { command },
                    theme,
                    { ...context, expanded },
                    () => 30,
                    () => false,
                    () => "auto",
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
            completed: true,
            signal: undefined,
            isCurrent: () => true,
            invalidate: context.invalidate,
        });

        render(false);
        await vi.waitUntil(() => render(false).includes("  sum += $2"));

        for (const expanded of [false, true]) {
            const rows = render(expanded);
            expect(rows).toContain("$ awk -F, '{\n    sum += $2\n    rows++\n  }");
            expect(rows).toContain("data.csv");
        }

        expect(context.args).toEqual({ command });
    } finally {
        feature.clear();
    }
});
