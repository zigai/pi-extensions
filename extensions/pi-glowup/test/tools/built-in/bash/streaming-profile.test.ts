import { Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import { parseScriptFormatterCommandsValue } from "../../../../src/tools/built-in/bash/formatter.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "../../../support/theme-colors.ts";

it.each(["show", "omit"] as const)(
    "respects imports: %s in independently streamed Bash scripts",
    (imports) => {
        const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");
        const profiles = parseScriptFormatterCommandsValue({
            python: { kind: "python", command: ["unused-formatter"], imports },
        });
        const formatter = Object.assign(async ({ code }: { code: string }) => code, {
            profileFor: (language: string) => profiles.get(language),
        });
        const feature = createNativeBashFeature(() => formatter);
        let source = "import math\nprint(math.pi)";
        if (imports === "show")
            source =
                "import math\n" +
                Array.from({ length: 10 }, (_, index) => `value${index} = ${index}`).join("\n");

        const command = `python - <<'PY'\n${source}\nPY`;
        const context: BuiltInRenderContext = {
            args: { command },
            toolCallId: "streamed-import-profile",
            cwd: "/work",
            lastComponent: undefined,
            state: {},
            executionStarted: true,
            argsComplete: true,
            isPartial: false,
            expanded: false,
            showImages: false,
            isError: false,
            durationMs: undefined,
            outputPad: 1,
            invalidate: () => {},
        };
        const render = (expanded: boolean, width: number) =>
            stripVTControlCharacters(
                feature
                    .renderBashCall(
                        { command },
                        theme,
                        { ...context, expanded },
                        () => 8,
                        () => true,
                        () => "preserve",
                        () => "trailing",
                        ({ source: code }) => code,
                    )
                    .render(width)
                    .join("\n"),
            );
        try {
            for (const width of [80, 40, 120]) {
                const collapsed = render(false, width);
                if (imports === "show") {
                    expect(collapsed).toContain("import math");
                    expect(collapsed).not.toContain("import/setup lines omitted");
                } else {
                    expect(collapsed).not.toContain("import math");
                    expect(collapsed).toContain("1 import/setup lines omitted");
                }

                expect(render(true, width)).toContain("import math");
            }
        } finally {
            feature.clear();
        }
    },
);
