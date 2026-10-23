import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    initTheme,
    UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    createCommandScriptFormatter,
    parseScriptFormatterCommandsValue,
    type ScriptBlockFormatter,
} from "../../../src/tools/built-in/bash/formatter.ts";
import { afterEach, describe, expect, it } from "vitest";
import { installAssistantStreaming } from "../../../src/rendering/streaming/assistant-streaming.ts";
import {
    createCodeStreamStore,
    type CodeStreamStore,
} from "../../../src/rendering/streaming/code-stream.ts";
import { configureAssistantSeparatorPatch } from "../../../src/pi/patches/assistant-separator.ts";

// Failure matrix: real host trims, display-clone invalidation, omitted streaming flags,
// final/cancel/error flush, independent components/text blocks, async code refresh,
// fence closure/unclosed final fences, token no-op, foreign patches, idempotent teardown.
const disposals: (() => void)[] = [];
const stores: CodeStreamStore[] = [];
const directories: string[] = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) dispose();
    configureAssistantSeparatorPatch(false);
    await Promise.all(stores.splice(0).map(async (store) => store.dispose()));

    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
function message(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "anthropic",
        provider: "anthropic",
        model: "test",
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
}

function text(component: AssistantMessageComponent): string {
    return component.render(100).map(stripVTControlCharacters).join("\n");
}

function externalFormatter() {
    const cache = resolve(import.meta.dirname, "../../../../../.cache");
    mkdirSync(cache, { recursive: true });
    const directory = mkdtempSync(join(cache, "glowup-assistant-"));
    directories.push(directory);
    const log = join(directory, "inputs.jsonl");
    const program = join(directory, "format.cjs");
    writeFileSync(
        program,
        `const fs=require('node:fs');const code=fs.readFileSync(0,'utf8');const config=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8'));fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({code,width:config.printWidth})+'\\n');import(${JSON.stringify(import.meta.resolve("oxfmt"))}).then(async ({format})=>{const result=await format('unit.js',code,config);if(result.errors.length)process.exit(1);process.stdout.write(result.code);});`,
    );
    const formatter = createCommandScriptFormatter(
        parseScriptFormatterCommandsValue({
            javascript: { kind: "javascript", command: [process.execPath, program] },
        }),
    );
    if (formatter === undefined) throw new Error("formatter configuration rejected");
    return { formatter, journal: () => readFileSync(log, "utf8") };
}

async function install(
    prose: "token" | "sentence" | "paragraph",
    code: "token" | "statement" | "block",
    formatter?: ScriptBlockFormatter,
    onReady?: () => void,
) {
    initTheme("dark");
    const streams = createCodeStreamStore();
    stores.push(streams);
    const events: string[] = [];
    const handle = await installAssistantStreaming({
        prose,
        code,
        streams,
        formatter,
        invalidate: () => {
            events.push("ready");
            onReady?.();
        },
    });
    disposals.push(() => handle.dispose());

    return { streams, events, handle };
}

