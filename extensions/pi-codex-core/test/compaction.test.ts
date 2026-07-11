import assert from "node:assert/strict";
import { test } from "vitest";
import {
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CORE_CONFIG } from "../src/config/config.ts";
import {
    cancelScheduledCodexAutoCompaction,
    handleCodexNativeCompaction,
    isNativeCompactionDetails,
    maybeTriggerCodexAutoCompaction,
    NATIVE_COMPACTION_SHIM_SUMMARY,
    rewriteProviderRequestWithNativeCompaction,
    scheduleCodexAutoCompaction,
} from "../src/compaction/service.ts";
import { executeRemoteCompactionV2 } from "../src/compaction/remote-client.ts";
import { buildRemoteCompactionV2Request } from "../src/compaction/request-budget.ts";
import {
    CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY,
    CODEX_RESPONSES_LITE_HEADER,
} from "../src/codex/responses-compat.ts";
import type { CodexRuntime, ScheduledTask } from "../src/runtime.ts";
import {
    countCodexTextTokens,
    shutdownCodexTokenizer,
    truncateCodexTextToTokenBudget,
    warmCodexTokenizer,
} from "../src/compaction/tokenizer.ts";
import { makeTestRuntime, messageEntry, isRecord } from "./helpers.ts";

test("Codex tokenizer worker restarts after shutdown", async () => {
    await shutdownCodexTokenizer();
    try {
        const text = "alpha beta gamma delta epsilon zeta eta theta";
        warmCodexTokenizer();
        const countBeforeShutdown = await countCodexTextTokens(text);
        const truncatedBeforeShutdown = await truncateCodexTextToTokenBudget(text, 3);

        await shutdownCodexTokenizer();

        const countAfterShutdown = await countCodexTextTokens(text);
        const truncatedAfterShutdown = await truncateCodexTextToTokenBudget(text, 3);

        assert.ok(countBeforeShutdown > 3);
        assert.equal(countAfterShutdown, countBeforeShutdown);
        assert.equal(truncatedAfterShutdown, truncatedBeforeShutdown);
        assert.ok(truncatedAfterShutdown.length < text.length);
    } finally {
        await shutdownCodexTokenizer();
    }
});

