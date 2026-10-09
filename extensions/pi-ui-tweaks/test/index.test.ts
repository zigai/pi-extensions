import assert from "node:assert/strict";
import { type SessionShutdownEvent, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { SelectList } from "@earendil-works/pi-tui";
import { test } from "vitest";

import {
    registerUiTweaksLifecycle,
    type UiTweaksExtensionApi,
    type UiTweaksLifecycleContext,
} from "../src/index.ts";
import { captureConsoleWarnings } from "./capture-console-warnings.ts";

type SelectListPrototypeFixture = {
    readonly render?: (width: number) => string[];
};

type LifecycleHandler = (
    event: SessionStartEvent | SessionShutdownEvent,
    ctx: UiTweaksLifecycleContext,
) => void | Promise<void>;

function registerLifecycleHandlers(): Map<string, LifecycleHandler> {
    const handlers = new Map<string, LifecycleHandler>();
    const api: UiTweaksExtensionApi = {
        onSessionStart(handler): void {
            handlers.set("session_start", handler);
        },
        onSessionShutdown(handler): void {
            handlers.set("session_shutdown", handler);
        },
    };
    registerUiTweaksLifecycle(api);

    return handlers;
}

function headlessContext(): UiTweaksLifecycleContext {
    return {
        cwd: process.cwd(),
        hasUI: false,
        isProjectTrusted(): boolean {
            return true;
        },
        ui: {
            getEditorComponent() {
                return undefined;
            },
            notify(): void {},
            setEditorComponent(): void {},
            setWidget(): void {},
        },
    };
}

const sessionStart: SessionStartEvent = { type: "session_start", reason: "startup" };
const sessionShutdown: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
const selectListPrototype: SelectListPrototypeFixture = SelectList.prototype;

test("composition root registers session lifecycle handlers", () => {
    const handlers = registerLifecycleHandlers();
    assert.equal(handlers.has("session_start"), true);
    assert.equal(handlers.has("session_shutdown"), true);
});

test("session shutdown disposes installed patches and a later start installs once again", async () => {
    const warnings = await captureConsoleWarnings(async () => {
        const handlers = registerLifecycleHandlers();
        const start = handlers.get("session_start");
        const shutdown = handlers.get("session_shutdown");
        assert.ok(start);
        assert.ok(shutdown);
        const context = headlessContext();
        const originalRender = selectListPrototype.render;

        await start(sessionStart, context);
        const firstPatchedRender = selectListPrototype.render;
        assert.notEqual(firstPatchedRender, originalRender);
        await start(sessionStart, context);
        assert.equal(selectListPrototype.render, firstPatchedRender);
        await shutdown(sessionShutdown, context);
        assert.equal(selectListPrototype.render, originalRender);
        await start(sessionStart, context);
        assert.notEqual(selectListPrototype.render, originalRender);
        await shutdown(sessionShutdown, context);
        assert.equal(selectListPrototype.render, originalRender);
    });

    assert.deepEqual(warnings, []);
});
