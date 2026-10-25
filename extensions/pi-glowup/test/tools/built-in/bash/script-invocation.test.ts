import { describe, expect, it } from "vitest";
import { parseScriptInvocation } from "../../../../src/tools/built-in/bash/invocation.ts";

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