test("creates native compaction using remote compaction v2", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    let requestAccountId: string | null = null;
    let requestHeaders = new Headers();
    const runtime = makeTestRuntime(async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as unknown;
        requestHeaders = new Headers(init?.headers);
        requestAccountId = requestHeaders.get("ChatGPT-Account-ID");
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_1","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent(),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(requestUrl, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(requestAccountId, "account");
    assert.equal(requestHeaders.get("x-codex-beta-features"), "remote_compaction_v2");
    assert.equal(requestHeaders.has("version"), false);
    assert.equal(requestHeaders.get("x-codex-window-id"), "00000000-0000-7000-8000-000000000001");
    assert.equal(requestHeaders.get("x-client-request-id"), "session-1");
    assert.equal(requestHeaders.get("session-id"), "session-1");
    assert.equal(requestHeaders.get("thread-id"), "session-1");
    assert.deepEqual(JSON.parse(requestHeaders.get("x-codex-turn-metadata") ?? "null"), {
        installation_id: "session-1",
        session_id: "session-1",
        thread_id: "session-1",
        turn_id: "00000000-0000-7000-8000-000000000001",
        window_id: "00000000-0000-7000-8000-000000000001",
        request_kind: "compaction",
        compaction: {
            trigger: "manual",
            reason: "user_requested",
            implementation: "responses_compaction_v2",
            phase: "standalone_turn",
            strategy: "memento",
        },
        turn_started_at_unix_ms: 1_700_000_000_000,
    });
    assert.ok(isRecord(requestBody));
    assert.equal(requestBody.model, "gpt-5.5");
    assert.deepEqual((requestBody.input as unknown[]).at(-1), {
        type: "compaction_trigger",
    });
    assert.deepEqual(requestBody.tools, [
        {
            type: "function",
            name: "read",
            description: "Read a file.",
            parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
            strict: null,
        },
    ]);
    assert.ok(isRecord(requestBody.client_metadata));
    assert.equal(
        requestBody.client_metadata["x-codex-window-id"],
        "00000000-0000-7000-8000-000000000001",
    );
    assert.equal(
        requestBody.client_metadata["x-codex-turn-metadata"],
        requestHeaders.get("x-codex-turn-metadata"),
    );
    assert.equal(result?.compaction?.details.strategy, "pi-codex-core-remote-compaction-v2");
    assert.equal(result?.compaction?.details.model, "gpt-5.5");
    assert.deepEqual(result?.compaction?.details.compactedWindow, [
        {
            role: "user",
            content: [{ type: "input_text", text: "keep this request" }],
        },
        { type: "compaction", encrypted_content: "sealed" },
    ]);
    assert.equal(result?.compaction?.details.windowNumber, 1);
    assert.equal(result?.compaction?.details.firstWindowId, result?.compaction?.details.windowId);
    assert.equal(result?.compaction?.details.previousWindowId, undefined);
    assert.equal(Object.hasOwn(result?.compaction?.details ?? {}, "replacementInput"), false);
    assert.equal(result?.compaction?.details.worldState.cwd, "/workspace");
    assert.equal(result?.compaction?.details.worldState.model, "openai-codex/gpt-5.5");
    assert.deepEqual(result?.compaction?.details.worldState.activeToolNames, ["read"]);
});

test("cancels an invalid retained-context boundary", async () => {
    let requested = false;
    const runtime = makeTestRuntime(async () => {
        requested = true;
        return new Response("unexpected");
    });
    const event = makeBeforeCompactEvent({
        branchEntries: [messageEntry("entry-1", null, userMessage("hello"))],
        firstKeptEntryId: "missing-entry",
    });

    const result = await handleCodexNativeCompaction(
        event,
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.deepEqual(result, { cancel: true });
    assert.equal(requested, false);
});

test("removes response item ids from remote compaction history", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(
            [
                "event: response.output_item.done",
                'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}',
                "",
                "event: response.completed",
                'data: {"type":"response.completed","response":{"id":"resp_ids"}}',
                "",
            ].join("\n"),
            { status: 200 },
        );
    });
    const branchEntries = [
        messageEntry("entry-1", null, userMessage("inspect ids")),
        messageEntry(
            "entry-2",
            "entry-1",
            assistantMessage([
                { type: "text", text: "calling read" },
                {
                    type: "toolCall",
                    id: "call_read|fc_server_item",
                    name: "read",
                    arguments: { path: "README.md" },
                },
            ]),
        ),
        messageEntry(
            "entry-3",
            "entry-2",
            toolResultMessage("call_read|fc_server_item", "contents"),
        ),
    ];

    await handleCodexNativeCompaction(
        makeBeforeCompactEvent({ branchEntries }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    const input = responseInput(requestBody);
    assert.ok(input.some((item) => isRecord(item) && item.type === "function_call"));
    assert.equal(
        input.some((item) => isRecord(item) && Object.hasOwn(item, "id")),
        false,
    );
});

test("creates GPT-5.6 native compaction with Responses Lite", async () => {
    let requestBody: unknown;
    let responsesLiteHeader: string | null = null;
    let turnMetadataHeader: string | null = null;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const headers = new Headers(init?.headers);
        responsesLiteHeader = headers.get(CODEX_RESPONSES_LITE_HEADER);
        turnMetadataHeader = headers.get("x-codex-turn-metadata");
        return new Response(
            [
                "event: response.output_item.done",
                'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-lite"}}',
                "",
                "event: response.completed",
                'data: {"type":"response.completed","response":{"id":"resp_lite","created_at":123}}',
                "",
            ].join("\n"),
            { status: 200 },
        );
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({ reason: "overflow" }),
        makeNativeCompactionContext({ modelId: "gpt-5.6-sol", contextWindow: 272_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
            openai: {
                ...DEFAULT_CODEX_CORE_CONFIG.openai,
                compactionReasoning: "current",
            },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(responsesLiteHeader, "true");
    const turnMetadata: unknown = JSON.parse(turnMetadataHeader ?? "null");
    assert.ok(isRecord(turnMetadata));
    assert.deepEqual(turnMetadata.compaction, {
        trigger: "auto",
        reason: "context_limit",
        implementation: "responses_compaction_v2",
        phase: "standalone_turn",
        strategy: "memento",
    });
    assert.ok(isRecord(requestBody));
    assert.equal(Object.hasOwn(requestBody, "instructions"), false);
    assert.equal(Object.hasOwn(requestBody, "tools"), false);
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.deepEqual(requestBody.reasoning, { effort: "low", context: "all_turns" });
    assert.ok(isRecord(requestBody.client_metadata));
    assert.equal(requestBody.client_metadata[CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY], "true");
    assert.equal(
        requestBody.client_metadata["x-codex-window-id"],
        "00000000-0000-7000-8000-000000000001",
    );
    const input = responseInput(requestBody);
    assert.deepEqual(input[0], {
        type: "additional_tools",
        role: "developer",
        tools: [
            {
                type: "function",
                name: "read",
                description: "Read a file.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                },
                strict: null,
            },
        ],
    });
    assert.deepEqual(input[1], {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system prompt" }],
    });
    assert.deepEqual(input.at(-1), { type: "compaction_trigger" });
    assert.equal(result?.compaction?.details.model, "gpt-5.6-sol");
});

test("reports bounded redacted remote compaction HTTP error details", async () => {
    const runtime = makeTestRuntime(
        async () =>
            new Response(
                JSON.stringify({
                    error: {
                        type: "invalid_request_error",
                        code: "missing_beta",
                        message: "Requires remote_compaction_v2; Bearer secret-token must not leak",
                    },
                }),
                {
                    status: 400,
                    headers: { "x-request-id": "request-123" },
                },
            ),
    );
    const request = buildRemoteCompactionV2Request({
        model: "gpt-5.6-sol",
        input: [{ role: "user", content: "compact" }],
        instructions: "system",
        promptCacheKey: "session",
        verbosity: "low",
        fast: false,
    });

    const result = await executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        new AbortController().signal,
        runtime,
    );

    assert.ok(result.isErr());
    assert.match(result.error.message, /type=invalid_request_error/);
    assert.match(result.error.message, /code=missing_beta/);
    assert.match(result.error.message, /Requires remote_compaction_v2/);
    assert.match(result.error.message, /Bearer \[redacted\]/);
    assert.match(result.error.message, /request_id=request-123/);
    assert.doesNotMatch(result.error.message, /secret-token/);
});

test("retries transient remote compaction failures", async () => {
    let attempts = 0;
    const runtime = makeTestRuntime(async () => {
        attempts += 1;
        if (attempts === 1) return new Response("temporary", { status: 500 });
        return new Response(
            [
                "event: response.output_item.done",
                'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"retried"}}',
                "",
                "event: response.completed",
                'data: {"type":"response.completed","response":{"id":"resp_retry"}}',
                "",
            ].join("\n"),
            { status: 200 },
        );
    });
    const request = buildRemoteCompactionV2Request({
        model: "gpt-5.5",
        input: [{ role: "user", content: "compact" }],
        instructions: "system",
        promptCacheKey: "session",
        verbosity: "low",
        fast: false,
    });

    const result = await executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        new AbortController().signal,
        runtime,
    );

    assert.ok(result.isOk());
    assert.equal(attempts, 2);
    assert.equal(result.value.compactionOutput.encrypted_content, "retried");
});

test("does not retry HTTP 429 compaction responses", async () => {
    let attempts = 0;
    const runtime = makeTestRuntime(async () => {
        attempts += 1;
        return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "60" },
        });
    });
    const request = buildRemoteCompactionV2Request({
        model: "gpt-5.5",
        input: [{ role: "user", content: "compact" }],
        instructions: "system",
        promptCacheKey: "session",
        verbosity: "low",
        fast: false,
    });

    const result = await executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        new AbortController().signal,
        runtime,
    );

    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexHttpRequestFailed");
    assert.equal(attempts, 1);
});

test("times out and retries idle remote compaction streams", async () => {
    let attempts = 0;
    let cancellations = 0;
    const attemptSignals: AbortSignal[] = [];
    const runtime: CodexRuntime = {
        ...makeTestRuntime(async (_input, init) => {
            const previousSignal = attemptSignals.at(-1);
            if (previousSignal) assert.equal(previousSignal.aborted, true);
            assert.ok(init?.signal);
            attemptSignals.push(init.signal);
            attempts += 1;
            const body = new ReadableStream<Uint8Array>({
                cancel() {
                    cancellations += 1;
                },
            });
            return new Response(body, { status: 200 });
        }),
        scheduler: {
            set(_delayMs, task) {
                task();
                return { cancel() {} };
            },
        },
    };
    const request = buildRemoteCompactionV2Request({
        model: "gpt-5.5",
        input: [{ role: "user", content: "compact" }],
        instructions: "system",
        promptCacheKey: "session",
        verbosity: "low",
        fast: false,
    });

    const result = await executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        new AbortController().signal,
        runtime,
    );

    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexNetworkUnavailable");
    assert.equal(attempts, 3);
    assert.equal(cancellations, 3);
    assert.equal(
        attemptSignals.every((signal) => signal.aborted),
        true,
    );
});

