import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { RenderCountingTui } from "./tui-fixture.ts";

import { configureStatusBar, resetStatusBarStateForTests } from "../src/status-bar-api.ts";
import {
    clearWorkedForWidget,
    formatDuration,
    getWorkedForStateFromBranch,
    resetWorkedForWidgetCache,
    setWorkedForWidget,
    WIDGET_KEY,
    WORKED_FOR_STATE_ENTRY,
    type WorkedForWidgetContext,
} from "../src/worked-for-widget.ts";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

beforeEach(() => {
    resetStatusBarStateForTests();
    resetWorkedForWidgetCache();
});

function stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, "");
}

type StoredWidget = Parameters<WorkedForWidgetContext["ui"]["setWidget"]>[1];
type WidgetHarness = {
    readonly ctx: WorkedForWidgetContext;
    readonly currentWidget: () => StoredWidget;
    readonly updateCount: () => number;
};
type CustomEntryData = CustomEntry["data"];

function customEntry(id: string, data: CustomEntryData): SessionEntry {
    return {
        type: "custom",
        id,
        parentId: null,
        timestamp: "2026-07-13T00:00:00.000Z",
        customType: WORKED_FOR_STATE_ENTRY,
        data,
    };
}

function widgetContext(): WidgetHarness {
    let widget: StoredWidget;
    let updates = 0;
    const ctx = {
        hasUI: true,
        ui: {
            setWidget(
                key: Parameters<WorkedForWidgetContext["ui"]["setWidget"]>[0],
                nextWidget: Parameters<WorkedForWidgetContext["ui"]["setWidget"]>[1],
            ) {
                assert.equal(key, WIDGET_KEY);
                widget = nextWidget;
                updates += 1;
            },
        },
    } satisfies WorkedForWidgetContext;

    return {
        ctx,
        currentWidget() {
            return widget;
        },
        updateCount() {
            return updates;
        },
    };
}

test("formatDuration rounds to seconds and uses readable minute/hour boundaries", () => {
    assert.equal(formatDuration(-10), "0s");
    assert.equal(formatDuration(1_400), "1s");
    assert.equal(formatDuration(65_000), "1m 05s");
    assert.equal(formatDuration(3_660_000), "1h 01m");
});

test("getWorkedForStateFromBranch restores the latest valid persisted run", () => {
    const entries: SessionEntry[] = [
        customEntry("first", { durationMs: 1_400, tokensPerSecond: 12 }),
        customEntry("second", { durationMs: 65_000 }),
    ];

    const ctx = {
        sessionManager: {
            getBranch: () => entries,
        },
    } satisfies Parameters<typeof getWorkedForStateFromBranch>[0];

    assert.deepEqual(getWorkedForStateFromBranch(ctx), { durationMs: 65_000 });
});

test("getWorkedForStateFromBranch ignores malformed persisted data", () => {
    const entries: SessionEntry[] = [
        customEntry("valid", { durationMs: 1_400, tokensPerSecond: 12 }),
        customEntry("invalid", { durationMs: -1 }),
    ];

    const ctx = {
        sessionManager: {
            getBranch: () => entries,
        },
    } satisfies Parameters<typeof getWorkedForStateFromBranch>[0];

    assert.deepEqual(getWorkedForStateFromBranch(ctx), {
        durationMs: 1_400,
        tokensPerSecond: 12,
    });
});

test("setWorkedForWidget skips unchanged widget updates", () => {
    const { ctx, updateCount } = widgetContext();

    setWorkedForWidget(ctx, undefined);
    assert.equal(updateCount(), 0);
    setWorkedForWidget(ctx, "10s", 2);
    assert.equal(updateCount(), 1);
    setWorkedForWidget(ctx, "10s", 2);
    assert.equal(updateCount(), 1);
    setWorkedForWidget(ctx, "11s", 2);
    assert.equal(updateCount(), 2);
    setWorkedForWidget(ctx, undefined);
    assert.equal(updateCount(), 3);
    setWorkedForWidget(ctx, undefined);
    assert.equal(updateCount(), 3);
});

test("setWorkedForWidget tracks separate Pi UI contexts independently", () => {
    const first = widgetContext();
    const second = widgetContext();

    setWorkedForWidget(first.ctx, "10s", 2);
    setWorkedForWidget(second.ctx, "10s", 2);
    assert.equal(first.updateCount(), 1);
    assert.equal(second.updateCount(), 1);
});

test("setWorkedForWidget renders duration and token rate within the provided width", () => {
    const { ctx, currentWidget } = widgetContext();
    setWorkedForWidget(ctx, "1m 05s", 42.25);

    const widget = currentWidget();
    if (widget === undefined) throw new Error("Expected widget factory");

    const theme = { fg: (_role: string, text: string) => `[dim]${text}` };
    const component = widget(new RenderCountingTui(), theme);
    assert.deepEqual(component.render(80), ["[dim] Worked for 1m 05s. [42.3 tok/s]"]);
    const narrowLine = component.render(12)[0] ?? "";
    assert.equal(stripAnsi(narrowLine), "[dim] Worked for ");
    assert.deepEqual(component.render(0), [""]);
});

test("setWorkedForWidget renders idle status bar overrides with the last-run summary", () => {
    configureStatusBar({
        idle: {
            text: "Ready",
            showLastRunSummary: true,
        },
    });
    const { ctx, currentWidget } = widgetContext();

    setWorkedForWidget(ctx, "9s", 3);

    const widget = currentWidget();
    if (widget === undefined) throw new Error("Expected widget factory");

    const theme = { fg: (_role: string, text: string) => `[dim]${text}` };
    const component = widget(new RenderCountingTui(), theme);
    assert.deepEqual(component.render(80), ["[dim] Ready · Worked for 9s. [3.0 tok/s]"]);
});

test("setWorkedForWidget can hide token throughput without hiding duration", () => {
    configureStatusBar({
        idle: {
            showLastRunSummary: true,
            showTokensPerSecond: false,
        },
    });
    const { ctx, currentWidget } = widgetContext();

    setWorkedForWidget(ctx, "9s", 3);

    const widget = currentWidget();
    if (widget === undefined) throw new Error("Expected widget factory");

    const theme = { fg: (_role: string, text: string) => `[dim]${text}` };
    const component = widget(new RenderCountingTui(), theme);
    assert.deepEqual(component.render(80), ["[dim] Worked for 9s."]);
});

test("clearWorkedForWidget removes configured idle status during active runs", () => {
    configureStatusBar({
        idle: {
            text: "Ready",
            showLastRunSummary: true,
        },
    });
    const { ctx, currentWidget, updateCount } = widgetContext();

    setWorkedForWidget(ctx, undefined);
    assert.notEqual(currentWidget(), undefined);
    assert.equal(updateCount(), 1);
    clearWorkedForWidget(ctx);
    assert.equal(currentWidget(), undefined);
    assert.equal(updateCount(), 2);
});
