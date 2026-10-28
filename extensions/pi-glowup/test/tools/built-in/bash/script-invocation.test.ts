import { fc } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { parseScriptInvocation } from "../../../../src/tools/built-in/bash/invocation.ts";
import { extractEmbeddedPrograms } from "../../../../src/tools/built-in/bash/embedded-programs.ts";
import { createEmbeddedProgramService } from "../../../../src/tools/built-in/bash/embedded-service.ts";

describe("embedded program extraction", () => {
    it("publishes worker extraction without blocking the caller and retires it on reset", async () => {
        const service = createEmbeddedProgramService();
        const command = `python -c 'print(1)'`;
        let invalidations = 0;
        try {
            expect(
                service.get(command, () => {
                    invalidations++;
                }),
            ).toBeUndefined();
            await service.settled();
            expect(invalidations).toBe(1);
            expect(service.get(command)?.map((program) => program.code)).toEqual(["print(1)"]);
            service.clear();
            expect(service.get(command)).toBeUndefined();
            await service.settled();
            expect(service.get(command)?.map((program) => program.code)).toEqual(["print(1)"]);
        } finally {
            await service.dispose();
        }
    });
    const programs = (source: string) =>
        extractEmbeddedPrograms(source).map(({ language, origin, start, end, code }) => ({
            language,
            origin,
            source: source.slice(start, end),
            code,
        }));

    it("finds independent programs beside literal operators and multiple heredocs", () => {
        const source = `printf '%s' '<<'; python -c 'print(1)'; jq '.x' <<'DATA'; awk '{print $1}' <<'MORE'\n{}\nDATA\ninput\nMORE`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: "'print(1)'", code: "print(1)" },
            { language: "jq", origin: "inline", source: "'.x'", code: ".x" },
            { language: "awk", origin: "inline", source: "'{print $1}'", code: "{print $1}" },
        ]);
    });

    it.each([String.raw`python -c $'x=1;#\xFF'`, String.raw`python -c $'x=1;#\377'`])(
        "does not reinterpret non-UTF-8 ANSI-C bytes as Unicode: %s",
        (source) => {
            expect(programs(source)).toEqual([]);
        },
    );

    it("extracts completed programs before an incomplete trailing command", () => {
        const source = "python -c 'print(1)';\necho '";
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: "'print(1)'", code: "print(1)" },
        ]);
    });

    it("extracts only literal inline source before the first script operand", () => {
        const source = `python -c "print(1)"; node app.js -e 'no'; sh -c "$cmd"; python -c 'print('"'"'ok'"'"')'`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: '"print(1)"', code: "print(1)" },
            {
                language: "python",
                origin: "inline",
                source: `'print('"'"'ok'"'"')'`,
                code: "print('ok')",
            },
        ]);
    });

    it.each([
        ["python -Ic 'print(1)'", "python", "'print(1)'", "print(1)"],
        ["python -Ic'print(1)'", "python", "'print(1)'", "print(1)"],
        ["node -e'console.log(1)'", "javascript", "'console.log(1)'", "console.log(1)"],
        ["bun --eval='console.log(1)'", "typescript", "'console.log(1)'", "console.log(1)"],
        ["tsx --eval='console.log(1)'", "typescript", "'console.log(1)'", "console.log(1)"],
        ["ruby -ne 'puts $_'", "ruby", "'puts $_'", "puts $_"],
        ["perl -pe 's/a/b/'", "perl", "'s/a/b/'", "s/a/b/"],
        ["sed -e 's/a/b/' input", "sed", "'s/a/b/'", "s/a/b/"],
        ["sed 's/a/b/' input", "sed", "'s/a/b/'", "s/a/b/"],
    ])("extracts static attached and combined options: %s", (source, language, span, code) => {
        expect(programs(source)).toEqual([{ language, origin: "inline", source: span, code }]);
    });

    it.each([
        "env -S \"$ARGS\" python -c 'wrong'",
        "env --unknown python -c 'wrong'",
        "sudo --unknown python -c 'wrong'",
        "sed -f program.sed 'not source'",
        "sed --file=program.sed 'not source'",
        "python -Ic <<'DATA'\nnot source\nDATA",
    ])("does not guess dynamic or unsupported wrapper/filter arguments: %s", (source) => {
        expect(programs(source)).toEqual([]);
    });

    it.each([
        `env -S 'python -c "a=1;b=2"'`,
        `env -u MODE -S 'python -c "a=1;b=2"'`,
        `printf '😀'; env -S 'python -c "a=1;b=2"'`,
    ])("extracts quoted shell punctuation in a literal env split string: %s", (source) => {
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: '"a=1;b=2"', code: "a=1;b=2" },
        ]);
    });

    it.each([
        "env -S 'python -c \"${CODE}\"'",
        `env -S 'python -c "print(1)" > file'`,
        `env -S 'python -c "print(1)" &'`,
        "env -S 'python -c \"print(1)\"\fnode -e x'",
    ])("does not guess split strings with different env semantics: %s", (source) => {
        expect(programs(source)).toEqual([]);
    });

    it("extracts a literal env split-string command with original positions", () => {
        const source = `env -S 'python -c "print(1)"'`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: '"print(1)"', code: "print(1)" },
        ]);
    });

    it("walks compound commands and supported option-bearing launchers", () => {
        const source = `for x in a; do timeout 2s sudo -u user python -c 'print(2)'; done; nohup npx --yes tsx -e 'x()'`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: "'print(2)'", code: "print(2)" },
            { language: "typescript", origin: "inline", source: "'x()'", code: "x()" },
        ]);
    });

    it.each(["tsx -", "bun -", "bun run -", "deno run -", "deno run --ext=ts -"])(
        "recognizes explicit TypeScript source from stdin: %s",
        (launcher) => {
            const source = `${launcher} <<'TS'\nconst value: number = 1;\nTS`;
            expect(programs(source)).toEqual([
                {
                    language: "typescript",
                    origin: "heredoc",
                    source: "const value: number = 1;\n",
                    code: "const value: number = 1;\n",
                },
            ]);
        },
    );

    it.each(["tsx file.ts", "bun run file.ts", "deno run file.ts", "deno eval '1'"])(
        "does not treat a TypeScript program's stdin data as source: %s",
        (launcher) => {
            expect(
                programs(`${launcher} <<'DATA'\ninput\nDATA`).filter(
                    ({ origin }) => origin === "heredoc",
                ),
            ).toEqual([]);
        },
    );

    it("finds embedded programs inside a Bash heredoc", () => {
        const source = `bash <<'SH'\npython -c 'print(4)'\nSH`;
        const extracted = extractEmbeddedPrograms(source);
        expect(
            extracted.map(({ language, origin, start, end, code }) => ({
                language,
                origin,
                source: source.slice(start, end),
                code,
            })),
        ).toEqual([
            {
                language: "bash",
                origin: "heredoc",
                source: "python -c 'print(4)'\n",
                code: "python -c 'print(4)'\n",
            },
            { language: "python", origin: "inline", source: "'print(4)'", code: "print(4)" },
        ]);

        expect(extracted[1]?.parent).toBe(extracted[0]);
    });

    it.each([String.raw`python -c $'a\0b'`, String.raw`python -c $'a\x00b'`])(
        "does not infer a shell argument containing NUL: %s",
        (source) => {
            expect(programs(source)).toEqual([]);
        },
    );

    it("keeps file source ownership when a separate stderr redirect follows", () => {
        const source = `cat > output.py 2>&1 <<'END'\nprint(4)\nEND`;
        expect(programs(source)).toEqual([
            {
                language: "python",
                origin: "file-heredoc",
                source: "print(4)\n",
                code: "print(4)\n",
            },
        ]);
    });

    it("maps nested heredoc programs past stripped leading tabs", () => {
        const source = `bash <<-'SH'\n\tpython -c 'print(4)'\n\tSH`;
        const programs = extractEmbeddedPrograms(source);
        const child = programs.find((program) => program.language === "python");
        if (child === undefined) throw new Error("Expected a nested Python program");

        expect(source.slice(child.start, child.end)).toBe("'print(4)'");
        expect(child.code).toBe("print(4)");
    });

    it("does not infer nested source from an expandable Bash heredoc", () => {
        const source = `bash <<SH\npython -c '$CODE'\nSH`;
        expect(
            extractEmbeddedPrograms(source).map(({ language, expandable }) => ({
                language,
                expandable,
            })),
        ).toEqual([{ language: "bash", expandable: true }]);
    });

    it("finds code in substitutions, nested shell commands and remote shell words", () => {
        const source = `value=$(jq '.item' data); bash -lc 'python -c "print(4)"'; ssh host 'ruby -e "puts 5"'`;
        expect(programs(source)).toEqual([
            { language: "jq", origin: "inline", source: "'.item'", code: ".item" },
            {
                language: "bash",
                origin: "inline",
                source: `'python -c "print(4)"'`,
                code: `python -c "print(4)"`,
            },
            { language: "python", origin: "inline", source: '"print(4)"', code: "print(4)" },
            {
                language: "bash",
                origin: "inline",
                source: `'ruby -e "puts 5"'`,
                code: `ruby -e "puts 5"`,
            },
            { language: "ruby", origin: "inline", source: '"puts 5"', code: "puts 5" },
        ]);
    });

    it.each([
        ["printf python <<'END'\ndata\nEND", []],
        ["cat existing > output.py <<'END'\nnot source\nEND", []],
        ["cat 2> error.py <<'END'\nnot source\nEND", []],
        ["cat > output.py >&2 <<'END'\nnot source\nEND", []],
        ["cat > output.py 1>&2 <<'END'\nnot source\nEND", []],
        ["bash -lc <<'END'\nnot source\nEND", []],
        ["python 3<<'END'\nnot source\nEND", []],
        ["awk -e 'BEGIN {x=1}' -e 'END {print x}'", []],
        ["python script.py -c 'not source'", []],
        ["node script.js -e 'not source'", []],
        ['sh -c "$program"', []],
        ["python -c text*", []],
        ["python -c 'text'*", []],
        ["python -c 'text'${suffix}", []],
        ['python -c "print($value)"', []],
        ["jq -f filter.jq '.not-code'", []],
        ["awk -f filter.awk '{not code}'", []],
        [
            "python -c 'a' <<'DATA'\ninput\nDATA",
            [{ language: "python", origin: "inline", source: "'a'", code: "a" }],
        ],
    ])(
        "does not treat dynamic words, options after filenames or input data as source: %s",
        (source, expected) => {
            expect(programs(source)).toEqual(expected);
        },
    );

    it.each([
        ["timeout -k 2 5 python -c 'p()'", "python", "'p()'", "p()"],
        ["nohup python -c 'p()'", "python", "'p()'", "p()"],
        ["sudo -u user python -c 'p()'", "python", "'p()'", "p()"],
        ["sudo -n python -c 'p()'", "python", "'p()'", "p()"],
        ["xvfb-run -a node -e 'f()'", "javascript", "'f()'", "f()"],
        ["xvfb-run -s screen node -e 'f()'", "javascript", "'f()'", "f()"],
        ["bunx --yes tsx -e 'f()'", "typescript", "'f()'", "f()"],
        ["uv run --with extra python -c 'p()'", "python", "'p()'", "p()"],
        ["npx --yes tsx -e 'f()'", "typescript", "'f()'", "f()"],
    ])("recognizes wrapper options: %s", (source, language, word, code) => {
        expect(programs(source)).toEqual([{ language, origin: "inline", source: word, code }]);
    });

    it("recognizes remote shell code after SSH options and destination", () => {
        const source = `ssh -o BatchMode=yes -p 22 host 'printf ok'`;
        expect(programs(source)).toEqual([
            { language: "bash", origin: "inline", source: "'printf ok'", code: "printf ok" },
        ]);
    });

    it("uses the complete SSH remote command assembled from multiple arguments", () => {
        const source = `ssh host printf '%s' item`;
        expect(programs(source)).toEqual([
            {
                language: "bash",
                origin: "inline",
                source: `printf '%s' item`,
                code: "printf %s item",
            },
        ]);
    });

    it("uses exact heredoc delimiters and strips tabs only for tab-stripping heredocs", () => {
        const source = `python - <<'END'\n END\nprint(1)\nEND\npython - <<-'STOP'\n\tprint(2)\n\tSTOP`;
        expect(programs(source)).toEqual([
            {
                language: "python",
                origin: "heredoc",
                source: " END\nprint(1)\n",
                code: " END\nprint(1)\n",
            },
            { language: "python", origin: "heredoc", source: "\tprint(2)\n", code: "print(2)\n" },
        ]);
    });

    it("recognizes a heredoc piped into an interpreter", () => {
        const source = `cat <<'PY' | python -\nprint(1)\nPY`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "heredoc", source: "print(1)\n", code: "print(1)\n" },
        ]);
    });

    it("finds attached inline flags without including the flag in the range", () => {
        const source = `python -c'print(7)'`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "inline", source: "'print(7)'", code: "print(7)" },
        ]);
    });

    it("decodes escaped expansion characters in a literal unquoted heredoc", () => {
        const source = "python - <<END\nprint('\\$HOME')\nEND";
        expect(programs(source)).toEqual([
            {
                language: "python",
                origin: "heredoc",
                source: "print('\\$HOME')\n",
                code: "print('$HOME')\n",
            },
        ]);
    });

    it("uses only the final stdin redirect as interpreter source", () => {
        const source = `python - <<'ONE' <<'TWO'\nnot source\nONE\nprint(2)\nTWO`;
        expect(programs(source)).toEqual([
            { language: "python", origin: "heredoc", source: "print(2)\n", code: "print(2)\n" },
        ]);
    });

    it("decodes escaped double-quoted programs without treating expansions as literal", () => {
        const source = `python -c "print(\\"x\\")"; python -c "print($value)"`;
        expect(programs(source)).toEqual([
            {
                language: "python",
                origin: "inline",
                source: '"print(\\\"x\\\")"',
                code: 'print("x")',
            },
        ]);
    });

    it("finds nested source inside concatenated shell quoting", () => {
        const source = String.raw`bash -c 'python -c '\''print(1)'\'''`;
        expect(programs(source)).toEqual([
            {
                language: "bash",
                origin: "inline",
                source: String.raw`'python -c '\''print(1)'\'''`,
                code: `python -c 'print(1)'`,
            },
            {
                language: "python",
                origin: "inline",
                source: String.raw`\''print(1)'\'`,
                code: "print(1)",
            },
        ]);
    });

    it("preserves decoded literal words and exact source ranges across seeded quoting cases", () => {
        fc.assert(
            fc.property(
                fc.array(fc.constantFrom("a", "'", '"', "\\", "$", "`", " ", "\n", "😀"), {
                    minLength: 1,
                    maxLength: 20,
                }),
                (parts) => {
                    const code = parts.join("");
                    const word = `'${code.replace(/'/gu, "'\\''")}'`;
                    const source = `printf before; python -c ${word}; printf after`;
                    expect(programs(source)).toEqual([
                        { language: "python", origin: "inline", source: word, code },
                    ]);
                },
            ),
            { seed: 0x1a2b_2026, numRuns: 100 },
        );
    });

    it("recognizes interpreter source and file output but not stdin data", () => {
        const source = `python worker.py <<'ONE'\ndata\nONE\ncat >> "$dir/task.sh" <<'TWO'\necho hello\nTWO\npython - <<'THREE'\nprint(3)\nTHREE`;
        expect(programs(source)).toEqual([
            {
                language: "bash",
                origin: "file-heredoc",
                source: "echo hello\n",
                code: "echo hello\n",
            },
            { language: "python", origin: "heredoc", source: "print(3)\n", code: "print(3)\n" },
        ]);
    });
});