test("does not retry unexpected stream-processing exceptions", async () => {
    let attempts = 0;
    let attemptSignal: AbortSignal | null | undefined;
    const runtime: CodexRuntime = {
        ...makeTestRuntime(async (_input, init) => {
            attempts += 1;
            attemptSignal = init?.signal;
            return new Response(new ReadableStream<Uint8Array>(), { status: 200 });
        }),
        scheduler: {
            set() {
                throw new TypeError("scheduler defect");
            },
        },
    };
    const request = buildRemoteCompactionV2Request({
        model: "gpt-5.5",
        input: [{ role: "user", content: "compact" }],
        instructions: "system",
        promptCacheKey: "session",
        verbosity: "low",
        fast: false,
    });

    await assert.rejects(
        executeRemoteCompactionV2(
            { responsesUrl: "https://example.test/responses", headers: new Headers() },
            request,
            new AbortController().signal,
            runtime,
        ),
        /scheduler defect/,
    );
    assert.equal(attempts, 1);
    assert.equal(attemptSignal?.aborted, true);
});

test("rejects malformed remote compaction output items", async () => {
    const runtime = makeTestRuntime(
        async () =>
            new Response(
                [
                    "event: response.output_item.done",
                    'data: {"type":"response.output_item.done","item":{"type":"compaction"}}',
                    "",
                    "event: response.completed",
                    'data: {"type":"response.completed","response":{"id":"resp_malformed"}}',
                    "",
                ].join("\n"),
                { status: 200 },
            ),
    );
    const request = buildRemoteCompactionV2Request({
        model: "gpt-5.5",
        input: [{ role: "user", content: "compact" }],
        instructions: "system",
        promptCacheKey: "session",
        verbosity: "low",
        fast: false,
    });

    const result = await executeRemoteCompactionV2(
        { responsesUrl: "https://example.test/responses", headers: new Headers() },
        request,
        new AbortController().signal,
        runtime,
    );

    assert.ok(result.isErr());
    assert.equal(result.error._tag, "CodexUnexpectedResponse");
    assert.match(result.error.message, /expected exactly one compaction output item/i);
});

test("rejects persisted native windows with malformed compaction output", () => {
    const entry = nativeCompactionEntry({
        id: "malformed-native",
        firstKeptEntryId: "entry-old",
    });
    assert.ok(isRecord(entry.details));

    assert.equal(
        isNativeCompactionDetails({
            ...entry.details,
            compactedWindow: [{ type: "compaction" }],
        }),
        false,
    );
});

test("streams remote compaction SSE without buffering response text", async () => {
    let textCalled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(
                encoder.encode(
                    [
                        "event: response.output_item.done",
                        'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"streamed"}}',
                        "",
                        "",
                    ].join("\n"),
                ),
            );
            controller.enqueue(
                encoder.encode(
                    [
                        "event: response.completed",
                        'data: {"type":"response.completed","response":{"id":"resp_stream","created_at":123}}',
                        "",
                        "",
                    ].join("\n"),
                ),
            );
            controller.close();
        },
    });
    const response = {
        ok: true,
        status: 200,
        body,
        text: async () => {
            textCalled = true;
            throw new Error("response text should not be buffered");
        },
    };
    const runtime = makeTestRuntime(async () => {
        // SAFETY: This fixture implements the Response members read by remote compaction streaming.
        return response as unknown as Response;
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent(),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(textCalled, false);
    assert.deepEqual(result?.compaction?.details.compactedWindow.at(-1), {
        type: "compaction",
        encrypted_content: "streamed",
    });
});

test("cancels remote compaction streams with oversized pending SSE events", async () => {
    let streamCancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(`data: ${"x".repeat(1_000_001)}`));
        },
        cancel() {
            streamCancelled = true;
        },
    });
    const response = {
        ok: true,
        status: 200,
        body,
        text: async () => {
            throw new Error("response text should not be buffered");
        },
    };
    const runtime = makeTestRuntime(async () => {
        // SAFETY: This fixture implements the Response members read by remote compaction streaming.
        return response as unknown as Response;
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent(),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(result, undefined);
    assert.equal(streamCancelled, true);
});

test("chains previous native compaction into the next remote v2 request", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-new"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_2","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-tail",
        }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(isRecord(requestBody));
    assert.deepEqual((requestBody.input as unknown[]).slice(0, 3), [
        { type: "compaction", encrypted_content: "opaque" },
        { role: "user", content: [{ type: "input_text", text: "new live tail" }] },
        { type: "compaction_trigger" },
    ]);
    assert.equal(result?.compaction?.details.requestMeta?.previousCompactionEntryId, "compact-1");
    assert.equal(result?.compaction?.details.windowNumber, 2);
    assert.equal(result?.compaction?.details.previousWindowId, "window-1");
    assert.equal(result?.compaction?.details.firstWindowId, "window-1");
    assert.equal(result?.compaction?.details.sourceCompactionEntryId, "compact-1");
    assert.deepEqual(result?.compaction?.details.compactedWindow, [
        { role: "user", content: [{ type: "input_text", text: "new live tail" }] },
        { type: "compaction", encrypted_content: "sealed-new" },
    ]);
});

test("uses Pi's active summary boundary instead of superseded raw history", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return new Response(
            [
                "event: response.output_item.done",
                'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"active-history"}}',
                "",
                "event: response.completed",
                'data: {"type":"response.completed","response":{"id":"resp_active_history"}}',
                "",
            ].join("\n"),
            { status: 200 },
        );
    });
    const branchEntries = [
        messageEntry("superseded", null, userMessage("superseded raw instruction")),
        messageEntry("active-old", "superseded", userMessage("active old context")),
        messageEntry("active-tail", "active-old", userMessage("active tail")),
        {
            type: "compaction",
            id: "pi-compaction",
            parentId: "active-tail",
            summary: "authoritative Pi summary",
            firstKeptEntryId: "active-old",
            tokensBefore: 100,
        },
        messageEntry("recent", "pi-compaction", userMessage("recent request")),
    ];

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries,
            firstKeptEntryId: "active-tail",
            previousSummary: "authoritative Pi summary",
            messagesToSummarize: [userMessage("active old context")],
        }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(result?.compaction);
    const serializedRequest = JSON.stringify(requestBody);
    assert.doesNotMatch(serializedRequest, /superseded raw instruction/);
    assert.match(serializedRequest, /authoritative Pi summary/);
    assert.match(serializedRequest, /active tail/);
    assert.match(serializedRequest, /recent request/);
    assert.equal(serializedRequest.match(/authoritative Pi summary/g)?.length, 1);
});

