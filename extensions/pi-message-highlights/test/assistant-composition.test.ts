/* oxlint-disable typescript/unbound-method -- Method identity is inspected for patch restoration, never called unbound. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, Text } from "@earendil-works/pi-tui";
import { installLinkedRenderPatch } from "@zigai/pi-extension-internals";
import { expect, test, vi } from "vitest";
import * as highlighting from "../src/highlight-text.ts";
import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
} from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";

initTheme("dark", false);

const message: AssistantMessage = {
    role: "assistant",
    content: [
        { type: "thinking", thinking: "Check src/main.ts https://example.org" },
        { type: "text", text: "Read src/main.ts https://example.com" },
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

function assistant(): AssistantMessageComponent {
    return new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking", 0);
}

async function install() {
    const targets = await loadMessageHighlightTargets();
    if (targets === undefined) throw new Error("Missing SDK targets");
    return installMessageHighlightPatch(
        targets,
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
}

test("real SDK redraws keep child patches stable; streaming and visibility remove old handles", async () => {
    const component = assistant();
    const container = component.children.find((child) => child instanceof Container);
    if (!(container instanceof Container)) throw new Error("Missing SDK content container");

    const originalContainerRender = container.render;
    const originalAdd = container.addChild;
    const originalChildren = [...container.children];
    const originals = originalChildren.map((child) => child.render);
    const patch = await install();
    try {
        const first = component.render(100);
        const installed = originalChildren.map((child) => child.render);
        for (let index = 0; index < installed.length; index += 1) {
            expect(installed[index]).not.toBe(originals[index]);
        }

        expect(component.render(100)).toEqual(first);
        expect(originalChildren.map((child) => child.render)).toEqual(installed);
        component.updateContent(message, true);

        // SDK clear/rebuild reuses Markdown slots but replaces MouseRegions.
        for (let index = 0; index < originalChildren.length; index += 1) {
            const child = originalChildren[index];
            if (!container.children.includes(child)) {
                expect(child.render).toBe(originals[index]);
                expect(Object.hasOwn(child, "render")).toBe(false);
            }
        }

        component.setHideThinkingBlock(true);
        expect(component.render(100).join("\n")).not.toContain("example.org");
        component.setHideThinkingBlock(false);
        expect(component.render(100).join("\n")).toContain("\u001b[1mhttps://example.org");
        patch.update({ urlColor: { kind: "none" } });
        expect(component.render(100).join("\n")).not.toContain("38;2;135;215;255");
    } finally {
        patch.dispose();
    }

    expect(container.render).toBe(originalContainerRender);
    expect(container.addChild).toBe(originalAdd);

    for (const key of ["render", "addChild", "removeChild", "clear"]) {
        expect(Object.hasOwn(container, key)).toBe(false);
    }

    for (const child of container.children) expect(Object.hasOwn(child, "render")).toBe(false);
});

for (const foreignFirst of [false, true]) {
    for (const foreignDisposesFirst of [false, true]) {
        test(`foreign child ownership: installed first=${foreignFirst}, disposed first=${foreignDisposesFirst}`, async () => {
            const child = new MouseRegion(
                new Text("https://example.org src/main.ts", 0, 0),
                () => undefined,
            );
            const original = child.render;
            const container = new Container();
            container.addChild(child);
            const target = {
                contentContainer: container,
                render: (width: number) => container.render(width),
            };
            const foreign = () =>
                installLinkedRenderPatch(
                    child,
                    (previous) =>
                        function (width) {
                            return [...previous.call(this, width), "foreign"];
                        },
                );
            let other;
            if (foreignFirst) other = foreign();

            const patch = installMessageHighlightPatch(
                {
                    assistantPrototype: target,
                    userPrototype: { render: () => [] },
                    editorPrototype: { render: () => [] },
                },
                DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
                () => undefined,
            );
            try {
                target.render(100);

                if (!foreignFirst) other = foreign();
                expect(target.render(100)).toContain("foreign");

                if (foreignDisposesFirst) {
                    other?.dispose();
                    expect(target.render(100)).not.toContain("foreign");
                    patch.dispose();
                } else {
                    patch.dispose();
                    expect(child.render(100)).toContain("foreign");
                    other?.dispose();
                }

                expect(child.render).toBe(original);
                expect(Object.hasOwn(child, "render")).toBe(false);
            } finally {
                patch.dispose();
                other?.dispose();
            }
        });
    }
}

test("discovers children added by predecessors and during container layout; removal restores immediately", () => {
    const container = new Container();
    const added = new MouseRegion(
        new Text("https://example.org src/added.ts", 0, 0),
        () => undefined,
    );
    const original = added.render;
    let add = false;
    container.addChild({
        render: () => {
            if (add) {
                add = false;
                container.addChild(added);
            }

            return [];
        },
        invalidate: () => undefined,
    });
    const target = {
        contentContainer: container,
        render: (width: number) => container.render(width),
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: target,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        target.render(100);
        add = true;
        expect(target.render(100).join("\n")).toContain("\u001b[1mhttps://example.org");
        container.removeChild(added);
        expect(added.render).toBe(original);
        expect(Object.hasOwn(added, "render")).toBe(false);
    } finally {
        patch.dispose();
    }
});

test("reentrant rendering and exceptions balance thinking state and remain disposable", () => {
    const container = new Container();
    let recurse = true;
    let fail = true;

    const target = {
        contentContainer: container,
        render: (width: number) => container.render(width),
    };
    const thinking = new MouseRegion(
        {
            render: (width) => {
                if (recurse) {
                    recurse = false;
                    target.render(width);
                }

                if (fail) throw new Error("layout failure");
                return ["https://example.org src/main.ts"];
            },
            invalidate: () => undefined,
        },
        () => undefined,
    );
    container.addChild(thinking);
    const original = thinking.render;
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: target,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        expect(() => target.render(100)).toThrow("layout failure");
        fail = false;
        expect(target.render(100).join("\n")).toContain("\u001b[1mhttps://example.org");
        expect(new Text("https://example.com", 0, 0).render(100).join("\n")).toContain("38;");
    } finally {
        patch.dispose();
    }

    expect(thinking.render).toBe(original);
    expect(Object.hasOwn(thinking, "render")).toBe(false);
});

test("another assistant's reentrant render does not activate an idle owner's thinking patches", () => {
    class Assistant {
        contentContainer = new Container();
        other: Container | undefined;

        render(width: number): string[] {
            return [...(this.other?.render(width) ?? []), ...this.contentContainer.render(width)];
        }
    }

    const first = new Assistant();
    const second = new Assistant();
    first.contentContainer.addChild(
        new MouseRegion(new Text("https://example.org", 0, 0), () => undefined),
    );
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: Assistant.prototype,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        expect(first.render(100).join("\n")).toContain("\u001b[1mhttps://example.org");
        second.other = first.contentContainer;
        expect(second.render(100).join("\n")).not.toContain("\u001b[1mhttps://example.org");
        expect(first.render(100).join("\n")).toContain("\u001b[1mhttps://example.org");
    } finally {
        patch.dispose();
    }
});

test("one style snapshot per frame survives child side effects, nested frames, and theme changes", () => {
    const container = new Container();
    let color = "31";
    let themeReads = 0;
    let recurse = true;
    let nested: string[] = [];
    const target = {
        contentContainer: container,
        render: (width: number) => container.render(width),
    };
    container.addChild({
        render: (width) => {
            color = "34";

            if (recurse) {
                recurse = false;
                nested = target.render(width);
            }

            return ["https://example.org/first"];
        },
        invalidate: () => undefined,
    });
    container.addChild({
        render: () => ["https://example.org/second"],
        invalidate: () => undefined,
    });
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: target,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        { urlColor: { kind: "theme", color: "mdLink" } },
        () => {
            themeReads += 1;

            return {
                fg: (_name, text) => `\u001b[${color}m${text}\u001b[39m`,
                getColorMode: () => "truecolor",
            };
        },
    );
    try {
        const outer = target.render(100);
        expect(themeReads).toBe(2); // One outer and one nested frame, not per child.
        expect(outer.every((line) => line.includes("\u001b[31m"))).toBe(true);
        expect(nested.every((line) => line.includes("\u001b[34m"))).toBe(true);
        expect(target.render(100).every((line) => line.includes("\u001b[34m"))).toBe(true);
        expect(themeReads).toBe(3);
    } finally {
        patch.dispose();
    }
});

test("assistant predecessors can replace children before the container's first layout", () => {
    const container = new Container();
    const old = new Text("old", 0, 0);
    container.addChild(old);
    let replace = true;
    const target = {
        contentContainer: container,
        render: (width: number) => {
            if (replace) {
                replace = false;
                container.clear();
                container.addChild(
                    new MouseRegion(
                        new Text("https://example.org/new src/new.ts", 0, 0),
                        () => undefined,
                    ),
                );
            }

            return container.render(width);
        },
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: target,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        const result = target.render(100).join("\n");
        expect(result).toContain("\u001b[1mhttps://example.org/new");
        expect(Object.hasOwn(old, "render")).toBe(false);
        expect(target.render(100).join("\n")).toBe(result);
    } finally {
        patch.dispose();
    }
});

for (const kind of ["thinking", "text"] as const) {
    test(`same-instance ${kind} render replacement is rediscovered and restored`, () => {
        let child: MouseRegion | Text = new Text("old", 0, 0);
        if (kind === "thinking") child = new MouseRegion(child, () => undefined);

        const container = new Container();
        container.addChild(child);
        const target = {
            contentContainer: container,
            render: (width: number) => container.render(width),
        };
        const patch = installMessageHighlightPatch(
            {
                assistantPrototype: target,
                userPrototype: { render: () => [] },
                editorPrototype: { render: () => [] },
            },
            DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
            () => ({
                fg: (_name, text) => `\u001b[35m${text}\u001b[39m`,
                getColorMode: () => "truecolor",
            }),
        );
        const replacement = (_width: number): string[] => [
            "https://example.org/replaced src/replaced.ts",
        ];
        try {
            target.render(100);
            child.render = replacement;
            const output = target.render(100);
            const joined = output.join("\n");
            if (kind === "thinking") {
                expect(joined).toContain("\u001b[1mhttps://example.org/replaced");
                expect(joined).toContain("\u001b[1msrc/replaced.ts");
            } else {
                expect(joined).toContain("\u001b[38;2;135;215;255mhttps://example.org/replaced");
                expect(joined).toContain("\u001b[35msrc/replaced.ts");
            }

            expect(child.render).not.toBe(replacement);
            const installed = child.render;
            expect(target.render(100)).toEqual(output);
            expect(child.render).toBe(installed);
        } finally {
            patch.dispose();
        }

        expect(child.render).toBe(replacement);
        expect(child.render(100)).toEqual(["https://example.org/replaced src/replaced.ts"]);
    });
}

test("opaque replacements retaining retired thinking wrappers decorate only once", () => {
    const child = new MouseRegion(
        new Text("https://example.org/original src/original.ts", 0, 0),
        () => undefined,
    );
    const container = new Container();
    container.addChild(child);
    const target = {
        contentContainer: container,
        render: (width: number) => container.render(width),
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: target,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    const transform = vi.spyOn(highlighting, "highlightMessageLines");
    let replacement;
    try {
        target.render(100);
        const retired = child.render;
        replacement = function (this: MouseRegion, width: number): string[] {
            return [...retired.call(this, width), "https://example.org/opaque src/opaque.ts"];
        };
        child.render = replacement;
        transform.mockClear();
        const output = target.render(100).join("\n");
        expect(output).toContain("\u001b[1mhttps://example.org/opaque");
        expect(output).toContain("\u001b[1msrc/opaque.ts");
        expect(transform).toHaveBeenCalledTimes(1);
    } finally {
        transform.mockRestore();
        patch.dispose();
    }

    expect(child.render).toBe(replacement);
    const plain = child.render(100).join("\n");
    expect(plain).not.toContain("\u001b[1m");
    expect(plain).not.toContain("38;2;135;215;255");
});

for (const opaque of [false, true]) {
    test(`same-instance container render replacement restores the layout boundary (opaque=${opaque})`, () => {
        const child = new MouseRegion(
            new Text("https://example.org/container src/container.ts", 0, 0),
            () => undefined,
        );
        const container = new Container();
        container.addChild(child);
        const target = {
            contentContainer: container,
            render: (width: number) => container.render(width),
        };
        const patch = installMessageHighlightPatch(
            {
                assistantPrototype: target,
                userPrototype: { render: () => [] },
                editorPrototype: { render: () => [] },
            },
            DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
            () => undefined,
        );
        let replacement;
        try {
            target.render(100);
            const retired = container.render;
            replacement = function (this: Container, width: number): string[] {
                if (opaque) return retired.call(this, width);
                return this.children.flatMap((component) => component.render(width));
            };
            container.render = replacement;
            const output = target.render(100);
            expect(output.join("\n")).toContain("\u001b[1mhttps://example.org/container");
            expect(output.join("\n")).toContain("\u001b[1msrc/container.ts");
            const installed = container.render;
            expect(installed).not.toBe(replacement);
            expect(target.render(100)).toEqual(output);
            expect(container.render).toBe(installed);
        } finally {
            patch.dispose();
        }

        expect(container.render).toBe(replacement);
        expect(container.render(100).join("\n")).not.toContain("\u001b[1m");
        expect(Object.hasOwn(child, "render")).toBe(false);
    });
}

test("captured assistant/container/mutation wrappers cannot reinstall after shutdown, even mid-frame", () => {
    const container = new Container();
    container.addChild(new Text("https://example.org/original", 0, 0));
    const target = {
        contentContainer: container,
        render: (width: number) => container.render(width),
    };
    const patch = installMessageHighlightPatch(
        {
            assistantPrototype: target,
            userPrototype: { render: () => [] },
            editorPrototype: { render: () => [] },
        },
        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
        () => undefined,
    );
    try {
        target.render(100);
        const assistantRender = target.render;
        const containerRender = container.render;
        const add = container.addChild;
        const clear = container.clear;
        const remove = container.removeChild;
        const child = new Text("https://example.org/after src/after.ts", 0, 0);
        container.render = function (this: Container, width: number): string[] {
            patch.dispose(); // Owner style stack is still active until this frame returns.
            clear.call(this);
            add.call(this, child);
            remove.call(this, child);
            add.call(this, child);

            return containerRender.call(this, width);
        };
        expect(target.render(100).join("\n")).not.toContain("38;2;135;215;255");
        expect(Object.hasOwn(child, "render")).toBe(false);
        expect(assistantRender.call(target, 100).join("\n")).not.toContain("38;2;135;215;255");

        for (const key of ["addChild", "removeChild", "clear"]) {
            expect(Object.hasOwn(container, key)).toBe(false);
        }

        expect(Object.hasOwn(child, "render")).toBe(false);
    } finally {
        patch.dispose();
    }
});

for (const foreignDisposesFirst of [false, true]) {
    test(`container foreign successor remains removable after boundary refresh (disposed first=${foreignDisposesFirst})`, () => {
        const container = new Container();
        container.addChild(
            new MouseRegion(new Text("https://example.org/foreign", 0, 0), () => undefined),
        );
        const original = container.render;
        const target = {
            contentContainer: container,
            render: (width: number) => container.render(width),
        };
        const patch = installMessageHighlightPatch(
            {
                assistantPrototype: target,
                userPrototype: { render: () => [] },
                editorPrototype: { render: () => [] },
            },
            DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
            () => undefined,
        );
        target.render(100);
        const foreign = installLinkedRenderPatch(
            container,
            (predecessor) =>
                function (width) {
                    return [...predecessor.call(this, width), "foreign-container"];
                },
        );
        try {
            const output = target.render(100);
            expect(output).toContain("foreign-container");
            expect(output.join("\n")).toContain("\u001b[1mhttps://example.org/foreign");

            if (foreignDisposesFirst) {
                foreign.dispose();
                expect(target.render(100)).not.toContain("foreign-container");
                patch.dispose();
            } else {
                patch.dispose();
                expect(container.render(100)).toContain("foreign-container");
                foreign.dispose();
            }

            expect(container.render).toBe(original);
            expect(Object.hasOwn(container, "render")).toBe(false);
        } finally {
            patch.dispose();
            foreign.dispose();
        }
    });
}
