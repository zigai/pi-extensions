import { describe, expect, it } from "vitest";
import { Theme } from "@earendil-works/pi-coding-agent";
import { TEST_THEME_BACKGROUND_COLORS, TEST_THEME_COLORS } from "../../../support/theme-colors.ts";
import { stripVTControlCharacters } from "node:util";
import { createNativeBashFeature } from "../../../../src/tools/built-in/bash/preview.ts";
import type {
    ShellLayout,
    ShellOperatorPosition,
} from "../../../../src/tools/built-in/bash/command.ts";
import type { BuiltInRenderContext } from "../../../../src/tools/built-in/context.ts";
import type { CodePreview } from "../../../../src/rendering/streaming/presentation.ts";
import { createCodeStreamStore } from "../../../../src/rendering/streaming/code-stream.ts";

const theme = new Theme(TEST_THEME_COLORS, TEST_THEME_BACKGROUND_COLORS, "truecolor");

function context(command: string, expanded = false): BuiltInRenderContext {
    return {
        args: { command },
        toolCallId: "streaming-bash-layout",
        cwd: "/work",
        lastComponent: undefined,
        state: {},
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded,
        showImages: false,
        isError: false,
        durationMs: undefined,
        outputPad: 1,
        invalidate: () => {},
    };
}

function render(
    command: string,
    streamCode: CodePreview,
    options: {
        layout?: ShellLayout;
        operators?: ShellOperatorPosition;
        expanded?: boolean;
        argsComplete?: boolean;
    } = {},
) {
    return createNativeBashFeature().renderBashCall(
        { command },
        theme,
        { ...context(command, options.expanded), argsComplete: options.argsComplete ?? true },
        () => "auto",
        () => 8,
        () => false,
        () => options.layout ?? "auto",
        () => options.operators ?? "trailing",
        streamCode,
    );
}

function rows(component: ReturnType<typeof render>, width = 160) {
    return component.render(width).map((line) => stripVTControlCharacters(line));
}

describe("streaming Bash layout", () => {
    it.each([false, true])("splits semicolon statements with expansion %s", (expanded) => {
        const command = "cat AGENTS.md; cat package.json; rg -n stream extensions | head -100";
        expect(rows(render(command, ({ source }) => source, { expanded }))).toEqual([
            "• Bash",
            "  │ cat AGENTS.md;",
            "  │ cat package.json;",
            "  │ rg -n stream extensions | head -100",
        ]);
    });

    it("applies preserve, always, and operator positioning to streamed snapshots", () => {
        const command = "first && second; third";
        expect(rows(render(command, ({ source }) => source, { layout: "preserve" }))).toEqual([
            "• Bash",
            `  │ ${command}`,
        ]);
        expect(
            rows(
                render("first && second", ({ source }) => source, {
                    layout: "always",
                    operators: "leading",
                }),
            ),
        ).toEqual(["• Bash", "  │ first", "  │ && second"]);
    });

    it("recomputes automatic layout on resize", () => {
        const component = render("alpha && beta", ({ source }) => source);
        expect(rows(component, 100)).toEqual(["• Bash alpha && beta"]);
        expect(rows(component, 16)).toEqual(["• Bash", "  │ alpha &&", "  │ beta"]);
        expect(rows(component, 100)).toEqual(["• Bash alpha && beta"]);
    });

    it("lays out only published statements, leaving an unfinished tail hidden", async () => {
        const store = createCodeStreamStore();
        const command = "first; second; echo 'UNFINISHED";
        const streamCode: CodePreview = (input) => store.get({ ...input, mode: "statement" });
        const component = render(command, streamCode, { argsComplete: false });
        try {
            rows(component);
            await store.settled();
            component.invalidate();
            const published = rows(component);
            expect(published).toEqual(["• Bash", "  │ first;", "  │ second"]);
            expect(published.join("\n")).not.toContain("UNFINISHED");
        } finally {
            await store.dispose();
        }
    });

    it("retains quoted separators and heredoc body text", () => {
        const command = "echo 'literal; && value'; cat <<'DATA'\nbody; literal\nDATA\nlast; final";
        expect(rows(render(command, ({ source }) => source, { expanded: true }))).toEqual([
            "• Bash",
            "  │ echo 'literal; && value';",
            "  │ cat <<'DATA'",
            "  │ body; literal",
            "  │ DATA",
            "  │ last;",
            "  │ final",
        ]);
    });

    it("keeps standalone interpreter previews in their own language", () => {
        expect(rows(render(`python -c "print('hello')"`, ({ source }) => source))).toEqual([
            "• Python print('hello')",
        ]);
    });
});
