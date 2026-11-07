import { format } from "oxfmt";
import { createCodeStreamStore } from "../../../../src/rendering/streaming/code-stream.ts";
import type { CodePreview } from "../../../../src/rendering/streaming/presentation.ts";
import type { Component } from "@earendil-works/pi-tui";
import { keyText, keyHint, Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { parseScriptFormatterCommandsValue } from "../../../../src/tools/built-in/bash/formatter.ts";
import type {
    ShellLayout,
    ShellOperatorPosition,
} from "../../../../src/tools/built-in/bash/command.ts";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    onSyntaxHighlightComplete,
    settleSyntaxHighlights,
} from "../../../../src/rendering/syntax/highlighter.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../../support/theme-colors.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

type MutableShellLayout = { layout: ShellLayout; position: ShellOperatorPosition };

afterEach(async () => {
    await disposeSyntaxHighlighting();
});

function harness(
    feature = createNativeBashFeature(),
    options: {
        readonly expanded?: boolean;
        readonly layout?: ShellLayout;
        readonly position?: ShellOperatorPosition;
        readonly stream?: CodePreview;
    } = {},
) {
    onTestFinished(() => feature.clear());
    let previous: Component | undefined;
    const render = (command: string, complete = false) => {
        const context = {
            args: { command },
            toolCallId: "compound-heredoc",
            cwd: "/work",
            lastComponent: previous,
            state: {},
            executionStarted: complete,
            argsComplete: complete,
            isPartial: !complete,
            expanded: options.expanded ?? true,
            showImages: false,
            isError: false,
            durationMs: undefined,
            outputPad: 1,
            keyText,
            keyHint,
            invalidate: () => previous?.invalidate(),
        } satisfies BuiltInRenderContext;
        previous = feature.renderBashCall(
            { command },
            theme,
            context,
            () => 8,
            () => false,
            () => options.layout ?? "preserve",
            () => options.position ?? "trailing",
            options.stream ?? (({ source }) => source),
        );

        return previous.render(120);
    };

    return { render, feature, invalidate: () => previous?.invalidate() };
}

it.each([
    [
        "nested Python",
        `cd /work && bash -lc 'python3 -c "import json; print(42) # ANCHOR"'`,
        "\necho done",
    ],
    [
        "closed unquoted heredoc",
        `cd /work && python3 - <<PY\nimport json,pathlib\nprint("ANCHOR", 42)\nPY`,
        "\necho done",
    ],
    [
        "closed heredoc",
        `cd /work && python3 - <<'PY'\nimport json,pathlib\nprint("ANCHOR", 42)\nPY`,
        "\necho done",
    ],
    [
        "open heredoc",
        `cd /work && python3 - <<'PY'\nimport json,pathlib\nprint("ANCHOR", 42)`,
        "\nprint('next')\nPY",
    ],
    ["inline Python", `cd /work && python3 -c 'import json; print("ANCHOR", 42)'`, " --verbose"],
])(
    "keeps embedded %s colors while appended compound Bash analysis is pending",
    async (_label, source, suffix) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["python"] });
        const { render, feature, invalidate } = harness();

        // Session-history pattern: a shell prelude followed by a Python heredoc.
        try {
            render(source);
            await feature.settled();
            render(source);
            await settleSyntaxHighlights();
            invalidate();
            const colored = render(source);
            const anchor = (lines: string[]) => lines.find((line) => line.includes("ANCHOR"));
            expect(anchor(colored)).toContain("\u001b[38;2;");
            const next = source + suffix;
            const pending = render(next);
            expect(anchor(pending)).toContain(anchor(colored));
            expect(pending.map(stripVTControlCharacters).join("\n")).toContain(
                suffix.trim().split("\n").at(-1),
            );
            await feature.settled();
            render(next);
            await settleSyntaxHighlights();
            invalidate();
            expect(anchor(render(next))).toContain(anchor(colored));
        } finally {
            feature.clear();
        }
    },
);

