import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import assistantRenderingExtension from "../src/index.ts";

initTheme("dark", false);

const message: AssistantMessage = {
    role: "assistant",
    content: [
        { type: "thinking", thinking: "Reasoning." },
        { type: "text", text: "Response." },
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

test("preserves streaming transitions and omitted flags for response and thinking transformers", async () => {
    let shutdown: (() => void) | undefined;
    try {
        await assistantRenderingExtension({
            on(_event, handler) {
                shutdown = handler;
            },
        });
        const component = new AssistantMessageComponent(
            undefined,
            false,
            getMarkdownTheme(),
            "Thinking",
            0,
            [
                (markdown, context) =>
                    `${context.messageType} streaming=${context.isStreaming}\n${markdown}`,
            ],
        );

        component.updateContent(message, true);
        let rendered = component.render(120).join("\n");
        expect(rendered).toContain("assistant streaming=true");
        expect(rendered).toContain("assistant-thinking streaming=true");

        component.updateContent(message);
        rendered = component.render(120).join("\n");
        expect(rendered).toContain("assistant streaming=true");
        expect(rendered).toContain("assistant-thinking streaming=true");

        component.updateContent(message, false);
        rendered = component.render(120).join("\n");
        expect(rendered).toContain("assistant streaming=false");
        expect(rendered).toContain("assistant-thinking streaming=false");

        component.updateContent(message);
        rendered = component.render(120).join("\n");
        expect(rendered).toContain("assistant streaming=false");
        expect(rendered).toContain("assistant-thinking streaming=false");
    } finally {
        shutdown?.();
    }
});
