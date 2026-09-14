import { describe, expect, it } from "vitest";

import {
    analyzeBashCommand,
    reflowBashCommand,
} from "../../../../src/tools/built-in/bash/command.ts";

describe("bash command analysis", () => {
    it("extracts only clean standalone language calls", () => {
        expect(analyzeBashCommand(`python -c "print('check')"`).pureScript).toEqual({
            label: "Python",
            language: "python",
            code: "print('check')",
        });

        const composed = analyzeBashCommand(`cd app && python -c "print('check')" && just test`);
        expect(composed.pureScript).toBeUndefined();
        expect(composed.structurallyComplex).toBe(true);
        expect(composed.reflowedCommand).toBe(
            `cd app &&\npython -c "print('check')" &&\njust test`,
        );

        expect(
            analyzeBashCommand(`python -c "import sys; print(sys.argv)" -- --help`).pureScript,
        ).toEqual({
            label: "Python",
            language: "python",
            code: "import sys; print(sys.argv)",
        });

        expect(analyzeBashCommand(`node -e "console.log('ok')" 2>/dev/null`).pureScript).toEqual({
            label: "Node",
            language: "javascript",
            code: "console.log('ok')",
        });

        expect(analyzeBashCommand("one && two").structurallyComplex).toBe(false);
    });

    it("extracts interpreter scripts with attached flags, ANSI-C quoting, and redirections", () => {
        expect(analyzeBashCommand(`python3 -c"import os; print(os.getcwd())"`).pureScript).toEqual({
            label: "Python",
            language: "python",
            code: "import os; print(os.getcwd())",
        });

        expect(
            analyzeBashCommand(`python3 -c $'print("hello")' > output.log 2>&1`).pureScript,
        ).toEqual({
            label: "Python",
            language: "python",
            code: 'print("hello")',
        });

        expect(
            analyzeBashCommand(`cat << 'EOF' | python3\nprint("piped")\nEOF`).pureScript,
        ).toEqual({
            label: "Python",
            language: "python",
            code: 'print("piped")',
        });

        expect(analyzeBashCommand(`pypy3 -c "print(1)"`).pureScript).toEqual({
            label: "Python",
            language: "python",
            code: "print(1)",
        });

        expect(analyzeBashCommand(`ruby -e "puts 1"`).pureScript).toEqual({
            label: "Ruby",
            language: "ruby",
            code: "puts 1",
        });

        expect(analyzeBashCommand(`perl -e "print 1"`).pureScript).toEqual({
            label: "Perl",
            language: "perl",
            code: "print 1",
        });

        expect(analyzeBashCommand(`php -r "echo 1;"`).pureScript).toEqual({
            label: "PHP",
            language: "php",
            code: "echo 1;",
        });

        expect(analyzeBashCommand(`python -c "print(1)" >> log.txt`).pureScript).toEqual({
            label: "Python",
            language: "python",
            code: "print(1)",
        });

        expect(
            analyzeBashCommand(`python << "EOF" > /tmp/out.txt\nprint(1)\nEOF`).pureScript,
        ).toEqual({
            label: "Python",
            language: "python",
            code: "print(1)",
        });

        expect(
            analyzeBashCommand(`uv run --with requests python -c "print(1)"`).pureScript,
        ).toEqual({
            label: "Python",
            language: "python",
            code: "print(1)",
        });

        expect(analyzeBashCommand(`npx tsx -e "console.log(1)"`).pureScript).toEqual({
            label: "TypeScript",
            language: "typescript",
            code: "console.log(1)",
        });

        expect(analyzeBashCommand(`node --no-warnings -e "console.log(1)"`).pureScript).toEqual({
            label: "Node",
            language: "javascript",
            code: "console.log(1)",
        });
    });

    it("reflows at step boundaries while keeping pipelines and fallbacks together", () => {
        expect(reflowBashCommand(`echo "a && b | c" && cat data | python -c "print('x')"`)).toBe(
            `echo "a && b | c" &&\ncat data | python -c "print('x')"`,
        );

        expect(reflowBashCommand(`check cache || rebuild cache && publish`)).toBe(
            `check cache || rebuild cache &&\npublish`,
        );

        expect(reflowBashCommand(`opencode debug --help | head -80`)).toBeUndefined();
        expect(reflowBashCommand(`ls -l /tmp/opencode || true`)).toBeUndefined();
        expect(reflowBashCommand(`echo $(first && second) && final`)).toBe(
            `echo $(first && second) &&\nfinal`,
        );
    });

    it("keeps test-expression operators inside the expression", () => {
        expect(reflowBashCommand(`[[ -f one && -f two ]] && echo yes`)).toBe(
            `[[ -f one && -f two ]] &&\necho yes`,
        );
    });

    it("structures loops while retaining their original shell tokens", () => {
        expect(
            reflowBashCommand(
                `for file in *.json; do python -c "print('x')" "$file" | jq -r .; done`,
            ),
        ).toBe(
            [`for file in *.json; do`, `  python -c "print('x')" "$file" | jq -r .;`, `done`].join(
                "\n",
            ),
        );
    });

    it("structures conditionals, functions, subshells, and case arms", () => {
        expect(reflowBashCommand(`if check; then one && two; else three; fi`)).toBe(
            [`if check; then`, `  one &&`, `  two;`, `else`, `  three;`, `fi`].join("\n"),
        );

        expect(reflowBashCommand(`f() { one && two; }`)).toBe(
            [`f() {`, `  one &&`, `  two;`, `}`].join("\n"),
        );

        expect(reflowBashCommand(`(one && two) || three`)).toBe(
            [`(`, `  one &&`, `  two`, `) || three`].join("\n"),
        );

        expect(reflowBashCommand(`case "$x" in a) one && two;; b) three;& esac`)).toBe(
            [`case "$x" in`, `  a)`, `    one &&`, `    two;;`, `  b)`, `    three;&`, `esac`].join(
                "\n",
            ),
        );
    });

    it("does not mistake quoted compound keywords for shell grammar", () => {
        expect(
            reflowBashCommand(
                `git add src/one.ts && git commit -m "fix: handle imports for scripts"`,
            ),
        ).toBe(`git add src/one.ts &&\ngit commit -m "fix: handle imports for scripts"`);
    });

    it("keeps leading operators selectable", () => {
        expect(reflowBashCommand(`one && two && three`, "leading")).toBe(`one\n&& two\n&& three`);
        expect(reflowBashCommand(`case "$x" in a) one && two;; esac`, "leading")).toContain(
            `    ;;`,
        );
    });

    it("leaves multiline commands and code-writing heredocs unchanged", () => {
        const heredoc = `cat > check.py <<'PY'\nimport json\nprint(json)\nPY`;
        expect(reflowBashCommand(heredoc)).toBeUndefined();
        expect(analyzeBashCommand(heredoc).pureScript).toBeUndefined();
    });

    it("falls back without reflowing malformed syntax", () => {
        expect(reflowBashCommand(`echo "unfinished && just test`)).toBeUndefined();
    });
});
