/* oxlint-disable no-control-regex -- Assertions inspect terminal SGR styling. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
} from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";
import { installResponseRendering } from "../../pi-response-renderer/src/response-rendering.ts";

initTheme("dark", false);

const message: AssistantMessage = {
    role: "assistant",
    content: [
        {
            type: "thinking",
            thinking:
                'Thinking: `inline_code()` src/main.py https://example.com/docs tail.\n\n```python\nimport os\nvalue = "NO_COLOR"\n```',
        },
        {
            type: "text",
            text: "Response: src/main.py https://example.com/docs\n\n```python\nimport os\n```",
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

for (const order of ["response-first", "highlights-first"] as const) {
    test(`thinking stays monochrome with bold emphasis, without changing responses (${order})`, async () => {
        const targets = await loadMessageHighlightTargets();
        expect(targets).toBeDefined();

        if (targets === undefined) return;

        const highlight = () =>
            installMessageHighlightPatch(targets, DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG, () => ({
                fg: (_color, text) => `\u001b[38;2;10;20;30m${text}\u001b[39m`,
                getColorMode: () => "truecolor",
            }));
        let response;
        let highlights;
        if (order === "response-first") {
            response = await installResponseRendering();
            highlights = highlight();
        } else {
            highlights = highlight();
            response = await installResponseRendering();
        }

        try {
            const component = new AssistantMessageComponent(
                message,
                false,
                {
                    ...getMarkdownTheme(),
                    bold: (text) => `\u001b[1m${text}\u001b[22m`,
                    highlightCode: (code) =>
                        code.split("\n").map((line) => `\u001b[31m${line}\u001b[39m`),
                },
                "Thinking",
                0,
            );
            for (const streaming of [true, false]) {
                component.updateContent(message, streaming);

                for (const width of [120, 40, 120]) {
                    const raw = component.render(width).join("\n");
                    const boundary = raw.indexOf("Response:");
                    expect(boundary).toBeGreaterThan(0);
                    const thinking = raw.slice(0, boundary);
                    const answer = raw.slice(boundary);
                    const colors = new Set(thinking.match(/\x1b\[(?:38;[\d;]+|3[0-7]|9[0-7])m/g));
                    expect(colors.size).toBe(1);
                    expect(thinking).toMatch(/\x1b\[1m[^\n]*inline_code\(\)/);
                    expect(thinking).toMatch(/\x1b\[1m[^\n]*src\/main.py/);
                    expect(thinking).toContain("\u001b[1mhttps://example.com/docs");
                    expect(thinking).not.toContain("\u001b[31m");
                    expect(answer).toContain("\u001b[31m");
                    expect(answer).toContain("\u001b[38;2;10;20;30msrc/main.py");
                    expect(component.render(width).join("\n")).toBe(raw);
                }
            }

            component.setHideThinkingBlock(true);
            expect(component.render(120).join("\n")).not.toContain("inline_code()");
            component.setHideThinkingBlock(false);
            expect(component.render(120).join("\n")).toContain("inline_code()");
        } finally {
            highlights.dispose();
            response.dispose();
        }
    });
}
