import assert from "node:assert/strict";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { installPreserveCompactionHistoryPatch } from "../src/preserve-compaction-history.ts";
import { captureConsoleWarnings } from "./capture-console-warnings.ts";

type CompactionEventFixture = {
    readonly aborted?: boolean;
    readonly result?: object;
    readonly type: string;
};

class FakeInteractiveMode {
    clearCount = 0;
    rebuildCount = 0;
    summaryCount = 0;

    chatContainer = {
        clear: () => {
            this.clearCount += 1;
        },
    };

    async handleEvent(event: CompactionEventFixture): Promise<void> {
        if (event.type === "compaction_end" && event.result !== undefined) {
            this.chatContainer.clear();
            this.rebuildChatFromMessages();
            this.summaryCount += 1;
        }
    }

    rebuildChatFromMessages(): void {
        this.rebuildCount += 1;
    }
}

test("explicit null does not patch Pi's default compaction handler", async () => {
    const warnings = await captureConsoleWarnings(() => {
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

    assert.deepEqual(warnings, [
        "[pi-ui-tweaks] preserve compaction history patch unavailable; Pi internals may have changed: missing handleEvent",
    ]);
});

test("preserve compaction history leaves successful live compaction UI intact", async () => {
    installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: true },
        FakeInteractiveMode.prototype,
    );

    const mode = new FakeInteractiveMode();
    await mode.handleEvent({ type: "compaction_end", aborted: false, result: {} });
    assert.equal(mode.clearCount, 0);
    assert.equal(mode.rebuildCount, 0);
    assert.equal(mode.summaryCount, 1);
    installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: false },
        FakeInteractiveMode.prototype,
    );
});

test("preserve compaction history keeps Pi's normal redraw when disabled", async () => {
    installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: false },
        FakeInteractiveMode.prototype,
    );

    const mode = new FakeInteractiveMode();
    await mode.handleEvent({ type: "compaction_end", aborted: false, result: {} });
    assert.equal(mode.clearCount, 1);
    assert.equal(mode.rebuildCount, 1);
    assert.equal(mode.summaryCount, 1);
    installPreserveCompactionHistoryPatch(
        { preserveCompactionHistory: false },
        FakeInteractiveMode.prototype,
    );
});
