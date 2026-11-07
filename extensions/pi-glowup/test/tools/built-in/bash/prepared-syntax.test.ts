import { afterEach, expect, it } from "vitest";
import { analyzeBashCommand } from "../../../../src/tools/built-in/bash/command.ts";
import { extractEmbeddedPrograms } from "../../../../src/tools/built-in/bash/embedded-programs.ts";
import {
    carryRawScriptSyntax,
    getPreparedScriptSyntax,
    inheritPreparedScriptSyntax,
    prepareScriptCallSyntax,
} from "../../../../src/tools/built-in/bash/prepared-syntax.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
} from "../../../../src/rendering/syntax/highlighter.ts";

afterEach(async () => disposeSyntaxHighlighting());

it("carries raw capabilities across replacement widths without retaining older formatted variants", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const raw = { label: "Node", language: "javascript", code: "const value=1;" };
    await prepareScriptCallSyntax(raw, undefined);
    let current = raw;

    for (const code of ["const value = 1;", "const value =\n  1;", "const value =\n    1;\n"]) {
        const next = { ...raw, code };
        await prepareScriptCallSyntax(next, undefined);
        carryRawScriptSyntax(next, current, raw.code);
        const expanded = { ...raw };
        inheritPreparedScriptSyntax(expanded, next);
        expect(getPreparedScriptSyntax(expanded)?.standalone).toBeDefined();

        if (current !== raw) {
            const previousWidth = { ...current };
            inheritPreparedScriptSyntax(previousWidth, next);
            expect(getPreparedScriptSyntax(previousWidth)).toBeUndefined();
        }

        current = next;
    }
});

it("preserves the raw Bash origin's trimmed and operator-reflowed capabilities", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const raw = {
        label: "Bash",
        language: "bash",
        code: "\n pwd && node <<'JS'\nconst value=1;\nJS\n",
    };
    const formatted = { ...raw, code: raw.code.replace("value=1", "value = 1") };
    const resolve = async (source: string) => extractEmbeddedPrograms(source);
    await prepareScriptCallSyntax(raw, undefined, resolve);
    await prepareScriptCallSyntax(formatted, undefined, resolve);
    carryRawScriptSyntax(formatted, raw, raw.code);
    const trimmed = raw.code.replace(/^[ \t\n]+/u, "");
    const reflowed = analyzeBashCommand(
        trimmed,
        "leading",
        extractEmbeddedPrograms(trimmed),
    ).reflowedCommand;
    expect(reflowed).toBeDefined();

    for (const code of [raw.code, trimmed, reflowed ?? trimmed]) {
        const expanded = { ...raw, code };
        inheritPreparedScriptSyntax(expanded, formatted);
        const prepared = getPreparedScriptSyntax(expanded);
        expect(prepared?.programs).toHaveLength(1);
        expect(prepared?.children.size).toBe(1);
    }
});
