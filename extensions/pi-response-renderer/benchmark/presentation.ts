import { setImmediate as nextJob } from "node:timers/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

async function collect(): Promise<void> {
    for (let index = 0; index < 3; index++) {
        await nextJob();
        global.gc?.();
    }
}

const variant = process.argv[2] ?? "after";
const mode = process.argv[3] ?? "headings-stream";
let directory = resolve("extensions/pi-response-renderer/src");
if (variant === "before")
    directory = resolve(process.argv[4] ?? ".cache/perf-followup/markdown/original/src");

const rendering: unknown = await import(
    pathToFileURL(resolve(directory, "response-rendering.ts")).href
);

const markdown: unknown = await import(
    pathToFileURL(resolve(directory, "markdown-rendering.ts")).href
);

const renderingSchema = Type.Object({
    installResponseRendering: Type.Function([], Type.Unknown()),
});

const markdownSchema = Type.Object({
    collapseAssistantBlankLines: Type.Function(
        [
            Type.Array(Type.String()),
            Type.String(),
            Type.Unknown(),
            Type.Optional(Type.Unknown()),
            Type.Optional(Type.Boolean()),
        ],
        Type.Array(Type.String()),
    ),
});
const handleSchema = Type.Object({ dispose: Type.Function([], Type.Void()) });
assert.ok(Value.Check(renderingSchema, rendering));
assert.ok(Value.Check(markdownSchema, markdown));
if (global.gc === undefined) throw new Error("Run with --expose-gc");

initTheme("dark", false);

const handle: unknown = await rendering.installResponseRendering();
assert.ok(Value.Check(handleSchema, handle));
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        api: "fixture",
        provider: "fixture",
        model: "fixture",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zero },
        stopReason: "stop",
        timestamp: 0,
    };
}

let text = "";
const paragraphs = mode === "paragraphs-stream";
for (let index = 0; index < 100; index++) {
    if (!paragraphs) text += `${"#".repeat((index % 5) + 1)} Section ${index}\n\n`;
    text += `Paragraph ${index} with **bold text**, a [link](https://example.test/${index}) and a comment.\n\n`;
}

let component: AssistantMessageComponent | undefined;
if (mode.endsWith("-stream")) {
    component = new AssistantMessageComponent(assistant(text), false, undefined, undefined, 0);
    component.render(100);
}

const lines = Array.from({ length: 2_000 }, (_, index) => [
    `\u001b[31mLong paragraph ${index} has enough text to avoid the micro-heading heuristic.\u001b[0m`,
    "",
]).flat();
const outputs: string[][] = [];

await collect();

const heapBefore = process.memoryUsage().heapUsed;
const cpuBefore = process.cpuUsage();
const started = performance.now();
let operations = 1;
if (mode === "classification") {
    operations = 100;

    let output: string[] = [];
    for (let index = 0; index < operations; index++)
        output = markdown.collapseAssistantBlankLines(lines, "", new Set());

    outputs.push(output);
} else if (mode.endsWith("-stream") && component !== undefined) {
    operations = 30;
    for (let index = 0; index < operations; index++) {
        component.updateContent(assistant(text + `Streaming tail ${index}.`), true);
        outputs.push(component.render(100));
    }
} else if (mode === "headings-cold") {
    component = new AssistantMessageComponent(assistant(text), false, undefined, undefined, 0);
    for (const width of [100, 60, 180, 100]) outputs.push(component.render(width));
} else throw new Error("Unknown mode");

const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);

await collect();

const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;
const checksum = createHash("sha256").update(JSON.stringify(outputs)).digest("hex");

console.log(
    JSON.stringify({
        variant,
        mode,
        operations,
        wallMs,
        userMs: cpu.user / 1000,
        systemMs: cpu.system / 1000,
        peakRssKiB: process.resourceUsage().maxRSS,
        retainedHeapBytes,
        rows: outputs.reduce((sum, output) => sum + output.length, 0),
        checksum,
    }),
);

handle.dispose();
