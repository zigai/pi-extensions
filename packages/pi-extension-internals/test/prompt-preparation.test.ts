import { createEventBus } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
    prepareSystemPromptOptions,
    registerSystemPromptPreparation,
} from "../src/prompt-preparation.ts";

test("prompt preparation awaits providers in registration order with the mutable turn options", async () => {
    const events = createEventBus();
    const options = { cwd: "/workspace", selectedTools: ["read"] };
    const calls: string[] = [];
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const disposeFirst = registerSystemPromptPreparation(events, async (current) => {
        expect(current).toBe(options);
        calls.push("first started");
        await pending;
        current.selectedTools = ["write"];
        calls.push("first finished");
    });
    const disposeSecond = registerSystemPromptPreparation(events, async (current) => {
        expect(current.selectedTools).toEqual(["write"]);
        calls.push("second");
    });
    try {
        const operation = prepareSystemPromptOptions(events, options);
        expect(calls).toEqual(["first started"]);
        finish();
        await operation;
        expect(calls).toEqual(["first started", "first finished", "second"]);
    } finally {
        disposeFirst();
        disposeSecond();
    }
});

test("prompt preparation rejects without running later providers, and disposal permits recovery", async () => {
    const events = createEventBus();
    const cause = new Error("Synthetic preparation failure");
    let calls = 0;

    const disposeFailure = registerSystemPromptPreparation(events, async () => {
        throw cause;
    });
    const disposeNext = registerSystemPromptPreparation(events, async () => {
        calls += 1;
    });
    try {
        await expect(prepareSystemPromptOptions(events, { cwd: "/workspace" })).rejects.toBe(cause);
        expect(calls).toBe(0);
        disposeFailure();
        disposeFailure();
        await prepareSystemPromptOptions(events, { cwd: "/workspace" });
        expect(calls).toBe(1);
        disposeNext();
        await prepareSystemPromptOptions(events, { cwd: "/workspace" });
        expect(calls).toBe(1);
    } finally {
        disposeFailure();
        disposeNext();
    }
});

test("malformed preparation envelopes do not acquire providers", () => {
    const events = createEventBus();
    let accepted = 0;
    const accept = (): void => {
        accepted += 1;
    };

    const dispose = registerSystemPromptPreparation(events, async () => {});
    try {
        for (const query of [null, {}, { version: 2, accept }, { version: 1, accept: true }])
            events.emit("pi:system-prompt-preparation", query);

        expect(accepted).toBe(0);
        events.emit("pi:system-prompt-preparation", { version: 1, accept });
        expect(accepted).toBe(1);
    } finally {
        dispose();
    }
});