// A heredoc belongs to its own shell command, not the first interpreter elsewhere
// on the opening line. Composed commands must keep every shell operation visible.
describe("heredoc script identity", () => {
    it.each([
        "python script.py <<'END'\ndata\nEND",
        "python -c 'print(1)' <<'END'\ndata\nEND",
        "printf python <<'END'\ndata\nEND",
        'python -c "$program"',
        "node app.js -e 'not code'",
    ])("does not present data or dynamic input as standalone source: %s", (source) => {
        expect(parseScriptInvocation(source)).toBeUndefined();
    });

    it.each([";", "&&", "||", "|", "&"])(
        "does not extract a later interpreter's heredoc across %s",
        (operator) => {
            const command = `bun run inspect.ts > /tmp/result.json ${operator} python - <<'PY'\nimport json\nprint(json.load(open('/tmp/result.json')))\nPY`;
            expect(parseScriptInvocation(command)).toBeUndefined();
            expect(parseScriptInvocation(command.slice(0, -3))).toBeUndefined();
        },
    );

    it.each([
        "node -e 'console.log(1)'",
        "python -c 'print(1)'",
        "env MODE=test bun run inspect.ts",
    ])("keeps a composed heredoc after %s in Bash", (prefix) => {
        expect(
            parseScriptInvocation(`${prefix}; python - <<'PY'\nprint('second')\nPY`),
        ).toBeUndefined();
    });

    it("does not extract a heredoc from a subshell", () => {
        expect(parseScriptInvocation("(python - <<'PY'\nprint('nested')\nPY\n)")).toBeUndefined();
    });

    it.each(["python -", "MODE=test uv run python -", "python - > /tmp/result.json"])(
        "retains a standalone Python heredoc for %s",
        (prefix) => {
            expect(parseScriptInvocation(`${prefix} <<'PY'\nprint('hello')\nPY`)).toEqual({
                label: "Python",
                language: "python",
                code: "print('hello')",
                launcher: `${prefix} <<'PY'`,
            });
        },
    );

    it("does not mistake quoted shell punctuation for composition", () => {
        expect(
            parseScriptInvocation("env NOTE='a; b && c' python - <<'PY'\nprint('hello')\nPY"),
        ).toEqual({
            label: "Python",
            language: "python",
            code: "print('hello')",
            launcher: "env NOTE='a; b && c' python - <<'PY'",
        });
    });

    it("retains an explicit interpreter immediately after a heredoc pipe", () => {
        expect(parseScriptInvocation("cat <<'PY' | python\nprint('hello')\nPY")).toEqual({
            label: "Python",
            language: "python",
            code: "print('hello')",
            launcher: "cat <<'PY' | python",
        });
    });
});

