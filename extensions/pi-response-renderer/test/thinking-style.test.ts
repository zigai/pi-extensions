/* oxlint-disable no-control-regex -- Assertions inspect terminal SGR styling. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { installResponseRendering } from "../src/response-rendering.ts";
import {
    configureMarkdownSyntaxPatch,
    markdownSyntaxPatchStats,
} from "../../pi-glowup/src/pi/patches/markdown-syntax.ts";

initTheme("dark", false);

const message: AssistantMessage = {
    role: "assistant",
    content: [
        {
            type: "thinking",
            thinking:
                'Plain `inline_code()` tail.\n\n```python\nimport os\nvalue = "NO_COLOR"\n```',
        },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5",
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
};

test("thinking uses one foreground, bold inline code, and no syntax highlighting through mouse wrappers", async () => {
    const handle = await installResponseRendering();
    try {
        const component = new AssistantMessageComponent(
            message,
            false,
            { ...getMarkdownTheme(), bold: (text) => `\u001b[1m${text}\u001b[22m` },
            "Thinking",
            0,
        );
        for (const width of [120, 30]) {
            const raw = component.render(width).join("\n");
            const plain = stripTerminalSequences(raw);
            expect(plain).toContain("inline_code()");
            expect(plain).toContain("import os");
            expect(plain).not.toContain("```");
            const foregrounds = new Set(raw.match(/\x1b\[(?:38;[\d;]+|3[0-7]|9[0-7])m/g));
            expect(foregrounds.size).toBe(1);
            expect(raw).toMatch(/\x1b\[1m[^\n]*inline_code\(\)/);
            expect(raw).not.toContain("\x1b[3m");
            expect(component.render(width).join("\n")).toBe(raw);
        }

        component.updateContent(message, true);
        expect(component.render(120).join("\n")).not.toContain("```");
        handle.dispose();
        expect(component.render(120).join("\n")).toContain("```");
    } finally {
        handle.dispose();
    }
});

for (const order of ["response-first", "glowup-first"] as const) {
    test(`Glowup does not inject syntax into monochrome thinking (${order})`, async () => {
        let handle;
        if (order === "response-first") {
            handle = await installResponseRendering();
            configureMarkdownSyntaxPatch(true);
        } else {
            configureMarkdownSyntaxPatch(true);
            handle = await installResponseRendering();
        }

        try {
            const component = new AssistantMessageComponent(
                message,
                false,
                getMarkdownTheme(),
                "Thinking",
                0,
            );
            const before = markdownSyntaxPatchStats().renderInjections;
            const output = component.render(80).join("\n");
            expect(output).toContain("import os");
            expect(markdownSyntaxPatchStats().renderInjections).toBe(before);
            expect(new Set(output.match(/\x1b\[(?:38;[\d;]+|3[0-7]|9[0-7])m/g)).size).toBe(1);
        } finally {
            // Restore in installation order, exercising linked-patch composition too.
            if (order === "response-first") {
                configureMarkdownSyntaxPatch(false);
                handle.dispose();
            } else {
                handle.dispose();
                configureMarkdownSyntaxPatch(false);
            }
        }
    });
}

test("thinking presentation follows explicit Markdown invalidation and theme changes", async () => {
    const handle = await installResponseRendering();
    try {
        let label = "first";
        let foreground = "\u001b[90m";
        const component = new Markdown(
            "source",
            0,
            0,
            getMarkdownTheme(),
            {
                italic: true,
                color: (text) => `${foreground}${text}\u001b[39m`,
            },
            { transform: () => label },
        );
        expect(component.render(80).join("\n")).toContain("first");
        label = "second";
        component.invalidate();
        expect(component.render(80).join("\n")).toContain("second");
        foreground = "\u001b[37m";
        expect(component.render(80).join("\n")).toContain("\u001b[37msecond");
    } finally {
        handle.dispose();
    }
});