it.each([false, true])(
    "hands off large streamed script colors when formatter-enabled arguments complete (new arguments: %s)",
    async (append) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const formatter = async ({ code }: { readonly code: string }) => code;
        const { render, feature, invalidate } = harness(createNativeBashFeature(() => formatter));
        const source = Array.from(
            { length: 180 },
            (_value, index) => `const value${index} = formatValue("syntax_${index}", ${index});`,
        ).join("\n");
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const command = `node -e '${source}'`;
        render(command);
        await feature.settled();
        render(command);
        await settleSyntaxHighlights();
        invalidate();
        const before = render(command);
        const row = before.find((line) => line.includes("syntax_0"));
        expect(row).toContain("\u001b[38;2;86;156;214mconst");
        let completions = 0;
        const stop = onSyntaxHighlightComplete(() => {
            completions++;
        });
        onTestFinished(stop);
        let finalCommand = command;

        if (append) finalCommand += " --verbose";

        const completed = render(finalCommand, true);
        expect(completed.find((line) => line.includes("syntax_0"))).toBe(row);
        await feature.settled();
        await settleSyntaxHighlights();
        invalidate();
        expect(render(finalCommand, true).find((line) => line.includes("syntax_0"))).toBe(row);
        expect(completions).toBe(0);
    },
);

it("retains a large unchanged embedded program when a preceding program grows", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const { render, feature, invalidate } = harness();
    const source = Array.from(
        { length: 180 },
        (_value, index) => `const value${index} = formatValue("stable_${index}", ${index});`,
    ).join("\n");
    expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
    const command = `node -e 'const first=1'; node -e '${source}'`;
    render(command);
    await feature.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    const row = render(command).find((line) => line.includes("stable_1"));
    expect(row).toContain("\u001b[38;2;86;156;214mconst");
    const next = command.replace("first=1", "first=12345");
    render(next);
    await feature.settled();
    const pending = render(next);
    expect(pending.find((line) => line.includes("stable_1"))).toBe(row);
    await settleSyntaxHighlights();
});

it("publishes changed formatter output with its syntax already ready", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const formatter = async ({ code }: { readonly code: string }) =>
        (await format("source.js", code)).code;

    const { render, feature, invalidate } = harness(createNativeBashFeature(() => formatter));
    const source = Array.from(
        { length: 220 },
        (_value, index) => `const value${index}=formatValue("formatted_${index}",${index});`,
    ).join("\n");
    expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
    const command = `node -e '${source}'`;
    render(command);
    await feature.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    expect(render(command).find((line) => line.includes("formatted_0"))).toContain(
        "\u001b[38;2;86;156;214mconst",
    );

    render(command, true);
    await feature.settled();
    let completions = 0;
    const stop = onSyntaxHighlightComplete(() => {
        completions++;
    });
    onTestFinished(stop);
    const published = render(command, true);
    const row = published.find((line) => line.includes("formatted_0"));
    expect(stripVTControlCharacters(row ?? "")).toContain(
        'const value0 = formatValue("formatted_0", 0);',
    );

    expect(row).toContain("\u001b[38;2;86;156;214mconst");
    await settleSyntaxHighlights();
    expect(completions).toBe(0);
});

it.each([
    { layout: "preserve", position: "trailing" },
    { layout: "always", position: "trailing" },
    { layout: "auto", position: "leading" },
] as const)(
    "publishes formatted compound code with prepared syntax ($layout / $position)",
    async ({ layout, position }) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const profiles = parseScriptFormatterCommandsValue({
            bash: { kind: "bash", command: ["fixture-only"] },
        });
        const formatter = Object.assign(
            async ({ code }: { readonly code: string }) =>
                code.replace(/const value(\d+)=/gu, "const value$1 = "),
            {
                profileFor: (language: string) => profiles.get(language),
            },
        );
        const { render, feature, invalidate } = harness(
            createNativeBashFeature(() => formatter),
            {
                expanded: false,
                layout,
                position,
            },
        );
        const source = Array.from(
            { length: 220 },
            (_value, index) => `const value${index}=formatValue("compound_${index}",${index});`,
        ).join("\n");
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        const command = `pwd && node --input-type=module <<'JS'\n${source}\nJS\n`;
        render(command);
        await feature.settled();
        render(command);
        await feature.settled();
        render(command);
        await settleSyntaxHighlights();
        invalidate();
        expect(render(command).find((line) => line.includes("compound_0"))).toContain(
            "\u001b[38;2;86;156;214mconst",
        );

        render(command, true);
        await feature.settled();
        let completions = 0;
        const stop = onSyntaxHighlightComplete(() => {
            completions++;
        });
        onTestFinished(stop);
        const row = render(command, true).find((line) => line.includes("compound_0"));
        expect(stripVTControlCharacters(row ?? "")).toContain(
            'const value0 = formatValue("compound_0",0);',
        );

        expect(row).toContain("\u001b[38;2;86;156;214mconst");
        await settleSyntaxHighlights();
        expect(completions).toBe(0);
    },
);

