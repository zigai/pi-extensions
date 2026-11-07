import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Markdown, stripTerminalSequences, type MarkdownTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { test } from "vitest";
import {
    createHeadingGroup,
    foldableMarkdown,
    installHeadingRendering,
    prepareHeadingGroup,
    resetHeadingFolds,
} from "../src/heading-rendering.ts";
import { markFencesHidden } from "../src/markdown-rendering.ts";

const identity = (text: string): string => text;
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

const cacheSchema = Type.Object({ tokens: Type.Array(Type.Unknown()) });

function tokenCache(markdown: Markdown) {
    const ref: unknown = Object.getOwnPropertyDescriptor(markdown, "cachedTokens")?.value;
    assert.ok(ref instanceof WeakRef);
    const cache: unknown = ref.deref();
    if (!Value.Check(cacheSchema, cache)) assert.fail("unsupported SDK token cache");
    return cache;
}

test("scans actual SDK top-level tokens only linearly per heading render", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        const markdown = new Markdown(
            Array.from({ length: 24 }, (_, i) => `### Heading ${i}\n\nParagraph ${i}.`).join(
                "\n\n",
            ),
            0,
            0,
            theme,
        );
        markFencesHidden(markdown);
        markdown.render(80);
        const cache = tokenCache(markdown);
        let reads = 0;

        for (let i = 0; i < cache.tokens.length; i++) {
            const token = cache.tokens[i];
            Object.defineProperty(cache.tokens, i, {
                configurable: true,
                get() {
                    reads += 1;
                    return token;
                },
            });
        }

        for (const width of [79, 40, 81]) {
            reads = 0;
            markdown.invalidate();
            markdown.render(width);
            assert.ok(
                reads <= cache.tokens.length * 8,
                `${reads} token reads for ${cache.tokens.length} tokens at width ${width}`,
            );
        }
    } finally {
        handle.dispose();
    }
});

test("reindexes in-place SDK token edits between renders without caching the theme", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        const mutableTheme = { ...theme, bold: (text: string) => `<bold>${text}</bold>` };
        const markdown = new Markdown("### Top\n\n#### Child\n\n##### Deep", 0, 0, mutableTheme);
        markFencesHidden(markdown);
        const first = markdown.render(80).map(stripTerminalSequences).join("\n");
        assert.ok(first.includes("<bold>Top</bold>"));
        assert.ok(first.includes("Child"));
        assert.ok(!first.includes("<bold>Child</bold>"));
        assert.ok(first.includes("<bold>##### </bold>"));
        const cache = tokenCache(markdown);
        const heading = cache.tokens.find((token) =>
            Value.Check(
                Type.Object({ type: Type.Literal("heading"), text: Type.Literal("Top") }),
                token,
            ),
        );
        assert.ok(heading !== undefined);
        Reflect.set(heading, "depth", 6);
        mutableTheme.bold = (text) => `<changed>${text}</changed>`;
        markdown.invalidate();
        const edited = markdown.render(120).map(stripTerminalSequences).join("\n");
        assert.ok(edited.includes("<changed>###### </changed>"));
        assert.ok(edited.includes("<changed>Child</changed>"));
        assert.ok(!edited.includes("<changed>##### </changed>"));
        markdown.setText("## Rewritten\n\n### New child");
        const rewritten = markdown.render(80).map(stripTerminalSequences).join("\n");
        assert.ok(rewritten.includes("<changed>Rewritten</changed>"));
        assert.ok(!rewritten.includes("<changed>New child</changed>"));
        assert.ok(!rewritten.includes("Top"));
    } finally {
        handle.dispose();
    }
});

test("leaves nested headings and unsupported token caches to the predecessor", () => {
    const source = "> ### Quoted\n\n- #### Listed";
    const markdown = new Markdown(source, 0, 0, theme);
    const native = markdown.render(80);
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        markFencesHidden(markdown);
        markdown.invalidate();
        assert.deepEqual(markdown.render(80), native);

        // The SDK accepts this cache, but it is not the WeakRef contract our patch supports.
        const unsupported = new Markdown("### Native", 0, 0, theme);
        const expected = unsupported.render(80);
        const cache = tokenCache(unsupported);
        Object.defineProperty(unsupported, "cachedTokens", { value: { deref: () => cache } });
        markFencesHidden(unsupported);
        unsupported.invalidate();
        assert.deepEqual(unsupported.render(80), expected);
    } finally {
        handle.dispose();
    }
});

