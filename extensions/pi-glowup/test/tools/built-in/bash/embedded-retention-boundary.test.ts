import type { Component } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { renderScriptCall } from "../../../../src/tools/built-in/bash/script-renderer.ts";
import { extractEmbeddedPrograms } from "../../../../src/tools/built-in/bash/embedded-programs.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../../../src/rendering/syntax/highlighter.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../../support/theme-colors.ts";

import { configureRenderDiagnostics } from "../../../../src/diagnostics/render-events.ts";
import type { DebugLogFields } from "../../../../src/diagnostics/logger.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
afterEach(async () => disposeSyntaxHighlighting());

it.each([
    ["reopened unquoted terminator", `cd /work && python3 - <<PY\nprint(42)\nPY`, "$HOME"],
    ["carriage-return word continuation", `cd /work && python3 -c 'print(42)'`, "\r$HOME"],
    ["word concatenation", `cd /work && python3 -c 'print(42)'`, "$HOME"],
    ["unfinished expanding heredoc", `cd /work && python3 - <<PY\nprint(42)`, "\n$HOME\nPY"],
    ["partial heredoc delimiter", `cd /work && python3 - <<'PY'\nprint(42)\nP`, "Y\n"],
])("does not reuse unsafe embedded spans across %s", async (_label, source, suffix) => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
    const programs = extractEmbeddedPrograms(source);
    expect(programs.length).toBeGreaterThan(0);
    const lookup = (value: string) => {
        if (value === source) return programs;
        return undefined;
    };

    let previous = renderScriptCall(
        theme,
        { label: "Bash", language: "bash", code: source },
        {
            state: "running",
            expanded: true,
            invalidate: () => {},
            embeddedPrograms: lookup,
        },
    );
    previous.render(120);
    await settleSyntaxHighlights();
    previous.invalidate();
    const before = previous.render(120).join("\n");
    expect(before).toContain("\u001b[38;2;220;220;170mprint");
    const code = source + suffix;
    previous = renderScriptCall(
        theme,
        { label: "Bash", language: "bash", code },
        {
            state: "running",
            expanded: true,
            invalidate: () => {},
            embeddedPrograms: lookup,
            lastComponent: previous,
        },
    );
    const pending = previous.render(120);
    expect(pending.join("\n")).not.toContain("\u001b[38;2;220;220;170mprint");
    const cold = renderScriptCall(
        theme,
        { label: "Bash", language: "bash", code },
        {
            state: "running",
            expanded: true,
            invalidate: () => {},
            embeddedPrograms: () => [],
        },
    ).render(120);
    expect(pending.map(stripVTControlCharacters)).toEqual(cold.map(stripVTControlCharacters));
    await settleSyntaxHighlights();
});

it.each(["removed", "expandable"])(
    "retires syntax work for %s embedded slots after a source revision",
    async (kind) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
        const events: DebugLogFields[] = [];
        configureRenderDiagnostics((event, fields) => {
            if (event === "syntax_request") events.push(fields());
        });

        onTestFinished(() => configureRenderDiagnostics(undefined));
        let invalidations = 0;
        const invalidate = () => {
            invalidations++;
        };

        const source = `cd /work && python3 - <<PY\nprint("REMOVED_OWNER")\nPY\n`;
        const programs = extractEmbeddedPrograms(source);
        const previous = renderScriptCall(
            theme,
            { label: "Bash", language: "bash", code: source },
            {
                state: "running",
                expanded: true,
                invalidate,
                embeddedPrograms: () => programs,
            },
        );
        previous.render(120);
        const removed = events.find((event) => event.state === "requested");
        expect(removed).toBeDefined();
        let replacement = "echo replacement";
        if (kind === "expandable") replacement = `cd /work && python3 - <<PY\n$HOME\nPY\n`;

        const replacementPrograms = extractEmbeddedPrograms(replacement);
        const current = renderScriptCall(
            theme,
            { label: "Bash", language: "bash", code: replacement },
            {
                state: "running",
                expanded: true,
                invalidate,
                embeddedPrograms: () => replacementPrograms,
                lastComponent: previous,
            },
        );
        current.render(120);
        await settleSyntaxHighlights();
        expect(
            events
                .filter(
                    (event) => event.requestId === removed?.requestId && event.terminal === true,
                )
                .map((event) => event.state),
        ).toEqual(["superseded"]);

        expect(invalidations).toBe(0);
        expect(current.render(120).join("\n")).not.toContain("REMOVED_OWNER");
    },
);

it("keeps reordered, duplicated, nested and removed embedded slots equivalent to cold rendering", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript", "python"] });
    const alpha = `node -e 'const marker = "ALPHA";'`;
    const beta = `node -e '/*\nconst marker = "BETA";\n*/\nconst marker = "BETA";'`;
    const nested = `bash -lc 'python3 -c "print(42)"'`;
    let previous: Component | undefined;

    for (const command of [
        `${alpha}; ${beta}`,
        `${alpha}; ${beta}; ${alpha}`,
        `${beta}; ${alpha}`,
        nested,
        `${nested}; ${nested}`,
        "echo no embedded code",
        alpha,
    ]) {
        const programs = extractEmbeddedPrograms(command);
        const options = {
            state: "running",
            expanded: true,
            invalidate: () => {},
            embeddedPrograms: () => programs,
        } as const;
        const invocation = { label: "Bash", language: "bash", code: command };
        previous = renderScriptCall(theme, invocation, { ...options, lastComponent: previous });
        const pending = previous.render(120);
        await settleSyntaxHighlights();
        previous.invalidate();
        const settled = previous.render(120);
        const cold = renderScriptCall(theme, invocation, options);
        cold.render(120);
        await settleSyntaxHighlights();
        cold.invalidate();
        expect(settled).toEqual(cold.render(120));
        expect(pending.map(stripVTControlCharacters)).toEqual(
            settled.map(stripVTControlCharacters),
        );
    }
});