test("native compaction inserts synthetic output for missing tool results", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-missing-tool-result"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_missing_tool_result","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-tool",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/missing|item/missing",
                            name: "read",
                            arguments: { path: "missing.txt" },
                        },
                    ]),
                ),
                messageEntry("user-after-tool", "assistant-tool", userMessage("please continue")),
            ],
            firstKeptEntryId: "user-after-tool",
        }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(result?.compaction);
    assert.ok(isRecord(requestBody));
    const requestInput = responseInput(requestBody);
    const callIndex = requestInput.findIndex(
        (item) => isRecord(item) && item.type === "function_call",
    );
    const syntheticOutputIndex = requestInput.findIndex(
        (item) =>
            isRecord(item) &&
            item.type === "function_call_output" &&
            item.output === "No result provided",
    );
    const userIndex = requestInput.findIndex(
        (item) => isRecord(item) && textFromResponseItem(item) === "please continue",
    );

    assert.ok(callIndex >= 0);
    assert.ok(syntheticOutputIndex > callIndex);
    assert.ok(userIndex > syntheticOutputIndex);
    assert.deepEqual(requestInput[syntheticOutputIndex], {
        type: "function_call_output",
        call_id: "call_missing",
        output: "No result provided",
    });
});

test("falls back when a previous native anchor plus semantic input cannot fit", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-after-trim"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_anchor_trim","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
                messageEntry(
                    "entry-huge-tail",
                    "compact-1",
                    userMessage(`huge ${"x ".repeat(8_000)}`),
                ),
                messageEntry("entry-recent-tail", "entry-huge-tail", userMessage("new live tail")),
            ],
            firstKeptEntryId: "entry-huge-tail",
        }),
        makeNativeCompactionContext({ contextWindow: 2_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(requestBody, undefined);
    assert.equal(result, undefined);
});

test("shrinks oversized tool outputs before remote v2 compaction", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_3","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-tool",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/1|item/1",
                            name: "read",
                            arguments: { path: "big.txt" },
                        },
                    ]),
                ),
                messageEntry(
                    "tool-result",
                    "assistant-tool",
                    toolResultMessage("call/1|item/1", "x ".repeat(2_000)),
                ),
                messageEntry("user-after-tool", "tool-result", userMessage("please continue")),
            ],
            firstKeptEntryId: "user-after-tool",
        }),
        makeNativeCompactionContext({ contextWindow: 600 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(isRecord(requestBody));
    const callItem = (requestBody.input as unknown[]).find(
        (item) => isRecord(item) && item.type === "function_call",
    );
    assert.deepEqual(callItem, {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: JSON.stringify({ path: "big.txt" }),
    });
    const outputItem = (requestBody.input as unknown[]).find(
        (item) => isRecord(item) && item.type === "function_call_output",
    );
    assert.ok(isRecord(outputItem));
    assert.equal(outputItem.output, "[truncated]");
    assert.equal(result?.compaction?.details.requestMeta?.rewrittenToolOutputs, 1);
});

test("rewrites multiple oversized tool outputs before serializing remote v2 compaction", async () => {
    let requestBodyText = "";
    const firstHugeOutput = `first huge output ${"a ".repeat(3_000)}`;
    const secondHugeOutput = `second huge output ${"b ".repeat(3_000)}`;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBodyText = String(init?.body);
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-multi-tool"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_multi_tool","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-tool-1",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/1|item/1",
                            name: "read",
                            arguments: { path: "first.txt" },
                        },
                    ]),
                ),
                messageEntry(
                    "tool-result-1",
                    "assistant-tool-1",
                    toolResultMessage("call/1|item/1", firstHugeOutput),
                ),
                messageEntry("user-after-tool-1", "tool-result-1", userMessage("continue 1")),
                messageEntry(
                    "assistant-tool-2",
                    "user-after-tool-1",
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/2|item/2",
                            name: "read",
                            arguments: { path: "second.txt" },
                        },
                    ]),
                ),
                messageEntry(
                    "tool-result-2",
                    "assistant-tool-2",
                    toolResultMessage("call/2|item/2", secondHugeOutput),
                ),
                messageEntry("user-after-tool-2", "tool-result-2", userMessage("continue 2")),
            ],
            firstKeptEntryId: "user-after-tool-2",
        }),
        makeNativeCompactionContext({ contextWindow: 1_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.ok(result?.compaction);
    assert.equal(result.compaction.details.requestMeta?.rewrittenToolOutputs, 2);
    assert.doesNotMatch(requestBodyText, /first huge output/);
    assert.doesNotMatch(requestBodyText, /second huge output/);
    const requestInput = responseInput(JSON.parse(requestBodyText) as unknown);
    const outputItems = requestInput.filter(
        (item) => isRecord(item) && item.type === "function_call_output",
    );
    assert.equal(outputItems.length, 2);
    assert.deepEqual(
        outputItems.map((item) => (isRecord(item) ? item.output : undefined)),
        ["[truncated]", "[truncated]"],
    );
});

test("falls back instead of trimming oversized semantic input", async () => {
    let requestBody: unknown;
    const runtime = makeTestRuntime(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-trimmed"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_trimmed","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry("old", null, userMessage(`old ${"x ".repeat(6_000)}`)),
                messageEntry("recent", "old", userMessage("please keep working")),
            ],
            firstKeptEntryId: "old",
        }),
        makeNativeCompactionContext({ contextWindow: 700 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(requestBody, undefined);
    assert.equal(result, undefined);
});

