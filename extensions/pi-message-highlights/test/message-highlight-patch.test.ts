import { expect, test, vi } from "vitest";
import { Container, MouseRegion, Text } from "@earendil-works/pi-tui";
import * as highlighting from "../src/highlight-text.ts";
import { installLinkedRenderPatch } from "@zigai/pi-extension-internals";
import { installMessageHighlightPatch } from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";

// Failure cases: unchanged redraws redo matching; mutable input/output arrays poison reuse;
// width, streaming, style or Markdown-source changes reuse stale output; temporary assistant
// child patches lose their caches; disposal leaks a prior policy into a fresh installation.
test("unchanged redraws reuse highlighting without skipping upstream rendering", () => {
    const render = vi.fn((_width: number) => ["Read src/main.ts https://example.com"]);
    const userPrototype = { render };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: { render: () => [] },
            userPrototype,
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    const transform = vi.spyOn(highlighting, "highlightMessageLines");
    try {
        const first = userPrototype.render(80);
        expect(userPrototype.render(80)).toEqual(first);
        expect(render).toHaveBeenCalledTimes(2);
        expect(transform).toHaveBeenCalledTimes(1);
        first[0] = "changed by a successor";
        expect(userPrototype.render(80)).not.toEqual(first);
        expect(transform).toHaveBeenCalledTimes(1);
    } finally {
        transform.mockRestore();
        patch.dispose();
    }
});

test("cached renders follow mutable upstream lines, width and policy changes", () => {
    const lines = ["Read src/main.ts https://example.com"];
    const userPrototype = {
        render: (width: number) => {
            if (width < 40) return ["https://example.com", "src/main.ts"];
            return lines;
        },
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: { render: () => [] },
            userPrototype,
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        const first = userPrototype.render(80);
        expect(userPrototype.render(80)).toEqual(first);
        expect(lines).toEqual(["Read src/main.ts https://example.com"]);
        lines[0] = "Stream https://example.org/new src/next.ts";
        expect(userPrototype.render(80).join("\n")).toContain("example.org/new");
        expect(userPrototype.render(80)).not.toEqual(first);
        const narrow = userPrototype.render(20);
        expect(narrow).toHaveLength(2);
        expect(userPrototype.render(80)).toHaveLength(1);
        patch.update({ urlColor: { kind: "none" } });
        expect(userPrototype.render(80).join("\n")).not.toContain("38;2;135;215;255");
    } finally {
        patch.dispose();
    }
});

test("assistant child caching survives temporary patch lifetimes and thinking visibility", () => {
    const text = new Text("Read https://example.com src/main.ts", 0, 0);
    const thinking = new MouseRegion(
        new Text("Check https://example.org src/next.ts", 0, 0),
        () => undefined,
    );
    const contentContainer = new Container();
    contentContainer.addChild(thinking);
    contentContainer.addChild(text);
    const assistantPrototype = {
        contentContainer,
        render: (width: number) => contentContainer.render(width),
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    const transform = vi.spyOn(highlighting, "highlightMessageLines");
    try {
        const first = assistantPrototype.render(100);
        const initialCalls = transform.mock.calls.length;
        expect(assistantPrototype.render(100)).toEqual(first);
        expect(transform).toHaveBeenCalledTimes(initialCalls);
        expect(first.join("\n")).toContain("\u001b[1mhttps://example.org");
        contentContainer.removeChild(thinking);
        expect(assistantPrototype.render(100).join("\n")).not.toContain("example.org");
        contentContainer.addChild(thinking);
        expect(assistantPrototype.render(100).join("\n")).toContain("example.org");
    } finally {
        transform.mockRestore();
        patch.dispose();
    }
});

test("releases obsolete assistant-child transformations even when other patches retain children", () => {
    const oldChild = new Text("Read https://example.com/old", 0, 0);
    const nextChild = new Text("Read https://example.com/new", 0, 0);
    const contentContainer = new Container();
    contentContainer.addChild(oldChild);
    const assistantPrototype = {
        contentContainer,
        render: (width: number) => contentContainer.render(width),
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    const transform = vi.spyOn(highlighting, "highlightMessageLines");
    try {
        assistantPrototype.render(80);
        contentContainer.removeChild(oldChild);
        contentContainer.addChild(nextChild);
        assistantPrototype.render(80);
        const calls = transform.mock.calls.length;
        oldChild.render(80);
        expect(transform.mock.calls.length).toBeGreaterThan(calls);
        const reinsertCalls = transform.mock.calls.length;
        contentContainer.removeChild(nextChild);
        contentContainer.addChild(oldChild);
        assistantPrototype.render(80);
        expect(transform.mock.calls.length).toBeGreaterThan(reinsertCalls);
    } finally {
        transform.mockRestore();
        patch.dispose();
    }
});

test("rendering reads the current theme after theme changes", () => {
    const assistantPrototype = { render: (_width: number) => ["https://example.com"] };
    const userPrototype = { render: (_width: number) => ["https://example.com"] };
    const editorPrototype = { render: (_width: number) => [] };
    const original = assistantPrototype.render;
    let color = "31";
    const patch = installMessageHighlightPatch(
        { assistantPrototype, userPrototype, editorPrototype },
        { urlColor: { kind: "theme", color: "mdLink" } },
        () => ({
            fg: (_name, text) => `\u001b[${color}m${text}\u001b[39m`,
            getColorMode: () => "truecolor",
        }),
    );
    try {
        expect(userPrototype.render(80).join(" ")).toContain("\u001b[31m");
        color = "34";
        expect(userPrototype.render(80).join(" ")).toContain("\u001b[34m");
    } finally {
        patch.dispose();
    }

    expect(assistantPrototype.render).toBe(original);
});

test("reinstall updates current policy without stacking; disposal preserves successor", () => {
    const assistantPrototype = { render: (_width: number) => ["https://example.com"] };
    const userPrototype = { render: (_width: number) => ["https://example.com"] };
    const editorPrototype = { render: (_width: number) => [], getText: () => "" };
    const original = assistantPrototype.render;
    const targets = { assistantPrototype, userPrototype, editorPrototype };
    const patch = installMessageHighlightPatch(
        targets,
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    const installed = assistantPrototype.render;
    const same = installMessageHighlightPatch(
        targets,
        { urlColor: { kind: "none" } },
        () => undefined,
    );
    expect(same).toBe(patch);
    expect(assistantPrototype.render).toBe(installed);
    expect(userPrototype.render(80).join("\n")).not.toContain("38;");
    patch.update(DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG);
    expect(userPrototype.render(80).join("\n")).toContain("38;");
    const successor = installLinkedRenderPatch(
        assistantPrototype,
        (previous) =>
            function (width) {
                return [...previous.call(this, width), "successor"];
            },
    );
    patch.dispose();
    patch.dispose();
    patch.update(DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG);
    expect(assistantPrototype.render(80)).toEqual(["https://example.com", "successor"]);
    successor.dispose();
    expect(assistantPrototype.render).toBe(original);
});