test("restores render scopes after errors and cooperates with later render patches on disposal", () => {
    const original = Object.getOwnPropertyDescriptor(Markdown.prototype, "render");
    const handle = installHeadingRendering();
    assert.ok(handle);
    let calls = 0;
    const foreign = installLinkedMethodPatch(
        Markdown.prototype,
        "render",
        (predecessor) =>
            function (this: Markdown, width) {
                calls += 1;
                return predecessor.call(this, width);
            },
    );
    try {
        const mutableTheme = {
            ...theme,
            bold(_text: string): string {
                throw new Error("foreign theme failure");
            },
        };
        const markdown = new Markdown("### First\n\n#### Second", 0, 0, mutableTheme);
        markFencesHidden(markdown);
        assert.throws(() => markdown.render(80), /foreign theme failure/);
        mutableTheme.bold = identity;
        markdown.setText("#### Replacement\n\n##### Child");
        assert.ok(
            markdown.render(80).map(stripTerminalSequences).join("\n").includes("Replacement"),
        );

        handle.dispose();
        markdown.invalidate();
        const after = markdown.render(80);
        assert.deepEqual(
            after,
            new Markdown("#### Replacement\n\n##### Child", 0, 0, theme).render(80),
        );
        assert.ok(calls >= 4);
    } finally {
        handle.dispose();
        foreign.dispose();
    }

    assert.deepEqual(Object.getOwnPropertyDescriptor(Markdown.prototype, "render"), original);
});

test("does not retain the SDK weak token tree after rendering while the Markdown stays live", () => {
    const headingModule = new URL("../src/heading-rendering.ts", import.meta.url).href;
    const markdownModule = new URL("../src/markdown-rendering.ts", import.meta.url).href;
    const child = spawnSync(
        process.execPath,
        [
            "--expose-gc",
            "--input-type=module",
            "-e",
            `
            import assert from 'node:assert/strict';
            import { Markdown } from '@earendil-works/pi-tui';
            const { installHeadingRendering } = await import(${JSON.stringify(headingModule)});
            const { markFencesHidden } = await import(${JSON.stringify(markdownModule)});
            const identity = text => text;
            const theme = Object.fromEntries(${JSON.stringify(Object.keys(theme))}.map(key => [key, identity]));
            const handle = installHeadingRendering();
            const markdown = new Markdown('### Top\\n\\n#### Child', 0, 0, theme);
            markFencesHidden(markdown);
            markdown.render(80);
            const cache = markdown.cachedTokens;
            const tokens = new WeakRef(cache.deref().tokens);
            // Marked's shared tokenizer retains its most recent lexer. Move it to
            // another source so this check measures only our render metadata.
            new Markdown('Unrelated lexer source.', 0, 0, theme).render(80);
            // Cross a job boundary before forcing GC: deref protects its target for this job.
            await new Promise(resolve => setImmediate(resolve));
            global.gc();
            assert.equal(cache.deref(), undefined, 'token cache retained');
            assert.equal(tokens.deref(), undefined, 'token array retained');
            markdown.invalidate();
            assert.ok(markdown.render(40).join('\\n').includes('Child'));
            handle.dispose();
        `,
        ],
        { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
});

test("restores the outer heading scope after a guarded same-instance SDK render", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        const source = "### Top\n\n#### Child\n\n##### Deep";
        const styledTheme = { ...theme, bold: (text: string) => `<bold>${text}</bold>` };
        const control = new Markdown(source, 0, 0, styledTheme);
        markFencesHidden(control);
        const expectedOuter = control.render(80);
        control.invalidate();
        const expectedInner = control.render(40);

        let entered = false;
        let nested: string[] | undefined;
        const markdown = new Markdown(source, 0, 0, {
            ...styledTheme,
            bold(text) {
                if (!entered) {
                    entered = true;
                    nested = markdown.render(40);
                }

                return styledTheme.bold(text);
            },
        });
        markFencesHidden(markdown);
        assert.deepEqual(markdown.render(80), expectedOuter);
        assert.equal(entered, true, "theme must invoke a real nested SDK render");
        assert.deepEqual(nested, expectedInner);
        markdown.invalidate();
        assert.deepEqual(markdown.render(40), expectedInner);
        markdown.invalidate();
        assert.deepEqual(markdown.render(80), expectedOuter);
    } finally {
        handle.dispose();
    }
});