test("does not send remote v2 compaction when protected input cannot fit", async () => {
    let fetchCalls = 0;
    const runtime = makeTestRuntime(async () => {
        fetchCalls += 1;
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"should-not-send"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_too_large","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry(
                    "assistant-huge-call",
                    null,
                    assistantMessage([
                        {
                            type: "toolCall",
                            id: "call/huge|item/huge",
                            name: "read",
                            arguments: { path: `${"huge/".repeat(8_000)}file.txt` },
                        },
                    ]),
                ),
            ],
            firstKeptEntryId: "assistant-huge-call",
        }),
        makeNativeCompactionContext({ contextWindow: 180 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(fetchCalls, 0);
    assert.equal(result, undefined);
});

test("retained image-only messages preserve their image content", async () => {
    const runtime = makeTestRuntime(async () => {
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-images"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_images","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const branchEntries = Array.from({ length: 80 }, (_unused, index) =>
        messageEntry(
            `image-${index}`,
            index === 0 ? null : `image-${index - 1}`,
            imageOnlyUserMessage(index),
        ),
    );
    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({ branchEntries, firstKeptEntryId: "image-79" }),
        makeNativeCompactionContext(),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    const compactedWindow = result?.compaction?.details.compactedWindow ?? [];
    const retainedImageUrls = compactedWindow.flatMap(imageUrlsFromResponseItem);
    assert.equal(retainedImageUrls.length, 80);
});

test("retained native compaction window truncates huge text and preserves its image", async () => {
    const hugeText = `retained-start ${"x ".repeat(90_000)}retained-end`;
    const runtime = makeTestRuntime(async () => {
        const body = [
            "event: response.output_item.done",
            'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed-retained-truncated"}}',
            "",
            "event: response.completed",
            'data: {"type":"response.completed","response":{"id":"resp_retained_truncated","created_at":123}}',
            "",
        ].join("\n");
        return new Response(body, { status: 200 });
    });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: [
                messageEntry("retained", null, {
                    role: "user",
                    content: [
                        { type: "text", text: hugeText },
                        {
                            type: "image",
                            mimeType: "image/png",
                            data: Buffer.from("retained-image").toString("base64"),
                        },
                    ],
                    timestamp: 0,
                }),
            ],
            firstKeptEntryId: "retained",
        }),
        makeNativeCompactionContext({ contextWindow: 300_000 }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    const compactedWindow = result?.compaction?.details.compactedWindow ?? [];
    assert.deepEqual(compactedWindow.at(-1), {
        type: "compaction",
        encrypted_content: "sealed-retained-truncated",
    });
    const retainedItem = compactedWindow.find((item) => isRecord(item) && item.role === "user");
    assert.ok(retainedItem);
    const retainedText = textFromResponseItem(retainedItem);
    assert.match(retainedText, /^retained-start/);
    assert.match(retainedText, /retained-end$/);
    assert.ok(retainedText.length < hugeText.length);
    assert.equal(imageUrlsFromResponseItem(retainedItem).length, 1);
});

test("does not replay a native checkpoint superseded by Pi compaction", async () => {
    const runtime = makeTestRuntime(async () => new Response("limit", { status: 429 }));
    const branchEntries = [
        nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
        messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
        {
            type: "compaction",
            id: "compact-pi",
            parentId: "entry-tail",
            timestamp: "2026-01-01T00:00:01.000Z",
            summary: "Pi fallback summary of the live tail",
            firstKeptEntryId: "entry-tail",
            tokensBefore: 100,
        },
    ];
    const ctx = makeNativeCompactionContext({ branchEntries });

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries: branchEntries.slice(0, 2),
            firstKeptEntryId: "entry-tail",
        }),
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );
    assert.equal(result, undefined);

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        {
            model: "gpt-5.5",
            instructions: "compact this conversation",
            input: [
                { role: "developer", content: "summarize compact" },
                {
                    role: "user",
                    content: [{ type: "input_text", text: "<conversation>tail</conversation>" }],
                },
            ],
        },
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
        runtime,
    );

    assert.equal(rewritten, undefined);
});

test("keeps native fallback replay isolated by session branch", async () => {
    const runtime = makeTestRuntime(async () => new Response("limit", { status: 429 }));
    const branchEntries = [
        nativeCompactionEntry({ id: "compact-1", firstKeptEntryId: "entry-old" }),
        messageEntry("entry-tail", "compact-1", userMessage("new live tail")),
    ];
    const sessionA = makeNativeCompactionContext({ sessionId: "session-a", branchEntries });
    const sessionB = makeNativeCompactionContext({ sessionId: "session-b" });
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
    };

    const result = await handleCodexNativeCompaction(
        makeBeforeCompactEvent({
            branchEntries,
            firstKeptEntryId: "entry-tail",
        }),
        sessionA,
        config,
        makeCompactionApi(),
        runtime,
    );
    assert.equal(result, undefined);

    const fallbackPayload = {
        model: "gpt-5.5",
        instructions: "compact this conversation",
        input: [
            { role: "developer", content: "summarize compact" },
            {
                role: "user",
                content: [{ type: "input_text", text: "<conversation>tail</conversation>" }],
            },
        ],
    };

    const sessionBRewrite = await rewriteProviderRequestWithNativeCompaction(
        fallbackPayload,
        sessionB,
        config,
        makeCompactionApi(),
        runtime,
    );
    assert.equal(sessionBRewrite, undefined);

    const sessionARewrite = await rewriteProviderRequestWithNativeCompaction(
        fallbackPayload,
        sessionA,
        config,
        makeCompactionApi(),
        runtime,
    );
    const rewrittenInput = responseInput(sessionARewrite);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "summarize compact" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
});

test("skips provider payload parsing when no native compaction state exists", async () => {
    cancelScheduledCodexAutoCompaction();
    const payload = { model: "gpt-5.4-mini" };
    Object.defineProperty(payload, "input", {
        get() {
            throw new Error("provider payload should not be parsed");
        },
    });

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        makeCompactionContext({ branchEntries: [] }),
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    assert.equal(rewritten, undefined);
});

