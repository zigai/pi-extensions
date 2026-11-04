import { expect, it } from "vitest";
import { heredocBodyRows } from "../../../../src/tools/built-in/bash/shell-words.ts";

it("finds exact literal rows across a large batch of independent heredocs", () => {
    const count = 8000;
    const source = `${"cat <<'EOF'\nplain body\nEOF\n".repeat(count)}echo done`;
    const rows = heredocBodyRows(source);

    // Exercise the large-source path without a machine-dependent timing assertion.
    expect([...rows]).toEqual(Array.from({ length: count }, (_, index) => index * 3 + 1));
});

it("shares a continued header without mixing the positions of its heredoc bodies", () => {
    const source = [
        "cat <<'FIRST' <<-'SECOND'; echo $(printf '%s'",
        "'header continuation')",
        "first body",
        "FIRST",
        "\tsecond body",
        "\tSECOND",
        "echo done",
        "cat <<'LAST'",
        "last body",
        "LAST",
    ].join("\n");

    expect([...heredocBodyRows(source)]).toEqual([2, 4, 8]);
});

it("tracks command cursors separately for nested scripts and their outer heredocs", () => {
    const source = [
        "cat <<'FIRST'; echo $(cat <<'SECOND'",
        "nested body",
        "SECOND",
        ")",
        "outer body",
        "FIRST",
        "cat <<'THIRD'",
        "last body",
        "THIRD",
        "echo done",
    ].join("\n");

    expect([...heredocBodyRows(source)].sort((left, right) => left - right)).toEqual([1, 4, 7]);
});

it("leaves scripts without heredocs and unquoted heredoc bodies nonliteral", () => {
    expect([...heredocBodyRows("echo done\nprintf ready")]).toEqual([]);
    expect([...heredocBodyRows("cat <<EOF\n$VALUE\nEOF\necho done")]).toEqual([]);
});
