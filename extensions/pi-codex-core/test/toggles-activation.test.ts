import { createEventBus } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "vitest";
import { JsonObjectDecoder, JsonStringDecoder } from "../src/compaction/responses-input.ts";
import {
    OptionalTogglesActivation,
    type ToolActivationDecision,
} from "../src/toggles-activation.ts";

const READY_EVENT = "pi-toggles:activation-ready";
const PROPOSAL_EVENT = "pi-toggles:set-activation-proposal";
const ACCEPTED_EVENT = "pi-toggles:activation-proposal-accepted";

const decisions: readonly ToolActivationDecision[] = [
    { target: { kind: "tool", name: "apply_patch" }, state: "on" },
    { target: { kind: "tool", name: "edit" }, state: "off" },
];

test("keeps standalone activation when Pi Toggles is absent", () => {
    const coordination = new OptionalTogglesActivation(createEventBus(), "pi-codex-core");
    assert.equal(coordination.update("session-1", decisions), "standalone");
    coordination.dispose();
});

test("delegates when Pi Toggles becomes ready before the extension session handler", () => {
    const events = createEventBus();
    const proposals: unknown[] = [];
    events.on(PROPOSAL_EVENT, (value) => {
        proposals.push(value);
        events.emit(ACCEPTED_EVENT, {
            version: 1,
            sessionId: "session-1",
            owner: "pi-codex-core",
        });
    });
    const coordination = new OptionalTogglesActivation(events, "pi-codex-core");

    events.emit(READY_EVENT, { version: 1, sessionId: "session-1" });

    assert.equal(coordination.update("session-1", decisions), "delegated");
    assert.deepEqual(proposals, [
        {
            version: 1,
            sessionId: "session-1",
            owner: "pi-codex-core",
            decisions,
        },
    ]);
    coordination.dispose();
});

test("switches from standalone to delegated after a later ready handshake", () => {
    const events = createEventBus();
    events.on(PROPOSAL_EVENT, () => {
        events.emit(ACCEPTED_EVENT, {
            version: 1,
            sessionId: "session-1",
            owner: "pi-codex-core",
        });
    });
    const coordination = new OptionalTogglesActivation(events, "pi-codex-core");

    assert.equal(coordination.update("session-1", decisions), "standalone");
    events.emit(READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.equal(coordination.update("session-1", decisions), "delegated");

    const updated: readonly ToolActivationDecision[] = [
        { target: { kind: "tool", name: "apply_patch" }, state: "off" },
        { target: { kind: "tool", name: "edit" }, state: "on" },
    ];
    assert.equal(coordination.update("session-1", updated), "delegated");
    coordination.dispose();
});

test("requires a fresh handshake after the session changes", () => {
    const events = createEventBus();
    events.on(PROPOSAL_EVENT, (value) => {
        const sessionId = JsonStringDecoder.decode(JsonObjectDecoder.decode(value)?.sessionId);
        if (sessionId === undefined) return;
        events.emit(ACCEPTED_EVENT, {
            version: 1,
            sessionId,
            owner: "pi-codex-core",
        });
    });
    const coordination = new OptionalTogglesActivation(events, "pi-codex-core");

    events.emit(READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.equal(coordination.update("session-1", decisions), "delegated");
    assert.equal(coordination.update("session-2", decisions), "standalone");
    events.emit(READY_EVENT, { version: 1, sessionId: "session-2" });
    assert.equal(coordination.update("session-2", decisions), "delegated");
    coordination.dispose();
});

test("stops responding to coordination events after disposal", () => {
    const events = createEventBus();
    let proposalCount = 0;
    events.on(PROPOSAL_EVENT, () => {
        proposalCount += 1;
    });
    const coordination = new OptionalTogglesActivation(events, "pi-codex-core");
    coordination.update("session-1", decisions);
    coordination.dispose();

    events.emit(READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.equal(proposalCount, 0);
});

test("ignores acknowledgements for another owner or session", () => {
    const events = createEventBus();
    events.on(PROPOSAL_EVENT, () => {
        events.emit(ACCEPTED_EVENT, {
            version: 1,
            sessionId: "other-session",
            owner: "pi-codex-core",
        });
        events.emit(ACCEPTED_EVENT, {
            version: 1,
            sessionId: "session-1",
            owner: "other-extension",
        });
    });
    const coordination = new OptionalTogglesActivation(events, "pi-codex-core");
    events.emit(READY_EVENT, { version: 1, sessionId: "session-1" });

    assert.equal(coordination.update("session-1", decisions), "standalone");
    coordination.dispose();
});