test("native replay matching does not JSON-stringify provider items", async () => {
    const ctx = makeCompactionContext();
    const poisonReplayItem = {
        role: "user",
        content: [{ type: "input_text", text: "inserted context" }],
        toJSON() {
            throw new Error("provider item should not be JSON-stringified");
        },
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        {
            model: "gpt-5.4-mini",
            input: [
                { role: "developer", content: "system" },
                {
                    role: "user",
                    content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
                },
                poisonReplayItem,
                { role: "user", content: [{ type: "input_text", text: "pre kept" }] },
                { role: "user", content: [{ type: "input_text", text: "post tail" }] },
            ],
        },
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    const rewrittenText = rewrittenInput.map(textFromResponseItem).join("\n");
    assert.match(rewrittenText, /inserted context/);
    assert.doesNotMatch(rewrittenText, /pre kept/);
});

test("auto compaction defers until Pi is idle after agent_end", async () => {
    const compactCalls: unknown[] = [];
    const idle = { value: false };
    const ctx = makeAutoCompactionContext(compactCalls, idle);
    const scheduledTasks: Array<() => void> = [];
    const runtime = {
        ...makeTestRuntime(),
        scheduler: {
            set(_delayMs: number, task: () => void): ScheduledTask {
                scheduledTasks.push(task);
                return { cancel() {} };
            },
        },
    } satisfies CodexRuntime;
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: {
            ...DEFAULT_CODEX_CORE_CONFIG.compaction,
            enabled: true,
            auto: true,
            thresholdPercent: DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
        },
    };

    assert.equal(scheduleCodexAutoCompaction(ctx, config, runtime), true);
    assert.equal(compactCalls.length, 0);
    scheduledTasks.shift()?.();
    assert.equal(compactCalls.length, 0);
    idle.value = true;
    assert.equal(scheduleCodexAutoCompaction(ctx, config, runtime), true);
    scheduledTasks.shift()?.();
    assert.equal(compactCalls.length, 1);
    assert.equal(scheduleCodexAutoCompaction(ctx, config, runtime), true);
    scheduledTasks.shift()?.();
    assert.equal(compactCalls.length, 1);
});

test("auto compaction ignores stale session contexts", () => {
    const compactCalls: unknown[] = [];
    const ctx = makeAutoCompactionContext(
        compactCalls,
        { value: true },
        {
            sessionId: "stale-auto-session",
        },
    );
    const scheduledTasks: Array<() => void> = [];
    const runtime = {
        ...makeTestRuntime(),
        scheduler: {
            set(_delayMs: number, task: () => void): ScheduledTask {
                scheduledTasks.push(task);
                return { cancel() {} };
            },
        },
    } satisfies CodexRuntime;
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true, auto: true },
    };

    assert.equal(scheduleCodexAutoCompaction(ctx, config, runtime), true);
    // SAFETY: Simulates Pi invalidating an extension context during a session switch.
    (ctx as unknown as { isIdle: () => boolean }).isIdle = () => {
        throw new Error("Extension context is stale");
    };

    assert.doesNotThrow(() => scheduledTasks.shift()?.());
    assert.equal(compactCalls.length, 0);
});

test("uses GPT-5.6 effective context for auto compaction", () => {
    const compactCalls: unknown[] = [];
    const usage = { tokens: 230_000 };
    const ctx = makeAutoCompactionContext(
        compactCalls,
        { value: true },
        {
            modelId: "gpt-5.6-sol",
            sessionId: "auto-session-gpt-5.6",
            usageTokens: () => usage.tokens,
        },
    );
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: {
            ...DEFAULT_CODEX_CORE_CONFIG.compaction,
            enabled: true,
            thresholdPercent: 80,
        },
    };

    assert.equal(maybeTriggerCodexAutoCompaction(ctx, config), false);
    usage.tokens = 300_000;
    assert.equal(maybeTriggerCodexAutoCompaction(ctx, config), true);
    assert.equal(compactCalls.length, 1);
    cancelScheduledCodexAutoCompaction();
});

test("auto compaction retries immediately after branch progress", () => {
    const compactCalls: unknown[] = [];
    let latestEntryId = "entry-a";
    const ctx = makeAutoCompactionContext(
        compactCalls,
        { value: true },
        {
            sessionId: "auto-retry-session",
            latestEntryId: () => latestEntryId,
        },
    );
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true, auto: true },
    };

    assert.equal(maybeTriggerCodexAutoCompaction(ctx, config), true);
    latestEntryId = "entry-b";
    assert.equal(maybeTriggerCodexAutoCompaction(ctx, config), true);
    assert.equal(compactCalls.length, 2);
    cancelScheduledCodexAutoCompaction();
});

test("auto compaction skips interrupted assistant turns", async () => {
    const compactCalls: unknown[] = [];
    const idle = { value: true };
    const ctx = makeAutoCompactionContext(compactCalls, idle);
    const scheduledTasks: Array<() => void> = [];
    const runtime = {
        ...makeTestRuntime(),
        scheduler: {
            set(_delayMs: number, task: () => void): ScheduledTask {
                scheduledTasks.push(task);
                return { cancel() {} };
            },
        },
    } satisfies CodexRuntime;
    const config = {
        ...DEFAULT_CODEX_CORE_CONFIG,
        compaction: {
            ...DEFAULT_CODEX_CORE_CONFIG.compaction,
            enabled: true,
            auto: true,
            thresholdPercent: DEFAULT_CODEX_CORE_CONFIG.compaction.thresholdPercent,
        },
    };

    assert.equal(
        scheduleCodexAutoCompaction(ctx, config, runtime, {
            completedMessages: [{ role: "assistant", stopReason: "error" }],
        }),
        false,
    );
    assert.equal(scheduledTasks.length, 0);
    assert.equal(compactCalls.length, 0);
    assert.equal(
        scheduleCodexAutoCompaction(ctx, config, runtime, {
            completedMessages: [{ role: "assistant", stopReason: "aborted" }],
        }),
        false,
    );
    cancelScheduledCodexAutoCompaction();
});

test("rewrites responses payload with native compaction replay matching", async () => {
    const ctx = makeCompactionContext();
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            { role: "user", content: [{ type: "input_text", text: "pre kept" }] },
            { role: "user", content: [{ type: "input_text", text: "post tail" }] },
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.match(worldStateText(rewrittenInput[2]), /<codex_core_world_state>/);
    assert.match(worldStateText(rewrittenInput[2]), /window: 1/);
    assert.deepEqual(rewrittenInput.slice(3), [
        { role: "user", content: [{ type: "input_text", text: "post tail" }] },
        { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
    ]);
});

test("rewrites native compaction replay in long payloads", async () => {
    const keptEntries = Array.from({ length: 80 }, (_unused, index) =>
        messageEntry(
            `pre-${index}`,
            index === 0 ? null : `pre-${index - 1}`,
            userMessage(`pre kept ${index}`),
        ),
    );
    const branchEntries = [
        ...keptEntries,
        nativeCompactionEntry({
            id: "compact-long",
            parentId: "pre-79",
            firstKeptEntryId: "pre-0",
            model: "gpt-5.4-mini",
        }),
        messageEntry("tail", "compact-long", userMessage("post tail")),
    ];
    const ctx = makeCompactionContext({ branchEntries });
    const filler = Array.from({ length: 120 }, (_unused, index) => ({
        role: "user",
        content: [{ type: "input_text", text: `inserted context ${index}` }],
    }));
    const keptReplay = keptEntries.map((_entry, index) => ({
        role: "user",
        content: [{ type: "input_text", text: `pre kept ${index}` }],
    }));
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            ...filler,
            ...keptReplay,
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.doesNotMatch(JSON.stringify(rewrittenInput), /pre kept 0/);
    assert.match(JSON.stringify(rewrittenInput), /inserted context 119/);
});

test("leaves a newer Pi fallback summary authoritative", async () => {
    const branchEntries = [
        messageEntry("entry-old", null, userMessage("old context")),
        nativeCompactionEntry({ id: "compact-native", firstKeptEntryId: "entry-old" }),
        messageEntry("entry-tail", "compact-native", userMessage("new context")),
        {
            type: "compaction",
            id: "compact-pi",
            parentId: "entry-tail",
            timestamp: "2026-01-01T00:00:01.000Z",
            summary: "Fresh Pi fallback summary",
            firstKeptEntryId: "entry-tail",
            tokensBefore: 100,
        },
    ];
    const ctx = makeCompactionContext({
        branchEntries,
        sessionId: "pi-fallback-barrier-session",
    });
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            { role: "user", content: "Fresh Pi fallback summary" },
            { role: "user", content: "current turn" },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    assert.equal(rewritten, undefined);
});

test("handles native replay fallback mismatch silently", async () => {
    const warnings: string[] = [];
    const ctx = makeCompactionContext({ warnings, sessionId: "mismatch-session" });
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            { role: "user", content: [{ type: "input_text", text: "different replay" }] },
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );
    await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    assert.deepEqual(warnings, []);
});

