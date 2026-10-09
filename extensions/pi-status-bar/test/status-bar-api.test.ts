import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";

import {
    configureStatusBar,
    getStatusBarSnapshot,
    registerStatusBarSegment,
    resetStatusBarStateForTests,
    setStatusBarBaseConfig,
    subscribeStatusBarUpdates,
} from "../src/status-bar-api.ts";

beforeEach(() => {
    resetStatusBarStateForTests();
});

test("configureStatusBar controls active and idle status bar state", () => {
    let updates = 0;
    const unsubscribe = subscribeStatusBarUpdates(() => {
        updates += 1;
    });

    const handle = configureStatusBar({
        active: {
            text: " Working\nnow ",
            spinner: { frames: [" ◐ ", "", "◓"] },
            timer: { visible: true, paused: false },
        },
        idle: {
            text: " Ready\tnow ",
            showLastRunSummary: false,
            showTokensPerSecond: false,
        },
    });

    assert.equal(updates, 1);
    assert.deepEqual(getStatusBarSnapshot().active, {
        text: "Working now",
        spinnerFrames: ["◐", "◓"],
        timerVisible: true,
        timerPaused: false,
        timerResetVersion: 0,
    });
    assert.deepEqual(getStatusBarSnapshot().idle, {
        text: "Ready now",
        visible: true,
        showLastRunSummary: false,
        showTokensPerSecond: false,
    });

    handle.pauseTimer();
    assert.equal(getStatusBarSnapshot().active.timerPaused, true);
    handle.resetTimer();
    assert.equal(getStatusBarSnapshot().active.timerResetVersion, 1);
    handle.hideTimer();
    assert.equal(getStatusBarSnapshot().active.timerVisible, false);
    handle.clear();
    assert.equal(getStatusBarSnapshot().active.text, undefined);
    assert.equal(getStatusBarSnapshot().active.timerVisible, true);
    assert.equal(getStatusBarSnapshot().idle.text, undefined);
    assert.equal(getStatusBarSnapshot().idle.showTokensPerSecond, true);
    unsubscribe();
});

test("status bar base config is overridden by public API and restored on dispose", () => {
    setStatusBarBaseConfig({
        active: { text: "Configured", timer: { visible: false } },
        idle: {
            text: "Configured idle",
            showLastRunSummary: false,
            showTokensPerSecond: false,
        },
    });

    assert.equal(getStatusBarSnapshot().active.text, "Configured");
    assert.equal(getStatusBarSnapshot().active.timerVisible, false);
    assert.equal(getStatusBarSnapshot().idle.text, "Configured idle");

    const handle = configureStatusBar({
        active: { text: "API", timer: { visible: true } },
        idle: { text: "API idle" },
    });

    assert.equal(getStatusBarSnapshot().active.text, "API");
    assert.equal(getStatusBarSnapshot().active.timerVisible, true);
    assert.equal(getStatusBarSnapshot().idle.text, "API idle");
    assert.equal(getStatusBarSnapshot().idle.showLastRunSummary, false);
    assert.equal(getStatusBarSnapshot().idle.showTokensPerSecond, false);
    handle.dispose();
    assert.equal(getStatusBarSnapshot().active.text, "Configured");
    assert.equal(getStatusBarSnapshot().active.timerVisible, false);
    assert.equal(getStatusBarSnapshot().idle.text, "Configured idle");
    assert.equal(getStatusBarSnapshot().idle.showTokensPerSecond, false);
});

test("registerStatusBarSegment owns namespaced active and idle segments", () => {
    const first = registerStatusBarSegment({
        id: "example.status",
        states: ["idle", "active", "idle"],
        text: " first ",
        priority: 20,
        dimmed: true,
    });
    const second = registerStatusBarSegment({
        id: "example.other",
        states: ["active"],
        text: "second",
        priority: 10,
    });

    assert.deepEqual(
        getStatusBarSnapshot().segments.map((segment) => segment.id),
        ["example.other", "example.status"],
    );
    assert.deepEqual(getStatusBarSnapshot().segments[1]?.states, ["idle", "active"]);
    assert.equal(getStatusBarSnapshot().segments[1]?.text, "first");
    first.setText("updated");
    assert.equal(getStatusBarSnapshot().segments[1]?.text, "updated");
    const replacement = registerStatusBarSegment({ id: "example.status", text: "replacement" });
    first.setText("stale");
    assert.equal(
        getStatusBarSnapshot().segments.find((segment) => segment.id === "example.status")?.text,
        "replacement",
    );

    replacement.clear();
    assert.equal(
        getStatusBarSnapshot().segments.find((segment) => segment.id === "example.status"),
        undefined,
    );

    second.dispose();
    assert.deepEqual(getStatusBarSnapshot().segments, []);
});

test("registerStatusBarSegment rejects unnamespaced ids", () => {
    assert.throws(
        () => registerStatusBarSegment({ id: "status", text: "bad" }),
        /must be namespaced/,
    );
});
