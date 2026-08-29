import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { DEFAULT_CODEX_CORE_CONFIG, type CodexCoreConfig } from "../src/config/config.ts";
import { CodexRecoveryCoordinator, isTransientCodexFailure } from "../src/recovery/coordinator.ts";
import type { ScheduledTask, Scheduler } from "../src/runtime.ts";
import { testDouble } from "./helpers.ts";

test("classifies transient provider failures without retrying terminal failures", () => {
    assert.equal(isTransientCodexFailure(errorMessage("WebSocket error")), true);
    assert.equal(
        isTransientCodexFailure(
            errorMessage(
                "Codex error: Our servers are currently overloaded. Please try again later.",
            ),
        ),
        true,
    );
    assert.equal(
        isTransientCodexFailure(errorMessage("You have hit your ChatGPT usage limit")),
        false,
    );
    assert.equal(isTransientCodexFailure(errorMessage("Operation aborted")), false);
});

test("batches held follow-ups into one request after a successful turn", () => {
    const fixture = makeRecoveryFixture();
    fixture.coordinator.start(fixture.api, fixture.ctx);
    fixture.coordinator.queueFollowUp(fixture.api, fixture.ctx, "Second constraint");
    fixture.coordinator.queueFollowUp(fixture.api, fixture.ctx, "Third constraint");
    fixture.coordinator.observeAssistant(successMessage());

    fixture.coordinator.settle(fixture.api, fixture.ctx);

    assert.deepEqual(fixture.scheduler.delays, [0]);
    fixture.scheduler.runNext();
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0] ?? "", /1\. Second constraint/);
    assert.match(fixture.sent[0] ?? "", /2\. Third constraint/);
});

test("resumes an interrupted Codex turn after a bounded outage cooldown", () => {
    const fixture = makeRecoveryFixture();
    fixture.coordinator.start(fixture.api, fixture.ctx);
    fixture.coordinator.queueFollowUp(fixture.api, fixture.ctx, "Keep edits out of src/cli.ts");
    fixture.coordinator.observeAssistant(errorMessage("WebSocket error"));

    fixture.coordinator.settle(fixture.api, fixture.ctx);

    assert.deepEqual(fixture.scheduler.delays, [30_000]);
    assert.match(fixture.notifications.at(-1)?.message ?? "", /recovery 1\/3/);
    fixture.scheduler.runNext();
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0] ?? "", /Continue the interrupted task/);
    assert.match(fixture.sent[0] ?? "", /Keep edits out of src\/cli\.ts/);
});

test("stops automatic recovery after the configured extension retry budget", () => {
    const fixture = makeRecoveryFixture({
        ...DEFAULT_CODEX_CORE_CONFIG,
        recovery: { ...DEFAULT_CODEX_CORE_CONFIG.recovery, maxAttempts: 1 },
    });
    fixture.coordinator.start(fixture.api, fixture.ctx);
    fixture.coordinator.observeAssistant(errorMessage("server overloaded"));
    fixture.coordinator.settle(fixture.api, fixture.ctx);
    fixture.scheduler.runNext();
    fixture.coordinator.observeAssistant(errorMessage("server overloaded"));

    fixture.coordinator.settle(fixture.api, fixture.ctx);

    assert.deepEqual(fixture.scheduler.delays, [30_000]);
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.notifications.at(-1)?.message ?? "", /stopped after 1 attempt/);
});

test("does not inject recovery into a new active turn", () => {
    const fixture = makeRecoveryFixture();
    fixture.coordinator.start(fixture.api, fixture.ctx);
    fixture.coordinator.queueFollowUp(fixture.api, fixture.ctx, "Held update");
    fixture.coordinator.observeAssistant(errorMessage("service unavailable"));
    fixture.coordinator.settle(fixture.api, fixture.ctx);
    fixture.setIdle(false);

    fixture.scheduler.runNext();

    assert.deepEqual(fixture.sent, []);
    fixture.setIdle(true);
    fixture.coordinator.observeAssistant(successMessage());
    fixture.coordinator.settle(fixture.api, fixture.ctx);
    fixture.scheduler.runNext();
    assert.match(fixture.sent[0] ?? "", /Held update/);
});