// Only the program word may be formatted: option values, file names, and data must never
// be mistaken for it, and only literal (single-quoted) words may be rewritten.
describe("awk and jq program words", () => {
    const programs = (command: string) =>
        extractEmbeddedPrograms(command)
            .filter(({ language }) => language === "awk" || language === "jq")
            .map(({ start, end, language, code }) => {
                const word = command.slice(start, end);
                let quote = "unquoted";
                if (word.startsWith("'")) quote = "single";
                else if (word.startsWith('"')) quote = "double";
                else if (word.startsWith("$'")) quote = "ansi";

                return { language, quote, program: code };
            });

    it.each([
        ["awk -F ':' '{print $1}' /etc/passwd", "awk", "{print $1}"],
        ["awk -F: -v limit=10 '$3 > limit' data", "awk", "$3 > limit"],
        ["awk -v 'label=x y' -- 'NR > 1' data", "awk", "NR > 1"],
        ["gawk -e 'BEGIN { print 1 }' input", "awk", "BEGIN { print 1 }"],
        ["sort data | mawk -W interactive '{ print $2 }' | head", "awk", "{ print $2 }"],
        ["env LC_ALL=C nawk 'END { print NR }' log", "awk", "END { print NR }"],
        ["jq -r --arg name 'x y' '.items[] | .name' f.json", "jq", ".items[] | .name"],
        ["jq --argjson n '3' --slurpfile s 's.json' '.[$n]' f.json", "jq", ".[$n]"],
        ["jq --indent 4 -L lib '.a' f.json", "jq", ".a"],
        ["jq -nc -- '-1 | abs'", "jq", "-1 | abs"],
        ["count=$(jq -r '.items | length' f.json)", "jq", ".items | length"],
        ["curl -s url | /usr/bin/jq -e '.ok' >/dev/null && echo ok", "jq", ".ok"],
        ["cat <<'EOF' | jq '.a'\n{}\nEOF", "jq", ".a"],
    ])("finds the program in %s", (command, language, program) => {
        expect(programs(command)).toEqual([{ language, quote: "single", program }]);
    });

    it.each([
        "awk -f summarize.awk 'not-a-program' data",
        "awk -fsummarize.awk data",
        "gawk --file=summarize.awk data",
        "awk -e 'BEGIN { x = 1 }' -e 'END { print x }'",
        "jq -f filter.jq 'data.json'",
        "jq -rf filter.jq data.json",
        "jq --from-file filter.jq data.json",
        "awk $'{ print $1 }' data",
        "awk NF data",
        "echo jq '.a'",
        "sed 's/awk/jq/' file",
    ])("finds no formattable program in %s", (command) => {
        expect(programs(command).filter((program) => program.quote === "single")).toEqual([]);
    });

    it("highlights a double-quoted program only when it has no expansions", () => {
        expect(programs('jq ".data.items[0].name" f.json')).toEqual([
            { language: "jq", quote: "double", program: ".data.items[0].name" },
        ]);

        expect(programs('jq ".data.$key" f.json')).toEqual([]);
        expect(programs('awk "{ print \\$1 }" f')).toEqual([
            { language: "awk", quote: "double", program: "{ print $1 }" },
        ]);
    });

    it("finds each program in a pipeline", () => {
        expect(programs("jq -c '.[]' a.json | awk -F, '{ n += $2 } END { print n }'")).toEqual([
            { language: "jq", quote: "single", program: ".[]" },
            { language: "awk", quote: "single", program: "{ n += $2 } END { print n }" },
        ]);
    });
});