it("hands a revealed statement prefix to completion before retiring its live signal", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const store = createCodeStreamStore();
    const { render, feature, invalidate } = harness(createNativeBashFeature(), {
        stream: (input) => store.get({ ...input, mode: "statement" }),
    });
    onTestFinished(async () => store.dispose());
    const command = `pwd && node <<'JS'\nconst HANDOFF_KEEP = 1;\nconsole.log(HANDOFF_KEEP);\nJS\n`;
    render(command);
    await feature.settled();
    render(command);
    await store.settled();
    render(command);
    await feature.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    const row = (lines: string[]) =>
        lines.find((line) => stripVTControlCharacters(line).includes("const HANDOFF_KEEP"));
    const before = row(render(command));
    expect(before).toContain("\u001b[38;2;86;156;214mconst");
    const finalCommand = `${command}echo tail\n`;
    const pending = render(finalCommand, true);
    expect(row(pending)).toBe(before);
    await feature.settled();
    await store.settled();
    const completed = render(finalCommand, true);
    expect(row(completed)).toBe(before);
    expect(completed.map(stripVTControlCharacters).join("\n")).toContain("echo tail");
});

it.each([
    { compound: false, explicit: true },
    { compound: true, explicit: true },
    { compound: false, explicit: false },
    { compound: true, explicit: false },
])(
    "keeps formatter-changed statement colors across raw handoff ($compound / $explicit)",
    async ({ compound, explicit }) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const profiles = parseScriptFormatterCommandsValue({
            javascript: { kind: "command", command: ["fixture-only"] },
        });
        const formatter = Object.assign(
            async ({ code, language }: { readonly code: string; readonly language: string }) => {
                if (language === "javascript") return (await format("source.js", code)).code;
                return undefined;
            },
            { profileFor: (language: string) => profiles.get(language) },
        );
        const store = createCodeStreamStore();
        const { render, feature, invalidate } = harness(
            createNativeBashFeature(
                () => formatter,
                async (input, backend, options) => store.formatEmbedded(input, backend, options),
            ),
            {
                stream: (input) => store.get({ ...input, mode: "statement", formatter }),
            },
        );
        onTestFinished(async () => store.dispose());
        const source = Array.from(
            { length: 220 },
            (_, index) => `const value${index}=formatValue("handoff_${index}",${index});`,
        ).join("\n");
        expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
        let command = `node <<'JS'\n${source}\nJS\n`;
        if (compound) command = `pwd && ${command}`;
        render(command);
        await feature.settled();
        render(command);
        await store.settled();
        render(command);
        await feature.settled();
        render(command);
        await settleSyntaxHighlights();
        invalidate();
        const row = (lines: string[]) => lines.find((line) => line.includes("handoff_0"));
        const before = row(render(command));
        expect(before).toContain("\u001b[38;2;86;156;214mconst");
        expect(stripVTControlCharacters(before ?? "")).toContain("const value0 =");

        if (explicit)
            feature.schedule({
                toolCallId: "compound-heredoc",
                command,
                formatter,
                signal: undefined,
                invalidate,
                isCurrent: () => true,
            });

        expect(row(render(command, true))).toBe(before);
        await feature.settled();
        expect(row(render(command, true))).toContain("\u001b[38;2;86;156;214mconst");
        await settleSyntaxHighlights();
        invalidate();
        expect(row(render(command, true))).toContain("\u001b[38;2;86;156;214mconst");
    },
);