test("manual input cancels delayed recovery and includes held follow-ups", () => {
    const fixture = makeRecoveryFixture();
    fixture.coordinator.start(fixture.api, fixture.ctx);
    fixture.coordinator.queueFollowUp(fixture.api, fixture.ctx, "Earlier update");
    fixture.coordinator.observeAssistant(errorMessage("service unavailable"));
    fixture.coordinator.settle(fixture.api, fixture.ctx);

    const transformed = fixture.coordinator.mergePendingIntoManualInput(
        fixture.api,
        "Latest instruction",
    );

    assert.equal(fixture.scheduler.cancelled, 1);
    assert.match(transformed ?? "", /Earlier update/);
    assert.match(transformed ?? "", /Latest user message:\n\nLatest instruction/);
});

type RecoveryFixture = {
    readonly coordinator: CodexRecoveryCoordinator;
    readonly api: ExtensionAPI;
    readonly ctx: ExtensionContext;
    readonly scheduler: TestScheduler;
    readonly sent: string[];
    readonly notifications: Array<{ readonly message: string; readonly type: string }>;
    readonly setIdle: (idle: boolean) => void;
};

function makeRecoveryFixture(config: CodexCoreConfig = DEFAULT_CODEX_CORE_CONFIG): RecoveryFixture {
    const scheduler = new TestScheduler();
    const sent: string[] = [];
    const entries: SessionEntry[] = [];
    const notifications: Array<{ readonly message: string; readonly type: string }> = [];
    let idle = true;
    const api = {
        appendEntry<Data>(customType: string, data: Data) {
            entries.push({
                type: "custom",
                id: `entry-${entries.length + 1}`,
                parentId: entries.at(-1)?.id ?? null,
                timestamp: new Date(0).toISOString(),
                customType,
                data,
            });
        },
        sendUserMessage(content: string) {
            sent.push(content);
        },
    };
    const ctx = {
        hasUI: true,
        ui: {
            notify(message: string, type: string) {
                notifications.push({ message, type });
            },
        },
        isIdle: () => idle,
        sessionManager: { getBranch: () => entries },
    };
    return {
        coordinator: new CodexRecoveryCoordinator({
            getConfig: () => config,
            scheduler,
            nowMs: () => 1_000,
        }),
        api: testDouble<ExtensionAPI>()(api),
        ctx: testDouble<ExtensionContext>()(ctx),
        scheduler,
        sent,
        notifications,
        setIdle(nextIdle: boolean) {
            idle = nextIdle;
        },
    };
}

class TestScheduler implements Scheduler {
    readonly delays: number[] = [];
    cancelled = 0;
    private readonly tasks: Array<{ cancelled: boolean; readonly run: () => void }> = [];

    set(delayMs: number, task: () => void): ScheduledTask {
        this.delays.push(delayMs);
        const scheduled = { cancelled: false, run: task };
        this.tasks.push(scheduled);
        return {
            cancel: () => {
                if (scheduled.cancelled) return;
                scheduled.cancelled = true;
                this.cancelled += 1;
            },
        };
    }

    runNext(): void {
        const scheduled = this.tasks.shift();
        assert.ok(scheduled);
        if (!scheduled.cancelled) scheduled.run();
    }
}

function errorMessage(error: string): AssistantMessage {
    return assistantMessage("error", error);
}

function successMessage(): AssistantMessage {
    return assistantMessage("stop");
}

type AssistantMessageConstruction = {
    -readonly [Key in keyof AssistantMessage]: AssistantMessage[Key];
};

function assistantMessage(
    stopReason: AssistantMessage["stopReason"],
    errorMessage?: string,
): AssistantMessage {
    const message: AssistantMessageConstruction = {
        role: "assistant",
        content: [],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: 0,
    };
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
    return message;
}
