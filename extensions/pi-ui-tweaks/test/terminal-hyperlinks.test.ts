import assert from "node:assert/strict";
import {
    Markdown,
    TuiMainScreen,
    getCapabilities,
    resetCapabilitiesCache,
    type Component,
    type MarkdownTheme,
    type TUI,
    type Terminal,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";

import { installTerminalHyperlinkRefresh } from "../src/terminal-hyperlinks.ts";

class FakeTerminal implements Terminal {
    columns = 80;
    rows = 10;

    get kittyProtocolActive(): boolean {
        return false;
    }

    start(): void {}

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
}

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

test("tmux client attachment refreshes cached Markdown links and detachment restores visible URLs", () => {
    const originalTmux = process.env.TMUX;
    const originalHyperlinks = process.env.PI_HYPERLINKS;
    process.env.TMUX = "/test";
    process.env.PI_HYPERLINKS = "0";
    resetCapabilitiesCache();
    vi.useFakeTimers();

    const tui = new TuiMainScreen(new FakeTerminal());
    const markdown = new Markdown("[docs](https://example.invalid)", 0, 0, markdownTheme);
    tui.addChild(markdown);
    const widgetKeys: string[] = [];
    const context = {
        hasUI: true,
        ui: {
            setWidget(key: string, content: ((tui: TUI) => Component) | undefined): void {
                widgetKeys.push(key);

                content?.(tui);
            },
        },
    };

    try {
        const initial = markdown.render(80).join("\n");
        assert.match(initial, /docs \(https:\/\/example\.invalid\)/);
        const handle = installTerminalHyperlinkRefresh(context, true);
        process.env.PI_HYPERLINKS = "1";
        vi.advanceTimersByTime(1000);

        const attached = markdown.render(80).join("\n");
        assert.equal(getCapabilities().hyperlinks, true);
        assert.equal(attached.includes("\u001b]8;;https://example.invalid"), true);
        assert.doesNotMatch(attached, /docs \(https:\/\/example\.invalid\)/);
        process.env.PI_HYPERLINKS = "0";
        vi.advanceTimersByTime(1000);
        assert.equal(getCapabilities().hyperlinks, false);
        assert.match(markdown.render(80).join("\n"), /docs \(https:\/\/example\.invalid\)/);
        handle.dispose();
        assert.equal(widgetKeys.length, 2);
        process.env.PI_HYPERLINKS = "1";
        vi.advanceTimersByTime(1000);
        assert.equal(getCapabilities().hyperlinks, false);
    } finally {
        vi.useRealTimers();

        if (originalTmux === undefined) delete process.env.TMUX;
        else process.env.TMUX = originalTmux;

        if (originalHyperlinks === undefined) delete process.env.PI_HYPERLINKS;
        else process.env.PI_HYPERLINKS = originalHyperlinks;

        resetCapabilitiesCache();
    }
});
