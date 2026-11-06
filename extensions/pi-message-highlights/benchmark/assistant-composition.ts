import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
    AssistantMessageComponent,
    getMarkdownTheme,
    initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { installLinkedRenderPatch } from "@zigai/pi-extension-internals";
import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
} from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";

// Run with node --expose-gc --import tsx. Identical harness runs against a frozen checkout,
// not HEAD. Layout, matching, caches, and lifecycle ownership are all included;
// terminal output and response-renderer are deliberately excluded.
initTheme("dark", false);

const frames = Number(process.argv[2] ?? 3000);
assert.ok(Number.isSafeInteger(frames) && frames > 0);
assert.ok(global.gc, "Run node --expose-gc");

async function collect(): Promise<void> {
    for (let index = 0; index < 3; index += 1) {
        await setImmediate();
        global.gc?.();
    }
}

function message(sequence: number): AssistantMessage {
    const content: AssistantMessage["content"] = [];
    for (let block = 0; block < 6; block += 1) {
        content.push({
            type: "thinking",
            thinking: `Check src/module-${block}.ts https://example.org/${block}`,
        });
        content.push({
            type: "text",
            text: `## Result ${block}\n\nRead src/module-${block}.ts and https://example.com/${block}/${sequence}\n\n- Keep this representative prose unchanged\n- Another line with \`inline code\``,
        });
    }

    return {
        role: "assistant",
        content,
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
}

const targets = await loadMessageHighlightTargets();
assert.ok(targets);
let themeSamples = 0;
const patch = installMessageHighlightPatch(targets, DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG, () => {
    themeSamples += 1;
    return undefined;
});

// Mechanism probe is separate from timings: count actual linked render
// assignments, rather than infer allocation savings from noisy elapsed time.
const probe = new AssistantMessageComponent(message(0), false, getMarkdownTheme(), "Thinking", 0);
probe.render(100);

const originalSet = Reflect.set;
const originalWeakRef = globalThis.WeakRef;
let renderPatchInstalls = 0;
let steadyWeakRefs = 0;

globalThis.WeakRef = new Proxy(originalWeakRef, {
    construct(target, args) {
        steadyWeakRefs++;

        const created: unknown = Reflect.construct(target, args);
        assert.ok(created instanceof originalWeakRef);
        return created;
    },
});

themeSamples = 0;

/* oxlint-disable antislop/no-object-parameters, antislop/no-unknown-parameters -- Instrument the exact Reflect.set API; forward values untouched, never parse or invoke them. */
Reflect.set = (
    target: object,
    property: PropertyKey,
    value: unknown,
    receiver: object = target,
) => {
    if (property === "render") renderPatchInstalls += 1;
    return originalSet(target, property, value, receiver);
};
/* oxlint-enable antislop/no-object-parameters, antislop/no-unknown-parameters */

try {
    for (let index = 0; index < 20; index += 1) probe.render(100);
} finally {
    Reflect.set = originalSet;
    globalThis.WeakRef = originalWeakRef;
}

console.log(
    JSON.stringify({ probeRedraws: 20, renderPatchInstalls, themeSamples, steadyWeakRefs }),
);

try {
    for (const variant of ["redraw", "streaming"] as const) {
        const component = new AssistantMessageComponent(
            message(0),
            false,
            getMarkdownTheme(),
            "Thinking",
            0,
        );
        for (let index = 0; index < 100; index += 1) component.render(100);
        await collect();

        const heapBefore = process.memoryUsage().heapUsed;
        const cpu = process.cpuUsage();
        const started = performance.now();
        let output: string[] = [];
        for (let index = 0; index < frames; index += 1) {
            if (variant === "streaming" && index % 10 === 0)
                component.updateContent(message(index), true);

            output = component.render(100);
        }

        const wallMs = performance.now() - started;
        const used = process.cpuUsage(cpu);

        await collect();

        const retainedHeapBytes = process.memoryUsage().heapUsed;

        console.log(
            JSON.stringify({
                variant,
                frames,
                wallMs,
                userMs: used.user / 1000,
                systemMs: used.system / 1000,
                peakRssKiB: process.resourceUsage().maxRSS,
                retainedHeapBytes,
                retainedHeapDeltaBytes: retainedHeapBytes - heapBefore,
                digest: createHash("sha256").update(JSON.stringify(output)).digest("hex"),
            }),
        );

        // Keep the live SDK transcript reachable through the retained-heap sample.
        assert.ok(component.render(100).length > 0);
    }
} finally {
    patch.dispose();
}

// An empty, still-live assistant must not retain its historical children through
// caches or disposal handles. Do not dereference WeakRefs until after GC jobs.
const contentContainer = new Container();
const target = { contentContainer, render: (width: number) => contentContainer.render(width) };
const ownership = installMessageHighlightPatch(
    {
        assistantPrototype: target,
        userPrototype: { render: () => [] },
        editorPrototype: { render: () => [] },
    },
    DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
    () => undefined,
);

function removedChild(): WeakRef<Text> {
    const child = new Text(
        Array.from(
            { length: 2000 },
            (_, index) => `Read src/file-${index}.ts https://example.com/${index}`,
        ).join("\n"),
        0,
        0,
    );

    contentContainer.addChild(child);
    target.render(100);
    contentContainer.clear();

    // SDK mouseLayout retains the last layout until another render. Update only
    // host layout, not the assistant/cache frame, to isolate extension retention.
    contentContainer.render(100);

    return new WeakRef(child);
}

const removed = removedChild();

await collect();
console.log(
    JSON.stringify({
        removedChildCollectedBeforeDisposal: removed.deref() === undefined,
        retainedHeapBytes: process.memoryUsage().heapUsed,
        peakRssKiB: process.resourceUsage().maxRSS,
    }),
);

assert.equal(target.render(100).length, 0);
ownership.dispose();

// Keep just one externally-owned child, drop its owner without clearing it.
// The child wrapper may retain scalar gate state, but not a shared installer
// closure containing its container or siblings.
class DetachedAssistant {
    contentContainer = new Container();

    render(width: number): string[] {
        return this.contentContainer.render(width);
    }
}

const detachedPatch = installMessageHighlightPatch(
    {
        assistantPrototype: DetachedAssistant.prototype,
        userPrototype: { render: () => [] },
        editorPrototype: { render: () => [] },
    },
    DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
    () => undefined,
);

function detachedOwner() {
    const assistant = new DetachedAssistant();
    const child = new Text("https://example.com/retained", 0, 0);
    const sibling = new Text("https://example.com/sibling", 0, 0);
    const descriptor = Object.getOwnPropertyDescriptor(child, "render");

    assistant.contentContainer.addChild(child);
    assistant.contentContainer.addChild(sibling);
    assistant.render(100);

    return {
        child,
        descriptor,
        assistant: new WeakRef(assistant),
        container: new WeakRef(assistant.contentContainer),
        sibling: new WeakRef(sibling),
    };
}

const detached = detachedOwner();
const detachedForeign = detachedOwner();
const detachedForeignFirst = detachedOwner();
const foreign = installLinkedRenderPatch(
    detachedForeign.child,
    (predecessor) =>
        function (width) {
            return [...predecessor.call(this, width), "foreign"];
        },
);

const foreignFirst = installLinkedRenderPatch(
    detachedForeignFirst.child,
    (predecessor) =>
        function (width) {
            return [...predecessor.call(this, width), "foreign-first"];
        },
);

// Ephemeron/finalization processing can require additional GC jobs; never make
// a timing comparison fail because the baseline reports delayed collection.
await collect();
await collect();
await collect();

const detachedResult = {
    detachedAssistantCollected: detached.assistant.deref() === undefined,
    detachedContainerCollected: detached.container.deref() === undefined,
    detachedSiblingCollected: detached.sibling.deref() === undefined,
    foreignDetachedOwnersCollected:
        detachedForeign.assistant.deref() === undefined &&
        detachedForeign.container.deref() === undefined &&
        detachedForeign.sibling.deref() === undefined &&
        detachedForeignFirst.assistant.deref() === undefined &&
        detachedForeignFirst.container.deref() === undefined &&
        detachedForeignFirst.sibling.deref() === undefined,
};

console.log(JSON.stringify(detachedResult));
assert.ok(detached.child.render(100).length > 0);
foreignFirst.dispose();
detachedPatch.dispose();

// Disposal must restore live children even after their container registry died.
assert.deepEqual(Object.getOwnPropertyDescriptor(detached.child, "render"), detached.descriptor);
assert.deepEqual(
    Object.getOwnPropertyDescriptor(detachedForeignFirst.child, "render"),
    detachedForeignFirst.descriptor,
);

// oxlint-disable-next-line typescript/unbound-method -- Compare identity only; never invoke unbound.
assert.equal(detachedForeign.child.render, foreign.patched);
assert.ok(detachedForeign.child.render(100).includes("foreign"));
foreign.dispose();
assert.deepEqual(
    Object.getOwnPropertyDescriptor(detachedForeign.child, "render"),
    detachedForeign.descriptor,
);

console.log(
    JSON.stringify({
        detachedChildRestoredAfterDisposal: true,
        foreignDetachedChildrenRestoredAfterDisposal: true,
    }),
);