test("rewrites native compaction replay when new-session context is inserted", async () => {
    const ctx = makeCompactionContext();
    const environmentContext = {
        role: "user",
        content: [
            {
                type: "input_text",
                text: "<environment_context>\ncwd: /workspace\n</environment_context>",
            },
        ],
    };
    const payload = {
        model: "gpt-5.4-mini",
        input: [
            { role: "developer", content: "system" },
            {
                role: "user",
                content: [{ type: "input_text", text: NATIVE_COMPACTION_SHIM_SUMMARY }],
            },
            environmentContext,
            { role: "user", content: [{ type: "input_text", text: "pre kept" }] },
            { role: "user", content: [{ type: "input_text", text: "post tail" }] },
            { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
        ],
    };

    const rewritten = await rewriteProviderRequestWithNativeCompaction(
        payload,
        ctx,
        {
            ...DEFAULT_CODEX_CORE_CONFIG,
            compaction: { ...DEFAULT_CODEX_CORE_CONFIG.compaction, enabled: true },
        },
        makeCompactionApi(),
    );

    const rewrittenInput = responseInput(rewritten);
    assert.deepEqual(rewrittenInput.slice(0, 2), [
        { role: "developer", content: "system" },
        { type: "compaction", encrypted_content: "opaque" },
    ]);
    assert.match(worldStateText(rewrittenInput[2]), /<codex_core_world_state>/);
    assert.deepEqual(rewrittenInput.slice(3), [
        environmentContext,
        { role: "user", content: [{ type: "input_text", text: "post tail" }] },
        { role: "user", content: [{ type: "input_text", text: "current payload tail" }] },
    ]);
});

function makeBeforeCompactEvent(
    options: {
        readonly branchEntries?: readonly unknown[];
        readonly firstKeptEntryId?: string;
        readonly reason?: SessionBeforeCompactEvent["reason"];
        readonly previousSummary?: string;
        readonly messagesToSummarize?: readonly unknown[];
        readonly turnPrefixMessages?: readonly unknown[];
    } = {},
): SessionBeforeCompactEvent {
    const branchEntries = options.branchEntries ?? [
        messageEntry("entry-1", null, userMessage("keep this request")),
    ];
    const firstKeptEntryId = options.firstKeptEntryId ?? "entry-1";
    const firstKeptEntryIndex = branchEntries.findIndex(
        (entry) => isRecord(entry) && entry.id === firstKeptEntryId,
    );
    const derivedMessagesToSummarize = branchEntries
        .slice(0, Math.max(0, firstKeptEntryIndex))
        .flatMap((entry) =>
            isRecord(entry) && entry.type === "message" && isRecord(entry.message)
                ? [entry.message]
                : [],
        );
    const event = {
        type: "session_before_compact",
        branchEntries,
        preparation: {
            firstKeptEntryId,
            messagesToSummarize: options.messagesToSummarize ?? derivedMessagesToSummarize,
            turnPrefixMessages: options.turnPrefixMessages ?? [],
            isSplitTurn: false,
            tokensBefore: 123,
            fileOps: {
                read: new Set<string>(),
                written: new Set<string>(),
                edited: new Set<string>(),
            },
            settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
            ...(options.previousSummary !== undefined
                ? { previousSummary: options.previousSummary }
                : {}),
        },
        reason: options.reason ?? "manual",
        willRetry: false,
        signal: new AbortController().signal,
    };
    // SAFETY: This fixture supplies the fields read by handleCodexNativeCompaction.
    return event as unknown as SessionBeforeCompactEvent;
}

function nativeCompactionEntry(options: {
    readonly id: string;
    readonly parentId?: string | null;
    readonly firstKeptEntryId: string;
    readonly model?: string;
}): Record<string, unknown> {
    const worldState = worldStateInput("window: 1");
    return {
        type: "compaction",
        id: options.id,
        parentId: options.parentId ?? null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: NATIVE_COMPACTION_SHIM_SUMMARY,
        firstKeptEntryId: options.firstKeptEntryId,
        tokensBefore: 123,
        details: {
            strategy: "pi-codex-core-remote-compaction-v2",
            provider: "openai-codex",
            api: "openai-codex-responses",
            model: options.model ?? "gpt-5.5",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            compactedWindow: [{ type: "compaction", encrypted_content: "opaque" }],
            replacementInput: [{ type: "compaction", encrypted_content: "opaque" }, worldState],
            windowNumber: 1,
            windowId: "window-1",
            firstWindowId: "window-1",
            worldState: {
                cwd: "/workspace",
                model: `openai-codex/${options.model ?? "gpt-5.5"}`,
                activeToolNames: ["read"],
                readFiles: [],
                modifiedFiles: [],
                capturedAt: "2026-01-01T00:00:00.000Z",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
        },
    };
}

function worldStateInput(extraLine = ""): Record<string, unknown> {
    return {
        role: "user",
        content: [
            {
                type: "input_text",
                text: [
                    "<codex_core_world_state>",
                    "Fresh Pi context after Codex native compaction.",
                    "cwd: /workspace",
                    "model: openai-codex/gpt-5.5",
                    "active tools: read",
                    extraLine,
                    "</codex_core_world_state>",
                ]
                    .filter(Boolean)
                    .join("\n"),
            },
        ],
    };
}

function userMessage(text: string): Record<string, unknown> {
    return { role: "user", content: text, timestamp: 0 };
}

function imageOnlyUserMessage(index: number): Record<string, unknown> {
    return {
        role: "user",
        content: [
            {
                type: "image",
                mimeType: "image/png",
                data: Buffer.from(`image-${index}`).toString("base64"),
            },
        ],
        timestamp: 0,
    };
}

function imageUrlsFromResponseItem(item: unknown): string[] {
    if (!isRecord(item) || !Array.isArray(item.content)) return [];
    return item.content.flatMap((part) =>
        isRecord(part) && part.type === "input_image" && typeof part.image_url === "string"
            ? [part.image_url]
            : [],
    );
}

function assistantMessage(content: readonly unknown[]): Record<string, unknown> {
    return {
        role: "assistant",
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: "gpt-5.5",
        content,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "toolUse",
        timestamp: 0,
    };
}

function toolResultMessage(toolCallId: string, text: string): Record<string, unknown> {
    return {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: false,
        timestamp: 0,
    };
}

function makeCodexJwtAccountToken(accountId: string): string {
    const payload = Buffer.from(
        JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        }),
    ).toString("base64url");
    return `header.${payload}.signature`;
}