it("does not publish a raw handoff that completes after the feature is cleared", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const profiles = parseScriptFormatterCommandsValue({
        javascript: { kind: "command", command: ["fixture-only"] },
    });
    const formatter = Object.assign(
        async ({ code }: { readonly code: string }) => code.replace("x=1", "x = 1"),
        { profileFor: (language: string) => profiles.get(language) },
    );
    const store = createCodeStreamStore();
    const { render, feature, invalidate } = harness(
        createNativeBashFeature(() => formatter),
        {
            stream: (input) => store.get({ ...input, mode: "statement", formatter }),
        },
    );
    onTestFinished(async () => store.dispose());
    const command = "node <<'JS'\nconst x=1;\nconsole.log(x);\nJS\n";
    render(command);
    await feature.settled();
    render(command);
    await store.settled();
    render(command);
    await feature.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    expect(render(command).join("\n")).toContain("\u001b[38;2;86;156;214mconst");
    let cleared = false;
    let stalePublications = 0;

    const stop = onSyntaxHighlightComplete(() => {
        if (cleared) return;

        cleared = true;
        feature.clear();
    });
    onTestFinished(stop);
    feature.schedule({
        toolCallId: "compound-heredoc",
        command,
        formatter,
        signal: undefined,
        invalidate: () => {
            stalePublications++;
        },
        isCurrent: () => true,
    });

    render(command, true);
    await feature.settled();
    expect(cleared).toBe(true);
    expect(stalePublications).toBe(0);
    expect(feature.stats().entries).toBe(0);
    const fresh = render("echo fresh", true).map(stripVTControlCharacters).join("\n");
    expect(fresh).toContain("echo fresh");
    expect(fresh).not.toContain("const x");
});

it("preserves large sibling syntax colors when switching to a reflowed layout", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript", "python"] });
    const display: MutableShellLayout = {
        layout: "preserve",
        position: "leading",
    };
    const { render, feature, invalidate } = harness(createNativeBashFeature(), display);
    const source = Array.from(
        { length: 200 },
        (_, index) => `const value${index} = formatValue("blank_sibling_${index}", ${index});`,
    ).join("\n");
    expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
    const command = `pwd && python - <<'EMPTY'\n   \nEMPTY\nnode <<'JS'\n${source}\nJS\n`;
    render(command);
    await feature.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    const row = (lines: string[]) => lines.find((line) => line.includes("blank_sibling_0"));
    const before = row(render(command));
    expect(before).toContain("\u001b[38;2;86;156;214mconst");
    display.layout = "always";
    expect(row(render(command))).toBe(before);
});

it("keeps sibling syntax colors when an earlier heredoc becomes blank", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript", "python"] });
    const { render, feature, invalidate } = harness(createNativeBashFeature(), {
        layout: "always",
        position: "leading",
    });
    const source = Array.from(
        { length: 200 },
        (_, index) => `const value${index} = formatValue("blank_rewrite_${index}", ${index});`,
    ).join("\n");
    expect(Buffer.byteLength(source)).toBeGreaterThan(8 * 1024);
    const command = `pwd && python - <<'PY'\nprint(1)\nPY\nnode <<'JS'\n${source}\nJS\n`;
    render(command);
    await feature.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    const row = (lines: string[]) => lines.find((line) => line.includes("blank_rewrite_0"));
    const before = row(render(command));
    expect(before).toContain("\u001b[38;2;86;156;214mconst");
    const next = command.replace("print(1)", "   ");
    render(next);
    await feature.settled();
    expect(row(render(next))).toBe(before);
});

it.each([true, false])(
    "uses the refreshed pending-schedule validity callback (current: %s)",
    async (current) => {
        let gated = false;
        let release = () => {};
        let entered = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        onTestFinished(release);
        const formatter = async ({ code }: { readonly code: string }) => {
            if (!gated) return code;

            entered();
            await gate;

            return "const latest = 2;";
        };

        const { render, feature } = harness(createNativeBashFeature(() => formatter));
        const command = "node -e 'const raw = 1;'";
        render(command, true);
        await feature.settled();
        render(command, true);
        await feature.settled();
        const signal = new AbortController().signal;
        let oldCurrent = true;
        gated = true;
        feature.schedule({
            toolCallId: "compound-heredoc",
            command,
            formatter,
            signal,
            invalidate: () => {},
            isCurrent: () => oldCurrent,
        });
        await started;
        oldCurrent = !current;
        let publications = 0;
        feature.schedule({
            toolCallId: "compound-heredoc",
            command,
            formatter,
            signal,
            invalidate: () => {
                publications++;
            },
            isCurrent: () => current,
        });

        release();
        await feature.settled();
        const text = render(command, true).map(stripVTControlCharacters).join("\n");
        if (current) {
            expect(publications).toBeGreaterThan(0);
            expect(text).toContain("const latest = 2;");
        } else {
            expect(publications).toBe(0);
            expect(text).toContain("const raw = 1;");
            expect(text).not.toContain("const latest");
        }
    },
);

