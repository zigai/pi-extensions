import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type SimpleStreamOptions,
    type ToolCall,
} from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withGlowupRendering } from "../../../src/tool-rendering/protocol.ts";
import { Type } from "typebox";
import { applyPatchOwnerRendering } from "../../support/apply-patch-owner-fixture.ts";

const PROVIDER_NAME = "pty-offline";
const MODEL_ID = "deterministic";
const FRAME_DELAY_MS = 70;

const obsoletePatch = [
    "*** Begin Patch",
    "*** Add File: src/obsolete.ts",
    "+export const obsolete = 'OBSOLETE_STREAM_MARKER';",
    "+export const staleTailOne = true;",
    "+export const staleTailTwo = true;",
].join("\n");

const shrunkPatch = [
    "*** Begin Patch",
    "*** Add File: src/obsolete.ts",
    "+export const obsolete = 'OBSOLETE_STREAM_MARKER';",
].join("\n");

const currentPatchPrefix = [
    "*** Begin Patch",
    "*** Add File: src/current.ts",
    "+export const current = 'CURRENT_STREAM_MARKER_",
].join("\n");
const splitEmojiPatch = `${currentPatchPrefix}${"🧪".slice(0, 1)}`;
const currentPatch = `${currentPatchPrefix}🧪';\n*** End Patch`;
const wrappingEditValue = "x".repeat(72);
const wrappingEditOldText = `export const longValue = "${wrappingEditValue}old";`;
const wrappingEditNewText = `export const longValue = "${wrappingEditValue}new";`;

const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
    },
} as const;

function createOutput(model: Model<string>): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...zeroUsage, cost: { ...zeroUsage.cost } },
        stopReason: "stop",
        timestamp: Date.now(),
    };
}

function finishWithError(
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    cause: unknown,
): void {
    output.stopReason = "error";
    output.errorMessage = cause instanceof Error ? cause.message : String(cause);
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
}

function streamTextResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const text = "STREAM_COMPLETE";
    output.content.push({ type: "text", text });
    stream.push({ type: "start", partial: output });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
    return stream;
}

function streamPatchResponse(
    model: Model<string>,
    options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-apply-patch",
        name: "apply_patch",
        arguments: {},
    };
    output.content.push(toolCall);
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });

    const snapshots = [
        undefined,
        obsoletePatch,
        shrunkPatch,
        splitEmojiPatch,
        currentPatch,
    ] as const;
    let snapshotIndex = 0;
    let timer: NodeJS.Timeout | undefined;
    let finished = false;

    const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    };
    const fail = (cause: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        finishWithError(stream, output, cause);
    };
    const abort = (): void => fail(options?.signal?.reason ?? new Error("offline stream aborted"));
    const emitNext = (): void => {
        if (finished) return;
        if (options?.signal?.aborted === true) {
            abort();
            return;
        }
        const snapshot = snapshots[snapshotIndex];
        if (snapshotIndex < snapshots.length) {
            toolCall.arguments = snapshot === undefined ? {} : { patch: snapshot };
            stream.push({
                type: "toolcall_delta",
                contentIndex: 0,
                delta: "",
                partial: output,
            });
            snapshotIndex += 1;
            timer = setTimeout(emitNext, FRAME_DELAY_MS);
            return;
        }

        finished = true;
        cleanup();
        toolCall.arguments = { patch: currentPatch };
        output.stopReason = "toolUse";
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
    };

    options?.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(emitNext, FRAME_DELAY_MS);
    return stream;
}

function streamBashChainResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-bash-chain",
        name: "bash",
        arguments: {
            command: "printf 'CHAIN_ALPHA\\n' && printf 'CHAIN_BETA\\n'",
        },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
    return stream;
}

function streamWrappingEditResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-wrapping-edit",
        name: "edit",
        arguments: {
            path: "src/layout.ts",
            edits: [{ oldText: wrappingEditOldText, newText: wrappingEditNewText }],
        },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
    return stream;
}

function streamBashLayoutResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-bash-layout",
        name: "bash",
        arguments: {
            command:
                `for item in alpha beta gamma delta; do if test "\${#item}" -gt 4; then printf '%s:%s\\n' "$item" long; ` +
                `else printf '%s:%s\\n' "$item" short; fi; done | sort && case "$(uname -s)" in ` +
                `Linux) printf '%s\\n' 'platform:linux';; Darwin) printf '%s\\n' 'platform:darwin';; ` +
                `*) printf '%s\\n' 'platform:other';; esac`,
        },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
    return stream;
}

function streamReclassifiedBashResponse(
    model: Model<string>,
    options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const completedCommand = [
        `printf 'FINAL_BASH_PREFIX\\n' || true`,
        `node --input-type=module <<'NODE'`,
        `const examples = [\`python -c "print('embedded')"\`];`,
        `console.log('FINAL_BASH_RENDER', examples.length);`,
        `NODE`,
    ].join("\n");
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-reclassified-bash",
        name: "bash",
        arguments: {},
    };
    output.content.push(toolCall);
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });

    const snapshots = [`python -c "print('SPECULATIVE_PYTHON')"`, completedCommand] as const;
    let snapshotIndex = 0;
    let timer: NodeJS.Timeout | undefined;
    let finished = false;

    const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    };
    const fail = (cause: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        finishWithError(stream, output, cause);
    };
    const abort = (): void => fail(options?.signal?.reason ?? new Error("offline stream aborted"));
    const emitNext = (): void => {
        if (finished) return;
        if (options?.signal?.aborted === true) {
            abort();
            return;
        }
        const snapshot = snapshots[snapshotIndex];
        if (snapshot !== undefined) {
            toolCall.arguments = { command: snapshot };
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "", partial: output });
            snapshotIndex += 1;
            timer = setTimeout(emitNext, FRAME_DELAY_MS);
            return;
        }

        finished = true;
        cleanup();
        toolCall.arguments = { command: completedCommand };
        output.stopReason = "toolUse";
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
    };

    options?.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(emitNext, FRAME_DELAY_MS);
    return stream;
}

function streamFormattedPythonResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-formatted-python",
        name: "bash",
        arguments: {
            command: `python -c "import os; print(os.getcwd())"`,
        },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
    return stream;
}

function streamUvPythonArgsResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const command = [
        `uv run --offline --no-project python -c 'import json`,
        `import statistics`,
        `import sys`,
        `from collections import Counter`,
        ``,
        `records = [`,
        `    {"kind": "read", "ms": 12},`,
        `    {"kind": "edit", "ms": 41},`,
        `    {"kind": "read", "ms": 8},`,
        `    {"kind": "write", "ms": 23},`,
        `]`,
        `durations = [record["ms"] for record in records]`,
        `counts = Counter(record["kind"] for record in records)`,
        `summary = {`,
        `    "argv": sys.argv[1:],`,
        `    "kinds": dict(counts),`,
        `    "median_ms": statistics.median(durations),`,
        `}`,
        `print(json.dumps(summary, indent=2, sort_keys=True))`,
        `' -- demo --verbose`,
    ].join("\n");
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-uv-python-args",
        name: "bash",
        arguments: { command },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
    return stream;
}

function streamInlinePythonPipelineResponse(model: Model<string>): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const command = [
        `printf '%s\\n' '8 read' '3 write' '13 patch' '5 read' | python3 -c 'import sys`,
        `for line in sys.stdin:`,
        `    value, name = line.split()`,
        `    print(f"{int(value):04d} {name}")`,
        `' | sort -nr | head -n 3`,
    ].join("\n");
    const toolCall: ToolCall = {
        type: "toolCall",
        id: "pty-inline-python-pipeline",
        name: "bash",
        arguments: { command },
    };
    output.content.push(toolCall);
    output.stopReason = "toolUse";
    stream.push({ type: "start", partial: output });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
    stream.push({ type: "done", reason: "toolUse", message: output });
    stream.end();
    return stream;
}

function latestUserText(context: Context): string {
    for (let index = context.messages.length - 1; index >= 0; index -= 1) {
        const message = context.messages[index];
        if (message?.role !== "user") continue;
        if (typeof message.content === "string") return message.content;
        return message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n");
    }
    return "";
}

function hasToolResult(context: Context): boolean {
    return context.messages.some((message) => message.role === "toolResult");
}

function streamOfflineProvider(
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    if (hasToolResult(context)) return streamTextResponse(model);
    const prompt = latestUserText(context);
    if (prompt.includes("deterministic wrapping patch")) {
        return streamWrappingEditResponse(model);
    }
    if (prompt.includes("deterministic bash chain")) return streamBashChainResponse(model);
    if (prompt.includes("deterministic bash layout")) return streamBashLayoutResponse(model);
    if (prompt.includes("deterministic reclassified bash")) {
        return streamReclassifiedBashResponse(model, options);
    }
    if (prompt.includes("deterministic formatted python")) {
        return streamFormattedPythonResponse(model);
    }
    if (prompt.includes("deterministic uv python args")) {
        return streamUvPythonArgsResponse(model);
    }
    if (prompt.includes("deterministic inline python pipeline")) {
        return streamInlinePythonPipelineResponse(model);
    }
    return streamPatchResponse(model, options);
}

export default function offlinePtyProvider(pi: ExtensionAPI): void {
    pi.registerProvider(PROVIDER_NAME, {
        name: "Deterministic offline PTY fixture",
        baseUrl: "offline://local",
        apiKey: "offline-test-key",
        api: "pty-offline",
        models: [
            {
                id: MODEL_ID,
                name: "Deterministic PTY model",
                api: "pty-offline",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 16_384,
                maxTokens: 1_024,
            },
        ],
        streamSimple: streamOfflineProvider,
    });

    pi.registerTool(
        withGlowupRendering(
            defineTool({
                name: "apply_patch",
                label: "apply_patch",
                description: "Deterministic no-op patch tool for PTY renderer verification.",
                parameters: Type.Object({ patch: Type.String() }),
                execute(_toolCallId, params) {
                    const addedLineCount = params.patch
                        .split(/\r?\n/gu)
                        .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
                    return Promise.resolve({
                        content: [{ type: "text" as const, text: "Done!" }],
                        details: {
                            diff: "src/current.ts\n+1 export const current = 'CURRENT_STREAM_MARKER_🧪';\n",
                            inputPatch: params.patch,
                            patch: "--- /dev/null\n+++ b/src/current.ts\n@@ -0,0 +1 @@\n+export const current = 'CURRENT_STREAM_MARKER_🧪';\n",
                            lineSummary: {
                                files: [
                                    {
                                        action: "A",
                                        path: "src/current.ts",
                                        addedLines: addedLineCount,
                                        removedLines: 0,
                                    },
                                ],
                            },
                        },
                    });
                },
            }),
            applyPatchOwnerRendering,
        ),
    );
}