function makeCompactionApi(): ExtensionAPI {
    const api = {
        getActiveTools: () => ["read"],
        getAllTools: () => [
            {
                name: "read",
                description: "Read a file.",
                parameters: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: ["path"],
                },
                promptGuidelines: [],
                sourceInfo: { type: "extension", name: "test" },
            },
            {
                name: "write",
                description: "Write a file.",
                parameters: { type: "object", properties: {} },
                promptGuidelines: [],
                sourceInfo: { type: "extension", name: "test" },
            },
        ],
    };
    // SAFETY: Compaction tests only exercise getActiveTools and getAllTools.
    return api as unknown as ExtensionAPI;
}

function makeNativeCompactionContext(
    options: {
        readonly contextWindow?: number;
        readonly sessionId?: string;
        readonly modelId?: string;
        readonly branchEntries?: readonly Record<string, unknown>[];
    } = {},
): ExtensionContext {
    const modelId = options.modelId ?? "gpt-5.5";
    const ctx = {
        hasUI: false,
        cwd: "/workspace",
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: modelId,
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
            contextWindow: options.contextWindow ?? 200_000,
        },
        modelRegistry: {
            getApiKeyAndHeaders: async () => ({
                ok: true,
                apiKey: makeCodexJwtAccountToken("account"),
                headers: {},
            }),
            find: (_provider: string, requestedModelId: string) =>
                requestedModelId === modelId
                    ? {
                          provider: "openai-codex",
                          api: "openai-codex-responses",
                          id: modelId,
                          baseUrl: "https://chatgpt.com/backend-api",
                          input: ["text", "image"],
                          contextWindow: options.contextWindow ?? 200_000,
                      }
                    : undefined,
        },
        sessionManager: {
            getSessionId: () => options.sessionId ?? "session-1",
            getBranch: () => options.branchEntries ?? [],
        },
        getSystemPrompt: () => "system prompt",
    };
    // SAFETY: This test exercises a function that only reads these context fields.
    return ctx as unknown as ExtensionContext;
}

function makeAutoCompactionContext(
    compactCalls: unknown[],
    idle: { readonly value: boolean },
    options: {
        readonly modelId?: string;
        readonly sessionId?: string;
        readonly usageTokens?: () => number;
        readonly latestEntryId?: () => string;
    } = {},
): ExtensionContext {
    const contextWindow = 100;
    const ctx = {
        hasUI: false,
        cwd: "/workspace",
        isIdle: () => idle.value,
        model: options.modelId
            ? {
                  provider: "openai-codex",
                  api: "openai-codex-responses",
                  id: options.modelId,
              }
            : undefined,
        getContextUsage: () => {
            const tokens = options.usageTokens?.() ?? 90;
            return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
        },
        compact: (options: unknown) => {
            compactCalls.push(options);
            if (isRecord(options) && typeof options.onComplete === "function") {
                options.onComplete({ summary: "ok", firstKeptEntryId: "entry", tokensBefore: 90 });
            }
        },
        sessionManager: {
            getSessionId: () => options.sessionId ?? "auto-session-1",
            getBranch: () => [{ type: "message", id: options.latestEntryId?.() ?? "entry-auto" }],
        },
    };
    // SAFETY: This test exercises only fields read by scheduleCodexAutoCompaction.
    return ctx as unknown as ExtensionContext;
}

function makeCompactionContext(
    options: {
        readonly warnings?: string[];
        readonly sessionId?: string;
        readonly branchEntries?: readonly Record<string, unknown>[];
    } = {},
): ExtensionContext {
    const ctx = {
        hasUI: Boolean(options.warnings),
        ...(options.warnings
            ? {
                  ui: {
                      notify: (message: string) => {
                          options.warnings?.push(message);
                      },
                  },
              }
            : {}),
        cwd: "/workspace",
        model: {
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "gpt-5.4-mini",
            baseUrl: "https://chatgpt.com/backend-api",
            input: ["text", "image"],
            contextWindow: 200_000,
        },
        sessionManager: {
            getSessionId: () => options.sessionId ?? "session-1",
            getBranch: () =>
                options.branchEntries ?? [
                    messageEntry("pre", null, userMessage("pre kept")),
                    nativeCompactionEntry({
                        id: "compact",
                        parentId: "pre",
                        firstKeptEntryId: "pre",
                        model: "gpt-5.4-mini",
                    }),
                    messageEntry("tail", "compact", userMessage("post tail")),
                ],
        },
    };
    // SAFETY: This test exercises a function that only reads model, UI notification, and sessionManager fields.
    return ctx as unknown as ExtensionContext;
}

function responseInput(value: unknown): unknown[] {
    assert.ok(isRecord(value));
    assert.ok(Array.isArray(value.input));
    return value.input;
}

function worldStateText(item: unknown): string {
    if (!isRecord(item) || !Array.isArray(item.content)) return "";
    return item.content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n");
}

function textFromResponseItem(item: unknown): string {
    if (!isRecord(item)) return "";
    if (typeof item.content === "string") return item.content;
    if (!Array.isArray(item.content)) return "";
    return item.content
        .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
        .join("\n");
}
