import { expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { TuiAltScreen, type Terminal, type MarkdownTheme } from "@earendil-works/pi-tui";
import { installResponseRendering } from "../src/response-rendering.ts";

class FakeTerminal implements Terminal {
    columns = 80;
    rows = 20;
    kittyProtocolActive = false;
    input: (data: string) => void = () => {};
    start(onInput: (data: string) => void): void {
        this.input = onInput;
    }
    stop(): void {}
    async drainInput(): Promise<void> {}
    write(): void {}
    moveBy(): void {}
    hideCursor(): void {}
    showCursor(): void {}
    clearLine(): void {}
    clearFromCursor(): void {}
    clearScreen(): void {}
    setTitle(): void {}
    setProgress(): void {}
    setProgramStatus(): void {}
}
const identity = (text: string) => text;
const theme: MarkdownTheme = {
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

it("folds and unfolds via fullscreen terminal press/release and keeps body selection available", async () => {
    const handle = await installResponseRendering();
    const terminal = new FakeTerminal();
    const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
    const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "# Heading\n\nbody text\n\n# Next\n\nnext body" }],
        api: "openai-responses",
        provider: "synthetic",
        model: "sample",
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
    tui.setLayoutRoot(new AssistantMessageComponent(message, false, theme, "Thinking", 0));
    try {
        tui.start();
        tui.renderNow();
        const screen = () => tui.getScreenLines().map(stripVTControlCharacters).join("\n");
        const click = (text: string) => {
            const y = tui
                .getScreenLines()
                .findIndex((line) => stripVTControlCharacters(line).includes(text));
            expect(y).toBeGreaterThanOrEqual(0);
            terminal.input(`\u001b[<0;2;${y + 1}M`);
            terminal.input(`\u001b[<0;2;${y + 1}m`);
            tui.renderNow();
        };
        expect(screen()).toContain("body text");
        click("Heading");
        expect(screen()).not.toContain("body text");
        expect(screen()).toContain("next body");
        click("Heading");
        expect(screen()).toContain("body text");
        const bodyY = tui
            .getScreenLines()
            .findIndex((line) => stripVTControlCharacters(line).includes("body text"));
        terminal.input(`\u001b[<0;2;${bodyY + 1}M`);
        terminal.input(`\u001b[<32;6;${bodyY + 1}M`);
        terminal.input(`\u001b[<0;6;${bodyY + 1}m`);
        expect(tui.hasActiveSelection()).toBe(true);
        tui.resetTextSelection();
        const headingY = tui
            .getScreenLines()
            .findIndex((line) => stripVTControlCharacters(line).includes("Heading"));
        terminal.input(`\u001b[<4;2;${headingY + 1}M`);
        terminal.input(`\u001b[<36;6;${headingY + 1}M`);
        terminal.input(`\u001b[<4;6;${headingY + 1}m`);
        expect(tui.hasActiveSelection()).toBe(true);
        tui.renderNow();
        expect(screen()).toContain("body text");
    } finally {
        tui.stop();
        handle.dispose();
    }
});