for (const disposalOrder of ["oldest first", "newest first"]) {
    test(`heading owners dispose ${disposalOrder} without removing a foreign render patch`, () => {
        const originalRender = Object.getOwnPropertyDescriptor(Markdown.prototype, "render");
        const originalToken = Object.getOwnPropertyDescriptor(Markdown.prototype, "renderToken");
        const source = "### Top\n\n#### Child\n\n##### Deep";
        const styledTheme = { ...theme, bold: (text: string) => `<bold>${text}</bold>` };
        const markdown = new Markdown(source, 0, 0, styledTheme);
        const native = markdown.render(80);
        const first = installHeadingRendering();
        assert.ok(first);
        try {
            markFencesHidden(markdown);
            markdown.invalidate();
            const oneOwner = markdown.render(80);
            assert.notDeepEqual(oneOwner, native);
            const second = installHeadingRendering();
            assert.ok(second);
            try {
                let foreignCalls = 0;
                const foreign = installLinkedMethodPatch(
                    Markdown.prototype,
                    "render",
                    (predecessor) =>
                        function (this: Markdown, width) {
                            foreignCalls += 1;
                            return predecessor.call(this, width);
                        },
                );
                const foreignRender = Object.getOwnPropertyDescriptor(Markdown.prototype, "render");
                try {
                    markdown.invalidate();

                    // Multiple active owners historically compose styling; do not
                    // prescribe a new visual policy for that intermediate state.
                    markdown.render(80);

                    if (disposalOrder === "oldest first") first.dispose();
                    else second.dispose();

                    assert.deepEqual(
                        Object.getOwnPropertyDescriptor(Markdown.prototype, "render"),
                        foreignRender,
                    );

                    markdown.invalidate();
                    assert.deepEqual(markdown.render(80), oneOwner);

                    if (disposalOrder === "oldest first") second.dispose();
                    else first.dispose();

                    assert.deepEqual(
                        Object.getOwnPropertyDescriptor(Markdown.prototype, "render"),
                        foreignRender,
                    );
                    assert.deepEqual(
                        Object.getOwnPropertyDescriptor(Markdown.prototype, "renderToken"),
                        originalToken,
                    );

                    markdown.invalidate();
                    assert.deepEqual(markdown.render(80), native);
                    assert.equal(foreignCalls, 3);
                } finally {
                    foreign.dispose();
                }
            } finally {
                second.dispose();
            }
        } finally {
            first.dispose();
        }

        assert.deepEqual(
            Object.getOwnPropertyDescriptor(Markdown.prototype, "render"),
            originalRender,
        );
        assert.deepEqual(
            Object.getOwnPropertyDescriptor(Markdown.prototype, "renderToken"),
            originalToken,
        );
    });
}

test("reuses heading preparation output when ranks and fold indicators do not change", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        let styled = 0;
        let tag = "first";
        const mutableTheme = {
            ...theme,
            bold(text: string) {
                styled++;
                return `<${tag}>${text}</${tag}>`;
            },
        };
        const markdown = new Markdown("### Top\n\n#### Child\n\n##### Deep", 0, 0, mutableTheme);
        markFencesHidden(markdown);
        const group = createHeadingGroup(new Map(), {});
        const child = foldableMarkdown(markdown, new Set(), group);
        for (const width of [80, 40, 90]) {
            prepareHeadingGroup(group, width);
            const prepared = styled;
            assert.ok(prepared > 0);
            resetHeadingFolds(group);
            assert.ok(child.render(width).join("\n").includes("Top"));
            assert.equal(styled, prepared, "presentation must reuse the prepared SDK lines");
        }

        tag = "changed";
        child.invalidate();
        resetHeadingFolds(group);
        assert.ok(child.render(90).join("\n").includes("<changed>"));
    } finally {
        handle.dispose();
    }
});

test("invalidates only children whose global heading ranks change during discovery", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        const group = createHeadingGroup(new Map(), {});
        const first = new Markdown("#### Deep", 0, 0, {
            ...theme,
            bold: (text) => `<b>${text}</b>`,
        });
        const second = new Markdown("## Shallow", 0, 0, {
            ...theme,
            bold: (text) => `<b>${text}</b>`,
        });
        for (const markdown of [first, second]) markFencesHidden(markdown);
        const a = foldableMarkdown(first, new Set(), group);
        const b = foldableMarkdown(second, new Set(), group);
        prepareHeadingGroup(group, 80);
        assert.ok(!a.render(80).join("\n").includes("<b>Deep</b>"));
        assert.ok(b.render(80).join("\n").includes("<b>Shallow</b>"));
    } finally {
        handle.dispose();
    }
});

test("retries preparation after a child render throws", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    try {
        let fail = true;
        const markdown = new Markdown("### Top", 0, 0, {
            ...theme,
            bold(text) {
                if (fail) throw new Error("preparation failed");
                return text;
            },
        });
        markFencesHidden(markdown);
        const group = createHeadingGroup(new Map(), {});
        const child = foldableMarkdown(markdown, new Set(), group);
        assert.throws(() => prepareHeadingGroup(group, 80), /preparation failed/);
        fail = false;
        prepareHeadingGroup(group, 80);
        assert.ok(child.render(80).join("\n").includes("Top"));
    } finally {
        handle.dispose();
    }
});

test("keeps the same-width preparation guard during foreign render reentrancy", () => {
    const handle = installHeadingRendering();
    assert.ok(handle);
    const markdown = new Markdown("### Top\n\n#### Child", 0, 0, theme);
    markFencesHidden(markdown);
    const group = createHeadingGroup(new Map(), {});
    const child = foldableMarkdown(markdown, new Set(), group);
    let attempts = 0;
    const foreign = installLinkedMethodPatch(
        markdown,
        "render",
        (render) =>
            function (this: Markdown, width) {
                attempts++;
                if (attempts > 5) throw new Error("preparation reentered");

                prepareHeadingGroup(group, width);

                return render.call(this, width);
            },
    );
    try {
        prepareHeadingGroup(group, 80);
        assert.ok(child.render(80).join("\n").includes("Top"));
        assert.equal(attempts, 2);
    } finally {
        foreign.dispose();
        handle.dispose();
    }
});
