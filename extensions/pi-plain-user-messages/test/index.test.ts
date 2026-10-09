import assert from "node:assert/strict";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

import { test } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";

import plainUserMessagesExtension from "../src/index.ts";
import { userMessageRuntime } from "../src/user-message-runtime.ts";

const identity = (text: string): string => text;
const markdownTheme: MarkdownTheme = {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: identity,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: identity,
    italic: identity,
    strikethrough: identity,
    underline: identity,
};

type LifecycleApi = {
    readonly api: NonNullable<Parameters<typeof plainUserMessagesExtension>[0]>;
    readonly shutdownHandlers: Array<() => void>;
};

function createLifecycleApi(): LifecycleApi {
    const shutdownHandlers: Array<() => void> = [];
    const api = {
        on(event: string, handler: () => void): void {
            if (event === "session_shutdown") shutdownHandlers.push(handler);
        },
    };

    return { api, shutdownHandlers };
}

async function loadUserMessageConstructor(): Promise<
    NonNullable<ReturnType<typeof userMessageRuntime.parse>>
> {
    const bundle: unknown = await import("@earendil-works/pi-coding-agent");
    const component = userMessageRuntime.parse(bundle);
    if (component === undefined) {
        assert.fail("missing UserMessageComponent");
    }

    return component;
}

test("renders Markdown heading syntax literally in bundled user messages", async () => {
    const originalPiFlag = process.env.PI_CODING_AGENT;
    process.env.PI_CODING_AGENT = "true";
    initTheme(undefined, false);
    const UserMessageComponent = await loadUserMessageConstructor();
    const lifecycle = createLifecycleApi();

    try {
        await plainUserMessagesExtension(lifecycle.api);
        const message = new UserMessageComponent("# test 1", markdownTheme, 0);
        assert.ok(message.render(80).some((line) => line.includes("# test 1")));
    } finally {
        for (const handler of lifecycle.shutdownHandlers) handler();

        if (originalPiFlag === undefined) delete process.env.PI_CODING_AGENT;
        else process.env.PI_CODING_AGENT = originalPiFlag;
    }
});
