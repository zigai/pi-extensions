import { bindExtensionDiagnostics } from "@zigai/pi-extension-internals";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { format } from "oxfmt";
import { afterEach, expect, it } from "vitest";
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../src/rendering/streaming/code-stream.ts";
import { maskStatementLiterals } from "../../../src/rendering/streaming/literal-formatting.ts";

const stores: CodeStreamStore[] = [];
afterEach(async () => {
    await Promise.all(stores.splice(0).map(async (store) => store.dispose()));
});

it.each([
    "function f(){\n return `first\nlast`;\n}",
    "function f(arg=`first\nlast`){\n return arg;\n}",
    "function f(){\n return `first\n${[1,2].map(x=>{return x+1;}).join(',')}\nlast`;\n}",
    "function f(){\n return 'first\\\nlast';\n}",
])("preserves JavaScript literal values through independent formatting: %s", async (source) => {
    const store = createCodeStreamStore();
    stores.push(store);
    const input = {
        key: "javascript-literals",
        source,
        language: "javascript",
        mode: "statement" as const,
        complete: true,
        formatter: async ({ code }: { code: string }) => {
            const result = await format("unit.js", code, { tabWidth: 2 });
            expect(result.errors).toEqual([]);
            return result.code;
        },
    };
    store.get(input);
    await store.settled();
    const display = store.get(input);
    expect(display).not.toContain("__glowup_");
    expect(runInNewContext(display + "\nf()", {})).toEqual(runInNewContext(source + "\nf()", {}));
    const resized = { ...input, targetWidth: 40 };
    store.get(resized);
    await store.settled();
    expect(runInNewContext(store.get(resized) + "\nf()", {})).toEqual(
        runInNewContext(source + "\nf()", {}),
    );
});

function shellOutput(source: string) {
    const result = spawnSync("bash", ["-c", source], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

it.each([
    "if true; then\n printf '%s\\n' 'first\nlast'\nfi",
    'if true; then\n printf "%s\\n" "first\nlast"\nfi',
    "if true; then\n printf '%s\\n' $'first\nlast'\nfi",
    "if true; then\n cat <<EOF\nhello\nEOF\nfi",
    "if true; then\n cat <<EOF\n\n  hello\nEOF\nfi",
    "if true; then\n cat <<-EOF\n\thello\n\tEOF\nfi",
    "if true; then\n cat <<EOF <<END\nfirst\nEOF\nsecond\nEND\nfi",
    "if cat <<EOF\nhello\nEOF\nthen\n printf done\nfi",
    `if true; then\n sh -c 'cat; printf "%s\\n" "$1"' name <<EOF "first\nlast"\npayload\nEOF\nfi`,
])("keeps nested Bash literal payloads and heredoc terminators unchanged: %s", async (source) => {
    const store = createCodeStreamStore();
    stores.push(store);
    const input = {
        key: "bash-literals",
        source,
        language: "bash",
        mode: "statement" as const,
        complete: true,
        // A deterministic two-space shell printer. The real shfmt path is also
        // covered in the recorded local reproduction; shfmt is not a test dependency.
        formatter: async ({ code }: { code: string }) =>
            code.replace(/^(# __glowup_unit_\d+__end|:)$/gmu, "  $1"),
    };
    store.get(input);
    await store.settled();
    const display = store.get(input);
    expect(display).not.toContain("__glowup_");
    expect(shellOutput(display)).toEqual(shellOutput(source));
    expect(shellOutput(display).status).toBe(0);
});

it("holds a false heredoc terminator until completion and never formats the invalid parser fragment", async () => {
    const store = createCodeStreamStore();
    stores.push(store);
    const invalidInputs: string[] = [];
    const inputs: string[] = [];
    const input = {
        key: "heredoc-marker-lookalike",
        source: "cat <<EOF\n  EOF\n",
        language: "bash",
        mode: "statement" as const,
        complete: false,
        formatter: async ({ code }: { code: string }) => {
            inputs.push(code);
            const parsed = spawnSync("bash", ["-n"], { input: code, encoding: "utf8" });
            if (parsed.status !== 0 || parsed.stderr.length > 0) invalidInputs.push(code);
            return code;
        },
    };
    store.get(input);
    await store.settled();
    expect(store.get(input)).toBe("");
    expect(inputs).toEqual([]);
    const final = { ...input, source: input.source + "EOF\n", complete: true };
    store.get(final);
    await store.settled();
    expect(invalidInputs).toEqual([]);
    expect(inputs).toHaveLength(1);
    expect(shellOutput(store.get(final))).toEqual(shellOutput(final.source));
    expect(store.ready(final.key)).toBe(true);
});

it("fails back to original source if a formatter drops a private literal marker", async () => {
    const store = createCodeStreamStore();
    stores.push(store);
    const warnings: string[] = [];
    const binding = bindExtensionDiagnostics({
        hasUI: true,
        ui: {
            notify: (message) => {
                warnings.push(message);
            },
        },
    });
    warnings.length = 0;
    const source = "const value = `first\nlast`;";
    const input = {
        key: "literal-marker-fallback",
        source,
        language: "javascript",
        mode: "statement" as const,
        complete: true,
        formatter: async () => "const value = 'dropped';",
    };
    try {
        store.get(input);
        await store.settled();
        expect(store.get(input)).toBe(source);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("private literal markers");
        expect(warnings[0]).not.toContain("first");
    } finally {
        binding.dispose();
    }
});

it("restores literal payloads without interpreting replacement-string metacharacters", () => {
    const source = "`first\n$& $` $' last`";
    const masked = maskStatementLiterals(
        source,
        0,
        source.length,
        "javascript",
        [{ start: 0, end: source.length, kind: "template" }],
        "__private__",
    );
    expect(masked.restore(masked.code)).toBe(source);
    expect(masked.restore(masked.code + masked.code)).toBeUndefined();
});
