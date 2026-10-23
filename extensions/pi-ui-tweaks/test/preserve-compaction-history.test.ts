import assert from "node:assert/strict";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { onTestFinished, test } from "vitest";

import { installPreserveCompactionHistoryPatch } from "../src/preserve-compaction-history.ts";
import { captureDiagnostics } from "./capture-diagnostics.ts";

type CompactionEventFixture = {
    readonly aborted?: boolean;
    readonly result?: object;
    readonly type: string;
};

class FakeInteractiveMode {
    clearCount = 0;
    rebuildCount = 0;
    renderEntriesCount = 0;
    summaryCount = 0;

    chatContainer = {
        clear: () => {
            this.clearCount += 1;
        },
    };

    async handleEvent(event: CompactionEventFixture): Promise<void> {
        if (event.type === "compaction_end" && event.result !== undefined) {
            this.chatContainer.clear();
            this.renderSessionEntries();
            this.summaryCount += 1;
        }
    }

    rebuildChatFromMessages = (): void => {
        this.rebuildCount += 1;
    };

    renderSessionEntries = (): void => {
        this.renderEntriesCount += 1;
    };
}

test("explicit null does not patch Pi's default compaction handler", async () => {
    const diagnostics = await captureDiagnostics(() => {
        const original = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "handleEvent");
        const handle = installPreserveCompactionHistoryPatch(
            { preserveCompactionHistory: true },
            null,
        );

        assert.deepEqual(
            Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "handleEvent"),
            original,
        );

        handle.dispose();
    });

    assert.deepEqual(diagnostics, [
        {
            message:
                "[pi-ui-tweaks] preserve compaction history patch unavailable; Pi internals may have changed: missing handleEvent",
            severity: "warning",
        },
    ]);
});

test("preserve compaction history leaves successful live compaction UI intact", async () => {
    const handle = installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: true },
        FakeInteractiveMode.prototype,
    );
    onTestFinished(() => handle.dispose());

    const mode = new FakeInteractiveMode();
    await mode.handleEvent({ type: "compaction_end", aborted: false, result: {} });
    assert.equal(mode.clearCount, 0);
    assert.equal(mode.rebuildCount, 0);
    assert.equal(mode.renderEntriesCount, 0);
    assert.equal(mode.summaryCount, 1);
});

test("preserve compaction history keeps Pi's normal redraw when disabled", async () => {
    const handle = installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: false },
        FakeInteractiveMode.prototype,
    );
    onTestFinished(() => handle.dispose());

    const mode = new FakeInteractiveMode();
    await mode.handleEvent({ type: "compaction_end", aborted: false, result: {} });
    assert.equal(mode.clearCount, 1);
    assert.equal(mode.rebuildCount, 0);
    assert.equal(mode.renderEntriesCount, 1);
    assert.equal(mode.summaryCount, 1);
});

test("repeated compactions do not replay retained rows and disposal restores rendering", async () => {
    const handle = installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: true },
        FakeInteractiveMode.prototype,
    );
    onTestFinished(() => handle.dispose());
    const mode = new FakeInteractiveMode();
    const originalClear = mode.chatContainer.clear;
    const originalRebuild = mode.rebuildChatFromMessages;
    const originalRenderEntries = mode.renderSessionEntries;

    for (let index = 0; index < 3; index += 1) {
        await mode.handleEvent({ type: "compaction_end", aborted: false, result: {} });
    }

    assert.equal(mode.clearCount, 0);
    assert.equal(mode.renderEntriesCount, 0);
    assert.equal(mode.summaryCount, 3);
    assert.equal(mode.chatContainer.clear, originalClear);
    assert.equal(mode.rebuildChatFromMessages, originalRebuild);
    assert.equal(mode.renderSessionEntries, originalRenderEntries);
    handle.dispose();
    handle.dispose();
    await mode.handleEvent({ type: "compaction_end", aborted: false, result: {} });
    assert.equal(mode.clearCount, 1);
    assert.equal(mode.renderEntriesCount, 1);
    assert.equal(mode.summaryCount, 4);
});

test("failed compaction UI handling restores all temporarily suppressed methods", async () => {
    class ThrowingInteractiveMode extends FakeInteractiveMode {
        override async handleEvent(event: CompactionEventFixture): Promise<void> {
            await super.handleEvent(event);
            throw new Error("synthetic UI failure");
        }
    }

    const handle = installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: true },
        ThrowingInteractiveMode.prototype,
    );
    onTestFinished(() => handle.dispose());
    const mode = new ThrowingInteractiveMode();
    const originalClear = mode.chatContainer.clear;
    const originalRebuild = mode.rebuildChatFromMessages;
    const originalRenderEntries = mode.renderSessionEntries;

    await assert.rejects(
        mode.handleEvent({ type: "compaction_end", aborted: false, result: {} }),
        /synthetic UI failure/u,
    );
    assert.equal(mode.chatContainer.clear, originalClear);
    assert.equal(mode.rebuildChatFromMessages, originalRebuild);
    assert.equal(mode.renderSessionEntries, originalRenderEntries);
    assert.equal(mode.renderEntriesCount, 0);
});
