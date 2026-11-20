import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    discoverAndLoadExtensions,
    ExtensionRunner,
    getMarkdownTheme,
    initTheme,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { installResponseRendering } from "../src/response-rendering.ts";

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
    const handle = await installResponseRendering();
    try {
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
        handle.dispose();
    }
});

test("registered transformer renders closed assistant table fences without changing thinking or source", async ({
    onTestFinished,
}) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-response-renderer-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const loaded = await discoverAndLoadExtensions(
        [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        directory,
        join(directory, "agent"),
    );
    expect(loaded.errors).toEqual([]);
    const models = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        directory,
        SessionManager.inMemory(directory),
        new ModelRegistry(models),
    );
    const transformers = runner.getMarkdownTransformers();
    const transformer = transformers.at(0);
    if (transformer === undefined) throw new Error("transformer not registered");

    const table = "```md\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n```";
    for (const messageType of [
        "assistant-thinking",
        "user",
        "custom",
        "summary",
        "changelog",
    ] as const) {
        expect(
            transformer(table, {
                messageType,
                isStreaming: messageType === "assistant-thinking",
                availableWidth: 80,
            }),
        ).toBe(table);
    }
    const handle = await installResponseRendering();
    try {
        const component = new AssistantMessageComponent(
            undefined,
            false,
            getMarkdownTheme(),
            "Thinking",
            0,
            transformers,
        );
        const partial: AssistantMessage = {
            ...message,
            content: [{ type: "text", text: table.slice(0, -3) }],
        };
        component.updateContent(partial, true);
        const before = stripVTControlCharacters(component.render(100).join("\n"));
        expect(before).toContain("| --- | --- |");
        const complete: AssistantMessage = { ...message, content: [{ type: "text", text: table }] };
        component.updateContent(complete, true);
        const during = stripVTControlCharacters(component.render(100).join("\n"));
        expect(during).toContain("Name");
        expect(during).toContain("alpha");
        expect(during).not.toContain("| --- | --- |");
        component.updateContent(complete, false);
        expect(stripVTControlCharacters(component.render(60).join("\n"))).not.toContain(
            "| --- | --- |",
        );

        expect(complete.content).toEqual([{ type: "text", text: table }]);
        const thinking: AssistantMessage = {
            ...message,
            content: [{ type: "thinking", thinking: table }],
        };
        component.updateContent(thinking, false);
        expect(stripVTControlCharacters(component.render(100).join("\n"))).toContain(
            "| --- | --- |",
        );
    } finally {
        handle.dispose();
    }
});
