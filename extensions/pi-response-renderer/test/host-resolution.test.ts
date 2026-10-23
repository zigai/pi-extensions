import type { AssistantMessage } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import { installResponseRendering } from "../src/response-rendering.ts";

initTheme("dark", false);

test("renders through the public assistant component and restores native rendering on disposal", async () => {
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "```ts\nconst value = 1;\n```" }],
        api: "openai-responses",
        provider: "openai",
        model: "sample",
        stopReason: "stop",
        timestamp: 0,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };
    const handle = await installResponseRendering();
    try {
        const component = new AssistantMessageComponent(
            message,
            false,
            getMarkdownTheme(),
            "Thinking",
            0,
        );
        const rendered = component.render(80).join("\n");
        expect(rendered).toContain("const");
        expect(rendered).not.toContain("```");
    } finally {
        handle.dispose();
    }

    const restored = new AssistantMessageComponent(
        message,
        false,
        getMarkdownTheme(),
        "Thinking",
        0,
    );
    expect(restored.render(80).join("\n")).toContain("```");
    handle.dispose();
});
