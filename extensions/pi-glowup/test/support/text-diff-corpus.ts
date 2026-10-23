import { Theme } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { renderGlowupDiff } from "../../src/rendering/diff/text-renderer.ts";
import type { DiffSection } from "../../src/rendering/diff/text-diff.ts";
import { configureRenderingAppearance } from "../../src/rendering/theme.ts";
import {
    disposeSyntaxHighlighting,
    initializeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../src/rendering/syntax/highlighter.ts";
import { TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS } from "./theme-colors.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

const sections: readonly DiffSection[] = [
    {
        path: "src/example.ts",
        added: 4,
        removed: 3,
        lines: [
            "@@ metadata",
            "  ...",
            "  … omitted context",
            " 1 const stable = true;",
            "-9 const before = 'old';",
            "+9 const before = 'new';",
            "-10 unchangedReplacement();",
            "+10 unchangedReplacement();",
            "-11 ",
            "+11 \tconst 界 = '👩‍💻 é';",
            "+12 const nested = ({ value: [1, 2] });",
            "+13 // " + "long Unicode 界 👩‍💻 ".repeat(12),
            "context without a sign",
            "+ not a numbered row",
            " 55 tail();",
        ],
        lineCoordinates: [
            undefined,
            undefined,
            undefined,
            { oldLine: 1, newLine: 1 },
            { oldLine: 9 },
            { newLine: 9 },
            { oldLine: 10 },
            { newLine: 10 },
            { oldLine: 11 },
            { newLine: 11 },
            { newLine: 12 },
            { newLine: 13 },
        ],
    },
    {
        path: "notes.txt",
        added: 2,
        removed: 1,
        lines: [
            "- 1 \u001b[31mold\u001b[0m",
            "+ 1 \u001b[32mnew\u001b[0m",
            "+ 2 unsafe\u001b[2J control\r\nnext",
            "\t...",
            "\t… remaining",
            "",
            "+3 final",
        ],
    },
    { path: "empty.txt", added: 0, removed: 0, lines: [] },
];

export async function textDiffGolden(): Promise<string> {
    const snapshots: Record<string, string> = {};
    await disposeSyntaxHighlighting();

    try {
        for (const syntax of ["plain", "highlighted"] as const) {
            if (syntax === "highlighted") {
                await disposeSyntaxHighlighting();

                const state = await initializeSyntaxHighlighting(
                    {},
                    {
                        preloadLanguages: ["typescript"],
                        projectLanguageDetection: { enabled: false },
                    },
                );
                if (state.status !== "ready")
                    throw new Error("Golden syntax initialization failed");
            }

            for (const style of ["full-row", "two-tone", "changed-spans"] as const) {
                for (const numbers of ["dual", "single"] as const) {
                    configureRenderingAppearance({
                        diffBackgroundStyle: style,
                        diffLineNumberStyle: numbers,
                        narrowDiffLayout: "paired",
                        sideBySideLayout: "content-aware",
                        addedRowBackground: "#213A2B",
                        deletedRowBackground: "#4A221D",
                        addedContentBackground: "#0D5728",
                        deletedContentBackground: "#762925",
                        instructionPathColor: null,
                        dimUnchangedDiffText: false,
                    });

                    for (const expanded of [false, true]) {
                        const component = renderGlowupDiff(theme, sections, expanded);
                        const frames: string[][] = [];
                        for (const width of [20, 80, 180, 80]) {
                            component.render(width);
                            await settleSyntaxHighlights();
                            frames.push(component.render(width));
                        }

                        snapshots[`${syntax}:${style}:${numbers}:${expanded}`] = createHash(
                            "sha256",
                        )
                            .update(JSON.stringify(frames))
                            .digest("hex");
                    }
                }
            }
        }
    } finally {
        await disposeSyntaxHighlighting();
    }

    return `${JSON.stringify(snapshots, null, 2)}\n`;
}
