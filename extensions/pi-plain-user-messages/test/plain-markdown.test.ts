import { Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { ensurePlainTextUserMessage } from "../src/plain-markdown.ts";

initTheme("dark", false);

test("preserves literal text and new padding when the same user container replaces its Markdown", () => {
    const container = new Container();
    container.addChild(new Markdown("**original**", 1, 0, getMarkdownTheme()));
    ensurePlainTextUserMessage(container);
    expect(container.render(40).map((line) => line.trim())).toEqual(["**original**"]);

    container.clear();
    container.addChild(new Markdown("# replacement", 3, 0, getMarkdownTheme()));
    ensurePlainTextUserMessage(container);
    const rebuilt = container.render(40);
    expect(rebuilt.map((line) => line.trim())).toEqual(["# replacement"]);
    expect(rebuilt[0]?.startsWith("   # replacement")).toBe(true);

    ensurePlainTextUserMessage(container);
    expect(container.render(40)).toEqual(rebuilt);
});
