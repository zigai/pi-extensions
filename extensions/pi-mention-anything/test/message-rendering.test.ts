import assert from "node:assert/strict";
import { test } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { colorUserMessageLines } from "../src/message-rendering.ts";

const sources = [
    { id: "ticket", trigger: "ticket:", separator: "/" },
    { id: "teams", trigger: "%", separator: ":" },
];
const color = "\x1b[35m";

test("colors dynamically registered syntax, quoted segments and wrapped content without altering text", () => {
    const text = 'See ticket:"big issue"/123 and %team:prod.';
    const lines = ['  See ticket:"big', '  issue"/123 and %team:prod.'];
    const result = colorUserMessageLines(text, lines, sources, color);
    assert.deepEqual(result.map(stripTerminalSequences), lines);
    assert.match(result[0], /\x1b\[35mticket:"big/);
    assert.match(result[1], /\x1b\[35missue"\/123/);
    assert.match(result[1], /\x1b\[35m%team:prod/);
    assert.doesNotMatch(colorUserMessageLines(text, lines, [], color).join(""), /\x1b\[35m/);
});

test("preserves and restores existing colors, handles incomplete mentions and trigger boundaries", () => {
    const text = 'abc%no %ok %"unfinished';
    const line = `\x1b[32m${text}\x1b[0m`;
    const [result] = colorUserMessageLines(text, [line], sources, color);
    assert.equal(stripTerminalSequences(result), text);
    assert.match(result, /abc%no \x1b\[35m%ok\x1b\[32m/);
    assert.doesNotMatch(result, /\x1b\[35m%"unfinished/);
});

test("patch colors a real user component and observes source changes", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const current = [{ id: "team", trigger: "%" }];
    const patch = installUserMentionRendering(current, () => color);
    try {
        const user = new UserMessageComponent("see %team https://example.com", undefined, 1);
        assert.match(user.render(80).join(""), /\x1b\[35m%team/);
        current.splice(0);
        assert.doesNotMatch(user.render(80).join(""), /\x1b\[35m%team/);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("does not align a later repeated line after an unmatched earlier line", () => {
    const text = "unmatched %first\nrepeated %second";
    const lines = ["different", "repeated %second"];
    assert.deepEqual(
        colorUserMessageLines(text, lines, [{ id: "team", trigger: "%" }], color),
        lines,
    );
});

test("aligns Text-rendered tabs and refuses truncated renders", () => {
    const source = "prefix\t%alpha\t%beta";
    const lines = [" prefix   %alpha   %beta "];
    const definitions = [{ id: "team", trigger: "%" }];
    const rendered = colorUserMessageLines(source, lines, definitions, color);
    assert.equal(stripTerminalSequences(rendered[0]), lines[0]);
    assert.match(rendered[0], /\x1b\[35m%alpha/);
    assert.match(rendered[0], /\x1b\[35m%beta/);
    const truncated = [" prefix   %alpha "];
    assert.deepEqual(colorUserMessageLines(source, truncated, definitions, color), truncated);
});

test("web URL ranges take precedence over overlapping custom mentions", () => {
    const text = "visit https://example.com/docs now";
    const line = `visit \u001b[38;2;135;215;255mhttps://example.com/docs\u001b[39m now`;
    assert.deepEqual(
        colorUserMessageLines(text, [line], [{ id: "web", trigger: "https:" }], color),
        [line],
    );
});

test("colors visible Markdown mentions without coloring hidden link destinations", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const text = "**hello** %team and [link](https://example.test/%hidden) then *%other*";
    const user = new UserMessageComponent(text, undefined, 1);
    const before = user.render(80).map(stripTerminalSequences);
    const patch = installUserMentionRendering([{ id: "team", trigger: "%" }], () => color);
    try {
        const after = user.render(80);
        assert.deepEqual(after.map(stripTerminalSequences), before);
        assert.match(after.join(""), /\x1b\[35m%team/);
        assert.match(after.join(""), /\x1b\[35m%other/);
        assert.doesNotMatch(after.join(""), /\x1b\[35m%hidden/);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("colors a Markdown mention across real wrapped lines", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const user = new UserMessageComponent(
        '**hello** ticket:"a long multi word value"',
        undefined,
        1,
    );
    const before = user.render(20).map(stripTerminalSequences);
    const patch = installUserMentionRendering(sources, () => color);
    try {
        const after = user.render(20);
        assert.deepEqual(after.map(stripTerminalSequences), before);
        assert.ok(after.filter((line) => line.includes(color)).length >= 2);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("does not confuse hidden destinations with repeated visible mentions", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const user = new UserMessageComponent("**hi** [link](%team) %team", undefined, 1);
    const before = user.render(50).map(stripTerminalSequences);
    const patch = installUserMentionRendering([{ id: "team", trigger: "%" }], () => color);
    try {
        const lines = user.render(50);
        assert.deepEqual(lines.map(stripTerminalSequences), before);
        assert.equal(lines.join("").split(`${color}%team`).length - 1, 1);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("leaves output unchanged when the marker probe changes the rendered text", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const user = new UserMessageComponent("**hi** %team", undefined, 1, [
        (text) => {
            if (text.includes("pi-mention-")) return "different";
            return text;
        },
    ]);
    const before = user.render(50);
    const patch = installUserMentionRendering([{ id: "team", trigger: "%" }], () => color);
    try {
        assert.deepEqual(user.render(50), before);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("colors all visible mentions when a hidden destination requires separate probes", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const user = new UserMessageComponent(
        "**hi** [link](%hidden) %a %b %c %d %e %f %g %h %i",
        undefined,
        1,
    );
    const before = user.render(100).map(stripTerminalSequences);
    const patch = installUserMentionRendering([{ id: "team", trigger: "%" }], () => color);
    try {
        const lines = user.render(100);
        assert.deepEqual(lines.map(stripTerminalSequences), before);
        assert.equal(lines.join("").split(color).length - 1, 9);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("fails visibly if Pi changes the private Markdown render configuration", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    const user = new UserMessageComponent("**hi** %team", undefined, 1);
    Reflect.deleteProperty(user, "outputPad");
    const patch = installUserMentionRendering([{ id: "team", trigger: "%" }], () => color);
    try {
        assert.throws(() => user.render(50), /Pi.*Markdown/);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("batches hidden destinations and caches the probe across repaints", async () => {
    const { UserMessageComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    let calls = 0;
    const transformer = (text: string): string => {
        calls++;
        return text;
    };
    const user = new UserMessageComponent(
        "**hi** [link](%hidden) %a %b %c %d %e %f %g %h %i %j %k %l %m %n %o %p",
        undefined,
        1,
        [transformer],
    );
    const patch = installUserMentionRendering([{ id: "team", trigger: "%" }], () => color);
    try {
        const first = user.render(120);
        const firstCalls = calls;
        assert.equal(first.join("").split(color).length - 1, 16);
        assert.ok(firstCalls <= 12, `expected batched probes, got ${firstCalls} transformer calls`);
        assert.deepEqual(user.render(120), first);
        assert.equal(calls, firstCalls);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

test("invalidates cached probes when theme or transformer configuration changes in place", async () => {
    const { UserMessageComponent, initTheme, getMarkdownTheme } =
        await import("@earendil-works/pi-coding-agent");
    const keys = [
        Symbol.for("@earendil-works/pi-coding-agent:theme"),
        Symbol.for("@mariozechner/pi-coding-agent:theme"),
    ];
    const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    initTheme(undefined, false);
    const { installUserMentionRendering } = await import("../src/message-rendering.ts");
    let calls = 0;
    const theme = getMarkdownTheme();
    const transformers = [
        (text: string): string => {
            calls++;
            return text;
        },
    ];
    const user = new UserMessageComponent("**hi** %team", theme, 1, transformers);
    let prefix = color;
    const definitions = [{ id: "team", trigger: "%" }];
    const patch = installUserMentionRendering(definitions, () => prefix);
    try {
        const first = user.render(60);
        assert.match(first.join(""), /\x1b\[35m%team/);
        const initialCalls = calls;
        const bold = theme.bold;
        theme.bold = (text) => bold(text);
        user.render(60);
        assert.ok(calls > initialCalls, "theme mutation should trigger a new probe");
        const themeCalls = calls;
        transformers.push((text) => text);
        user.render(60);
        assert.ok(calls > themeCalls, "transformer mutation should trigger a new probe");
        const transformerCalls = calls;
        prefix = "\x1b[36m";
        assert.match(user.render(60).join(""), /\x1b\[36m%team/);
        assert.ok(calls > transformerCalls, "prefix change should trigger a new probe");
        definitions.splice(0);
        assert.doesNotMatch(user.render(60).join(""), /\x1b\[36m%team/);
    } finally {
        patch.dispose();
        keys.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});
