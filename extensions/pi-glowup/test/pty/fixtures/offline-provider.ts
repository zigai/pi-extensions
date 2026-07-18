import {
    createAssistantMessageEventStream,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    type Model,
    type SimpleStreamOptions,
    type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

function hasToolResult(context: Context): boolean {
    return context.messages.some((message) => message.role === "toolResult");
}

function streamOfflineProvider(
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    return hasToolResult(context) ? streamTextResponse(model) : streamPatchResponse(model, options);
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

    pi.registerTool({
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
    });
}
