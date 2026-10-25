import { expect, it } from "vitest";
import { parseScriptInvocation } from "../../../../src/tools/built-in/bash/invocation.ts";

it("preserves code tabs until the terminal rendering boundary", () => {
    const code = 'if True:\n\tprint("first\tlast")';
    expect(parseScriptInvocation(`python - <<'PY'\n${code}\nPY`)).toEqual({
        label: "Python",
        language: "python",
        code,
        launcher: "python - <<'PY'",
    });

    expect(parseScriptInvocation("python -c $'print(\"first\\tlast\")'")?.code).toBe(
        'print("first\tlast")',
    );
});

it("applies <<- tab stripping exactly as the shell does without changing interior tabs", () => {
    expect(
        parseScriptInvocation("python - <<-'PY'\n\tif True:\n\t    print('first\tlast')\n\tPY"),
    ).toEqual({
        label: "Python",
        language: "python",
        code: "if True:\n    print('first\tlast')",
        launcher: "python - <<-'PY'",
    });
});
