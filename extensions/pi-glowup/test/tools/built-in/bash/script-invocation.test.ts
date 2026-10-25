import { describe, expect, it } from "vitest";
import { parseScriptInvocation } from "../../../../src/tools/built-in/bash/invocation.ts";
import { embeddedFilterPrograms } from "../../../../src/tools/built-in/bash/filter-programs.ts";

// A heredoc belongs to its own shell command, not the first interpreter elsewhere
// on the opening line. Composed commands must keep every shell operation visible.
describe("heredoc script identity", () => {
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
        embeddedFilterPrograms(command).map(({ start, end, language, quote }) => ({
            language,
            quote,
            program: command.slice(start, end),
        }));

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
        "jq '.a'''b' data.json",
        "awk NF data",
        "cat <<'EOF' | jq '.a'\n{}\nEOF",
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
        expect(programs('awk "{ print \\$1 }" f')).toEqual([]);
    });

    it("finds each program in a pipeline", () => {
        expect(programs("jq -c '.[]' a.json | awk -F, '{ n += $2 } END { print n }'")).toEqual([
            { language: "jq", quote: "single", program: ".[]" },
            { language: "awk", quote: "single", program: "{ n += $2 } END { print n }" },
        ]);
    });
});