describe("assistant structured streaming", () => {
    it("leaves ordinary rendering intact when activation cannot patch the renderer", async () => {
        initTheme("dark");
        const prototype = AssistantMessageComponent.prototype;
        const render = Object.getOwnPropertyDescriptor(prototype, "render");
        const update = Object.getOwnPropertyDescriptor(prototype, "updateContent");
        if (render === undefined || update === undefined)
            throw new Error("Host component methods are unavailable");

        const streams = createCodeStreamStore();
        stores.push(streams);
        try {
            Object.defineProperty(prototype, "render", { ...render, writable: false });
            await expect(
                installAssistantStreaming({
                    prose: "paragraph",
                    code: "token",
                    streams,
                    invalidate: () => {},
                }),
            ).rejects.toThrow(TypeError);
            const component = new AssistantMessageComponent();
            component.updateContent(message("Available unfinished text"), true);
            expect(text(component)).toContain("Available unfinished text");
        } finally {
            Object.defineProperty(prototype, "render", render);
            Object.defineProperty(prototype, "updateContent", update);
        }
    });

    it("holds raw whitespace before Pi trim and survives display-clone invalidation", async () => {
        await install("paragraph", "token");
        const component = new AssistantMessageComponent();
        const raw = message("First\n\nTail");
        Object.freeze(raw.content[0]);
        Object.freeze(raw.content);
        Object.freeze(raw);
        component.updateContent(raw, true);
        expect(text(component)).toContain("First");
        expect(text(component)).not.toContain("Tail");
        component.invalidate();
        component.setOutputPad(2);
        expect(text(component)).not.toContain("Tail");
        component.updateContent(message("First\n\nTail\n\n"));
        expect(text(component)).toContain("Tail");
        expect(raw.content).toEqual([{ type: "text", text: "First\n\nTail" }]);
    });

    it("isolates components and blocks and leaves thinking/user components untouched", async () => {
        const userMethod: unknown = Object.getOwnPropertyDescriptor(
            UserMessageComponent.prototype,
            "render",
        )?.value;
        await install("sentence", "token");
        const a = new AssistantMessageComponent();
        const b = new AssistantMessageComponent();
        const raw = message("Done. pending");
        raw.content.push(
            { type: "thinking", thinking: "Visible thinking tail" },
            { type: "text", text: "Separate tail" },
        );

        a.updateContent(raw, true);
        b.updateContent(message("Other. hidden"), true);
        expect(text(a)).toContain("Done.");
        expect(text(a)).toContain("Visible thinking tail");
        expect(text(a)).not.toContain("Separate tail");
        expect(text(b)).not.toContain("hidden");
        expect(
            Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, "render")?.value,
        ).toBe(userMethod);

        a.updateContent(raw, false);
        expect(text(a)).toContain("Separate tail");
        expect(text(b)).not.toContain("hidden");
    });

    it.each(["aborted", "error", "length"] as const)(
        "flushes %s even if host streaming flag remains true",
        async (stopReason) => {
            await install("sentence", "token");
            const component = new AssistantMessageComponent();
            component.updateContent({ ...message("Unfinished tail"), stopReason }, true);
            expect(text(component)).toContain("Unfinished tail");
        },
    );

    it("coalesces completed statement readiness into the next real component paint", async () => {
        const { streams, events } = await install("token", "statement");
        const component = new AssistantMessageComponent();
        component.updateContent(message(""), true);
        component.render(100);
        const raw = message("Intro\n\n```js\nconst first=1;\nconst second=2;\nconst unfinished =");
        component.updateContent(raw, true);
        component.render(100);
        const content = component.children[0];
        if (!(content instanceof Container))
            throw new Error("Host content container is unavailable");

        const beforeReady = [...content.children];
        await streams.settled();

        expect(events.length).toBeGreaterThan(1);
        expect(content.children).toEqual(beforeReady);
        const painted = text(component);
        expect(painted).toContain("const first=1;");
        expect(painted).toContain("const second=2;");
        expect(painted).not.toContain("unfinished");
        expect(content.children).not.toEqual(beforeReady);
        expect(raw.content).toEqual([
            {
                type: "text",
                text: "Intro\n\n```js\nconst first=1;\nconst second=2;\nconst unfinished =",
            },
        ]);
    });

    it("refreshes asynchronously ready fenced code without another provider token", async () => {
        const { streams, events } = await install("paragraph", "statement");
        const component = new AssistantMessageComponent();
        const raw = message("Intro\n\n```js\nconst first=1;\nconst unfinished =");
        component.updateContent(raw, true);
        await streams.settled();
        expect(text(component)).toContain("const first=1;");
        expect(text(component)).not.toContain("unfinished");
        expect(events.length).toBeGreaterThan(0);
        component.invalidate();
        await streams.settled();
        expect(text(component)).not.toContain("unfinished");
        expect(raw.content[0]).toEqual({
            type: "text",
            text: "Intro\n\n```js\nconst first=1;\nconst unfinished =",
        });

        component.updateContent(raw, false);
        await streams.settled();
        expect(text(component)).toContain("unfinished");
    });

    it.each([
        {
            name: "quoted JavaScript",
            source: "> ```js\n> const first=1;\n> const unfinished =",
            visible: "const first=1;",
        },
        {
            name: "list-nested JavaScript",
            source: "- Example\n\n  ```js\n  const first=1;\n  const unfinished =",
            visible: "const first=1;",
        },
        {
            name: "quoted list-nested Python",
            source: "> - ```python\n>   if True:\n>       print(1)\n>       unfinished =",
            visible: "print(1)",
        },
        {
            name: "list-nested quoted Python",
            source: "- > ```python\n  > if True:\n  >     print(1)\n  >     unfinished =",
            visible: "print(1)",
        },
        {
            name: "four-container Python",
            source: "> 1. - > ```python\n>      > if True:\n>      >     print(1)\n>      >     unfinished =",
            visible: "print(1)",
        },
        {
            name: "quoted CRLF JavaScript",
            source: "> ```js\r\n> const first=1;\r\n> const unfinished =",
            visible: "const first=1;",
        },
        {
            name: "quoted CR JavaScript",
            source: "> ```js\r> const first=1;\r> const unfinished =",
            visible: "const first=1;",
        },
    ])(
        "progressively reveals $name fences without leaking incomplete tails",
        async ({ source, visible }) => {
            const { streams } = await install("token", "statement");
            const component = new AssistantMessageComponent();
            const raw = message(source);
            component.updateContent(raw, true);
            component.render(100);
            await streams.settled();

            expect(text(component)).toContain(visible);
            expect(text(component)).not.toContain("unfinished");
            expect(raw.content).toEqual([{ type: "text", text: source }]);

            component.updateContent(raw, false);
            await streams.settled();
            expect(text(component)).toContain("unfinished");
        },
    );

    it.each([
        "> - ~~~~python\n>   if True:\n>       print(1)\n>   ~~~~~\n>\n> After",
        "1. Example\r\n\r\n   ```python\r\n   if True:\r\n       print(1)\r\n   ```\r\n\r\nAfter",
        '-\t```js\n\tconst first="a\\tb";\n\t```\n\nAfter',
        "> > ```js\n> > const first=1;\n> > ``",
        "> ```js\r> const first=1;\r> ```\r\rAfter",
    ])("retains final unformatted Markdown semantics for %j", async (source) => {
        initTheme("dark");
        const baseline = new AssistantMessageComponent();
        baseline.updateContent(message(source), false);
        const expected = text(baseline);
        const { streams } = await install("paragraph", "statement");
        const component = new AssistantMessageComponent();
        component.updateContent(message(source), false);
        component.render(100);
        await streams.settled();

        expect(text(component)).toBe(expected);
    });

    it("formats nested quoted-list statements without container markup and holds later prose", async () => {
        const external = externalFormatter();
        const snapshots: string[] = [];
        const { streams } = await install("token", "statement", external.formatter, () => {
            snapshots.push(text(component));
        });
        const component = new AssistantMessageComponent();
        component.setOutputPad(2);
        component.updateContent(message(""), true);
        component.render(100);
        const raw = message(
            "> - ```js\n>   const first={value:1};\n>   const second={value:2};\n>   ```\n\nFOLLOWING_PROSE",
        );
        component.updateContent(raw, true);
        component.render(100);
        await streams.settled();

        const intermediate = snapshots.filter(
            (snapshot) =>
                snapshot.includes("const first = { value: 1 };") &&
                !snapshot.includes("const second = { value: 2 };"),
        );
        expect(intermediate.length).toBeGreaterThan(0);

        for (const snapshot of intermediate) expect(snapshot).not.toContain("FOLLOWING_PROSE");
        expect(text(component)).toContain("│");
        expect(text(component)).toContain("const second = { value: 2 };");
        expect(text(component)).toContain("FOLLOWING_PROSE");
        expect(external.journal()).toContain('"code":"const first={value:1};"');
        expect(external.journal()).toContain('"code":"const second={value:2};"');
        expect(external.journal()).toContain('"width":90');
        expect(external.journal()).not.toContain("> ");
        expect(external.journal()).not.toContain("const first={value:1};\\nconst second");
    });

    it("preserves ordered-list Python indentation and flushes an unfinished nested tail on error", async () => {
        const { streams } = await install("paragraph", "statement");
        const component = new AssistantMessageComponent();
        const prefix =
            "1. Example\n\n   ```python\n   if True:\n       print(1)\n       unfinished =";
        const raw = message(prefix);
        component.updateContent(raw, true);
        component.render(100);
        await streams.settled();

        expect(text(component)).toContain("1.");
        expect(text(component)).toContain("if True:");
        expect(text(component)).toContain("print(1)");
        expect(text(component)).not.toContain("unfinished");
        component.updateContent({ ...raw, stopReason: "error" }, true);
        await streams.settled();
        expect(text(component)).toContain("unfinished =");
        expect(raw.content).toEqual([{ type: "text", text: prefix }]);
    });

    it("keeps incomplete nested opening and closing fences out of prose", async () => {
        const { streams } = await install("sentence", "statement");
        const component = new AssistantMessageComponent();
        component.updateContent(message("> - ```javascript"), true);
        await streams.settled();
        expect(text(component)).not.toContain("javascript");

        component.updateContent(message("> - ```javascript\n>   const first=1;\n>   ``"));
        await streams.settled();
        expect(text(component)).toContain("const first=1;");
        expect(text(component)).not.toMatch(/^\s*│\s+``\s*$/mu);

        component.updateContent(
            message("> - ```javascript\n>   const first=1;\n>   ```\n\nDone. pending"),
        );
        await streams.settled();
        expect(text(component)).toContain("Done.");
        expect(text(component)).not.toContain("pending");
    });

    it("isolates identical nested blocks and respects implicit container closure", async () => {
        const { streams } = await install("token", "statement");
        const component = new AssistantMessageComponent();
        component.updateContent(
            message(
                "- Example\n\n  ```js\n  const first=1;\n  ```\n\n  ```js\n  const first=1;\n  ```\n\n> ```js\n> const unfinished =\n\nOUTSIDE_CONTAINER",
            ),
            true,
        );
        component.render(100);
        await streams.settled();
        const rendered = text(component);
        expect(rendered.match(/const first=1;/gu)).toHaveLength(2);
        expect(rendered).toContain("const unfinished =");
        expect(rendered).toContain("OUTSIDE_CONTAINER");
    });

    it("closes each fence independently and isolates same-language blocks", async () => {
        const { streams } = await install("token", "block");
        const component = new AssistantMessageComponent();
        component.updateContent(
            message("```js\nlet one=1;\n```\n```js\nlet two=2;\n```\nTail"),
            true,
        );
        component.render(100);
        await streams.settled();
        expect(text(component)).toContain("let one=1;");
        expect(text(component)).toContain("let two=2;");
        expect(text(component)).toContain("Tail");
    });

    it("reformats independent statements at the actual padded render width", async () => {
        const external = externalFormatter();
        const { streams } = await install("token", "statement", external.formatter);
        const component = new AssistantMessageComponent();
        component.setOutputPad(3);
        component.updateContent(message("```js\nconst lists=[1000,2000,3000];\n```"), true);
        component.render(40);
        await streams.settled();
        const narrow = component
            .render(40)
            .map((row) => stripVTControlCharacters(row).trimEnd())
            .join("\n");
        component.render(100);
        await streams.settled();
        const wide = component.render(100).map(stripVTControlCharacters).join("\n");
        expect(narrow).toMatch(/const lists = \[$/mu);
        expect(wide).toContain("const lists = [1000, 2000, 3000];");
        expect(narrow.split("\n").length).toBeGreaterThan(wide.split("\n").length);
    });

    it("does not reveal a closing fence or following prose ahead of pending statements", async () => {
        const external = externalFormatter();
        const snapshots: string[] = [];
        const { streams } = await install("token", "statement", external.formatter, () => {
            snapshots.push(text(component));
        });
        const component = new AssistantMessageComponent();
        component.updateContent(
            message("```js\nconst first=1;\nconst second=2;\n```\nFOLLOWING_PROSE"),
            true,
        );
        await streams.settled();
        const intermediate = snapshots.filter(
            (snapshot) =>
                snapshot.includes("const first = 1;") && !snapshot.includes("const second = 2;"),
        );
        expect(intermediate.length).toBeGreaterThan(0);

        for (const snapshot of intermediate) expect(snapshot).not.toContain("FOLLOWING_PROSE");
        expect(text(component)).toContain("FOLLOWING_PROSE");
        const inputs = external.journal();
        expect(inputs).toContain('"code":"const first=1;"');
        expect(inputs).toContain('"code":"const second=2;"');
        expect(inputs).not.toContain("const first=1;\\nconst second");
    });

    it("keeps a trailing paragraph heading attached to the first ready code statement", async () => {
        const { streams } = await install("paragraph", "statement");
        const component = new AssistantMessageComponent();
        const prefix = "Earlier paragraph\n\n# Attached heading\n\n```js\n";
        component.updateContent(message(prefix), true);
        component.render(100);
        await streams.settled();
        expect(text(component)).toContain("Earlier paragraph");
        expect(text(component)).not.toContain("Attached heading");
        component.updateContent(message(prefix + "const unfinished ="));
        await streams.settled();
        expect(text(component)).not.toContain("Attached heading");
        component.updateContent(message(prefix + "const first=1;\nconst unfinished ="));
        await streams.settled();
        expect(text(component)).toContain("Attached heading");
        expect(text(component)).toContain("const first=1;");
        expect(text(component)).not.toContain("unfinished");
    });

    it("starts fresh code state when a finalized component is reused for streaming", async () => {
        const { streams } = await install("token", "statement");
        const component = new AssistantMessageComponent();
        const raw = message("```js\nconst first=1;\nconst speculative =");
        component.updateContent(raw, false);
        await streams.settled();
        expect(text(component)).toContain("speculative");
        component.updateContent(raw, true);
        expect(text(component)).not.toContain("speculative");
        await streams.settled();
        expect(text(component)).not.toContain("speculative");
    });

    it("is transparent by default and composes with assistant separator teardown", async () => {
        const original: unknown = Object.getOwnPropertyDescriptor(
            AssistantMessageComponent.prototype,
            "updateContent",
        )?.value;
        const { handle } = await install("token", "token");
        expect(
            Object.getOwnPropertyDescriptor(AssistantMessageComponent.prototype, "updateContent")
                ?.value,
        ).toBe(original);

        handle.dispose();
        const installed = await install("sentence", "token");
        configureAssistantSeparatorPatch(true);
        const component = new AssistantMessageComponent();
        component.updateContent(message("Visible. hidden"), true);
        expect(text(component)).not.toContain("hidden");
        installed.handle.dispose();
        installed.handle.dispose();
        component.updateContent(message("Visible. revealed"), true);
        expect(text(component)).toContain("revealed");
        configureAssistantSeparatorPatch(false);
    });
});