it.each([false, true])(
    "keeps visible standalone colors when a suffix makes the command compound (formatter: %s)",
    async (formatted) => {
        await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
        const store = createCodeStreamStore();
        const formatter = formatted
            ? async ({ code, language }: { readonly code: string; readonly language: string }) =>
                  language === "javascript" ? (await format("source.js", code)).code : undefined
            : undefined;
        const { render, feature, invalidate } = harness(
            createNativeBashFeature(() => formatter),
            {
                stream: (input) =>
                    store.get({
                        ...input,
                        mode: "statement",
                        ...(formatter !== undefined && { formatter }),
                    }),
            },
        );
        onTestFinished(async () => store.dispose());
        const source = Array.from(
            { length: 220 },
            (_, index) => `const value${index}=formatValue("transition_${index}",${index});`,
        ).join("\n");
        const command = `node <<'JS'\n${source}\nJS\n`;
        render(command);
        await feature.settled();
        render(command);
        await store.settled();
        render(command);
        await settleSyntaxHighlights();
        invalidate();
        const anchor = (lines: string[]) => lines.find((line) => line.includes("transition_0"));
        expect(anchor(render(command))).toContain("\u001b[38;2;86;156;214mconst");
        const next = `${command}echo done\n`;
        const pending = render(next);
        expect(anchor(pending)).toContain("\u001b[38;2;86;156;214mconst");
        await feature.settled();
        expect(anchor(render(next))).toContain("\u001b[38;2;86;156;214mconst");
        await store.settled();
        expect(anchor(render(next))).toContain("\u001b[38;2;86;156;214mconst");
    },
);

it.each(["clear", "expansion"] as const)("retires a standalone handoff on %s", async (change) => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    const store = createCodeStreamStore();
    const { render, feature, invalidate } = harness(createNativeBashFeature(), {
        stream: (input) => store.get({ ...input, mode: "statement" }),
    });
    onTestFinished(async () => store.dispose());
    const source = Array.from(
        { length: 220 },
        (_, index) => `const value${index} = formatValue("retired_${index}", ${index});`,
    ).join("\n");
    const command = `node -e '${source}'`;
    render(command);
    await feature.settled();
    render(command);
    await store.settled();
    render(command);
    await settleSyntaxHighlights();
    invalidate();
    expect(render(command).join("\n")).toContain("\u001b[38;2;86;156;214mconst");

    if (change === "clear") {
        expect(render(`${command}; echo done`).join("\n")).toContain("retired_0");
        feature.clear();
        await feature.settled();
        await store.settled();
        expect(feature.stats().entries).toBe(0);
        expect(render("echo fresh").join("\n")).not.toContain("retired_0");
    } else {
        const pending = render(`${command}"$DYNAMIC"`);
        expect(pending.join("\n")).not.toContain("\u001b[38;2;86;156;214mconst");
    }
});

it("carries a partially revealed standalone prefix into a compound view", async () => {
    await initializeSyntaxHighlighting({}, { preloadLanguages: ["javascript"] });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const formatter = async ({
        code,
        language,
    }: {
        readonly code: string;
        readonly language: string;
    }) => {
        if (language !== "javascript") return undefined;
        if (code.startsWith("const value1=")) await gate;
        return (await format("source.js", code)).code;
    };

    const store = createCodeStreamStore();
    const { render, feature, invalidate } = harness(
        createNativeBashFeature(() => formatter),
        {
            stream: (input) => store.get({ ...input, mode: "statement", formatter }),
        },
    );
    onTestFinished(async () => {
        release();
        await store.dispose();
    });
    const source = Array.from(
        { length: 220 },
        (_, index) => `const value${index}="prefix_${index}";`,
    ).join("\n");
    const command = `node <<'JS'\n${source}\nJS\n`;
    render(command);
    await feature.settled();
    const anchor = (lines: string[]) => lines.find((line) => line.includes("prefix_0"));
    await vi.waitFor(() => {
        invalidate();
        expect(anchor(render(command))).toContain("\u001b[38;2;86;156;214mconst");
    });
    expect(render(command).join("\n")).not.toContain("prefix_219");
    const next = `${command}echo done\n`;
    let flashed = false;
    await vi.waitFor(() => {
        const lines = render(next);
        if (anchor(lines)?.includes("\u001b[38;2;86;156;214mconst") !== true) flashed = true;
        expect(lines.map(stripVTControlCharacters).join("\n")).toContain("echo done");
    });
    expect(flashed).toBe(false);
    release();
    await store.settled();
});
